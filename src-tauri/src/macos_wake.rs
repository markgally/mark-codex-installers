use super::*;

fn wake_helper_path(app: &AppHandle) -> Result<PathBuf, String> {
    let relative = PathBuf::from("wake-helper/JarvisWakeListener.app");
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join(&relative);
        if bundled.exists() {
            return Ok(bundled);
        }
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative);
    if development.exists() {
        return Ok(development);
    }
    Err("Jarvis wake listener not found".to_owned())
}

fn host_app_bundle_path(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let contents_dir = resource_dir.parent()?;
    let bundle = contents_dir.parent()?;
    (bundle.extension().and_then(|value| value.to_str()) == Some("app"))
        .then(|| bundle.to_path_buf())
}

pub(super) fn start(app: AppHandle) {
    let state = app.state::<AppState>();
    if state.quitting.load(Ordering::SeqCst) { return; }
    if state.wake_supervisor_running.swap(true, Ordering::SeqCst) {
        return;
    }
    state.wake_enabled.store(true, Ordering::SeqCst);

    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let helper = match wake_helper_path(&app) {
            Ok(path) => path,
            Err(error) => {
                *state.wake_authorization.write().await = error.clone();
                state.wake_enabled.store(false, Ordering::SeqCst);
                state.wake_supervisor_running.store(false, Ordering::SeqCst);
                let _ = app.emit("jarvis-wake-status", wake_status_value(&state).await);
                return;
            }
        };
        // A previous host may have exited while its LaunchServices helper
        // remained alive. Keep exactly one microphone listener.
        let _ = Command::new("/usr/bin/pkill")
            .args(["-x", "JarvisWakeListener"])
            .status()
            .await;

        let mut woke = false;
        while state.wake_enabled.load(Ordering::SeqCst) {
            state.wake_ready.store(false, Ordering::SeqCst);
            let event_file =
                std::env::temp_dir().join(format!("jarvis-wake-{}.jsonl", std::process::id()));
            let _ = fs::remove_file(&event_file);
            if let Err(error) = fs::write(&event_file, "") {
                *state.wake_authorization.write().await =
                    format!("Could not create wake event channel: {error}");
                break;
            }
            if !state.wake_enabled.load(Ordering::SeqCst) {
                let _ = fs::remove_file(&event_file);
                break;
            }

            // LaunchServices is required so macOS attributes microphone and
            // speech-recognition permissions to the helper app bundle.
            let mut command = Command::new("/usr/bin/open");
            command
                .args(["-n", "-W"])
                .arg(&helper)
                .args(["--args", "--event-file"])
                .arg(&event_file)
                .arg("--assistant-name")
                .arg(assistant_name(&state));
            if let Some(host_app) = host_app_bundle_path(&app) {
                command.arg("--host-app").arg(host_app);
            }
            let mut child = match command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
            {
                Ok(child) => child,
                Err(error) => {
                    *state.wake_authorization.write().await =
                        format!("Could not start wake listener: {error}");
                    break;
                }
            };
            state
                .wake_pid
                .store(child.id().unwrap_or(0), Ordering::SeqCst);
            let mut processed = 0usize;

            loop {
                let content = fs::read_to_string(&event_file).unwrap_or_default();
                let lines: Vec<&str> = content.lines().collect();
                for line in lines.iter().skip(processed) {
                    let Ok(message) = serde_json::from_str::<Value>(line) else {
                        continue;
                    };
                    match message.get("type").and_then(Value::as_str) {
                        Some("authorization") => {
                            let authorization = message
                                .get("status")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown");
                            *state.wake_authorization.write().await = authorization.to_owned();
                            // `notDetermined` means the helper has just asked
                            // macOS for access. Keep it alive so the native
                            // permission sheet can complete its callback.
                            if matches!(authorization, "denied" | "restricted") {
                                state.wake_enabled.store(false, Ordering::SeqCst);
                            }
                        }
                        Some("microphone-authorization") => {
                            let authorization = message
                                .get("status")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown");
                            if authorization == "authorized" {
                                *state.wake_authorization.write().await = "authorized".to_owned();
                            } else {
                                *state.wake_authorization.write().await =
                                    format!("Microphone: {authorization}");
                                state.wake_ready.store(false, Ordering::SeqCst);
                            }
                            if matches!(authorization, "denied" | "restricted") {
                                state.wake_enabled.store(false, Ordering::SeqCst);
                            }
                        }
                        Some("ready") => {
                            state.wake_ready.store(true, Ordering::SeqCst);
                        }
                        Some("wake") => {
                            woke = true;
                            state.wake_enabled.store(false, Ordering::SeqCst);
                            state.wake_ready.store(false, Ordering::SeqCst);
                            raise_jarvis_window(&app);
                        }
                        Some("error") => {
                            state.wake_ready.store(false, Ordering::SeqCst);
                            *state.wake_authorization.write().await = message
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("wake listener error")
                                .to_owned();
                        }
                        _ => {}
                    }
                    let _ = app.emit("jarvis-wake-status", wake_status_value(&state).await);
                    if woke {
                        break;
                    }
                }
                processed = lines.len();
                if woke || !state.wake_enabled.load(Ordering::SeqCst) {
                    break;
                }
                if child.try_wait().ok().flatten().is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }

            if woke || !state.wake_enabled.load(Ordering::SeqCst) {
                let _ = Command::new("/usr/bin/pkill")
                    .args(["-x", "JarvisWakeListener"])
                    .status()
                    .await;
            }
            let _ = child.wait().await;
            let _ = fs::remove_file(&event_file);
            state.wake_pid.store(0, Ordering::SeqCst);
            if woke || !state.wake_enabled.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }

        state.wake_ready.store(false, Ordering::SeqCst);
        state.wake_supervisor_running.store(false, Ordering::SeqCst);
        if woke {
            // The WebView owns the RTCPeerConnection, so wake only raises the
            // Jarvis surface and asks the renderer to begin the official Codex
            // app-server V3 Voice handshake. No keypress or UI automation.
            let _ = app.emit("jarvis-wake", json!({"ok": true}));
        }
        let _ = app.emit("jarvis-wake-status", wake_status_value(&state).await);
    });
}
