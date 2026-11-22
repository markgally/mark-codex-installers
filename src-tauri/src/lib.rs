use serde::{Deserialize, Serialize};
mod claude_code;
mod google_workspace;
mod identity;
mod conversation_context;
mod memory_store;
mod summary_rpc;
mod context_manager;
#[cfg(target_os = "macos")]
mod macos_wake;
mod platform;
mod window_controls;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc, RwLock as StdRwLock,
    },
};

const ENGLISH_DEFAULT_INSTRUCTIONS: &str = "Respond in English by default in both speech and text. Do not switch languages based on accent, greetings, or isolated foreign words. Only use another language if the user explicitly asks for it.";
const DEFAULT_ASSISTANT_NAME: &str = "Mark";

fn valid_assistant_name(name: &str) -> bool {
    (2..=20).contains(&name.len()) && name.bytes().all(|byte| byte.is_ascii_alphabetic())
}

fn valid_codex_model(model: &str) -> bool {
    (1..=80).contains(&model.len())
        && model.as_bytes()[0].is_ascii_alphanumeric()
        && model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn codex_model_ids(response: &Value) -> Result<Vec<String>, String> {
    let models = response
        .get("data")
        .and_then(Value::as_array)
        .ok_or("Codex did not return a model catalog")?;
    Ok(models
        .iter()
        .filter(|model| model.get("hidden").and_then(Value::as_bool) != Some(true))
        .filter_map(|model| model.get("model").and_then(Value::as_str))
        .filter(|model| valid_codex_model(model))
        .map(str::to_owned)
        .collect())
}

fn assistant_profile(state: &AppState) -> identity::AssistantProfile {
    state.assistant_profile.read().expect("assistant profile lock poisoned").clone()
}

fn assistant_name(state: &AppState) -> String {
    assistant_profile(state).assistant_name
}

fn assistant_instructions(state: &AppState) -> String {
    assistant_profile(state).instructions()
}

fn assistant_profile_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir()
        .map(|directory| directory.join("assistant-profile.json"))
        .map_err(|error| format!("Could not locate assistant settings: {error}"))
}

#[tauri::command]
fn get_assistant_profile(state: State<'_, AppState>) -> identity::AssistantProfile {
    assistant_profile(&state)
}

#[tauri::command]
fn set_assistant_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: identity::AssistantProfile,
) -> Result<identity::AssistantProfile, String> {
    let profile = identity::save(&assistant_profile_path(&app)?, profile)?;
    *state.assistant_profile.write().expect("assistant profile lock poisoned") = profile.clone();
    Ok(profile)
}

fn assistant_name_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("assistant-name.txt"))
        .map_err(|error| format!("Could not locate assistant settings: {error}"))
}

#[tauri::command]
fn get_assistant_name(state: State<'_, AppState>) -> String {
    assistant_name(&state)
}

#[tauri::command]
fn set_assistant_name(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<String, String> {
    let name = name.trim();
    if !valid_assistant_name(name) {
        return Err("Use a name of 2–20 English letters, without spaces.".to_owned());
    }
    let mut profile = assistant_profile(&state);
    profile.assistant_name = name.to_owned();
    set_assistant_profile(app, state, profile).map(|saved| saved.assistant_name)
}

fn openai_api_key() -> Result<String, String> {
    if let Ok(key) = std::env::var("OPENAI_API_KEY") {
        if !key.trim().is_empty() {
            return Ok(key);
        }
    }

    let home = std::env::var("HOME").map_err(|_| "OPENAI_API_KEY is not configured".to_owned())?;
    let zshrc = fs::read_to_string(PathBuf::from(home).join(".zshrc"))
        .map_err(|_| "OPENAI_API_KEY is not configured".to_owned())?;
    zshrc
        .lines()
        .find_map(|line| {
            let line = line.trim();
            let value = line.strip_prefix("export OPENAI_API_KEY=")?.trim();
            let value = value.trim_matches(|c| c == '"' || c == '\'');
            (!value.is_empty()).then(|| value.to_owned())
        })
        .ok_or_else(|| "OPENAI_API_KEY is not configured".to_owned())
}

fn anthropic_api_key() -> Result<String, String> {
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
        if !key.trim().is_empty() {
            return Ok(key);
        }
    }
    let home =
        std::env::var("HOME").map_err(|_| "ANTHROPIC_API_KEY is not configured".to_owned())?;
    let zshrc = fs::read_to_string(PathBuf::from(home).join(".zshrc"))
        .map_err(|_| "ANTHROPIC_API_KEY is not configured".to_owned())?;
    zshrc
        .lines()
        .find_map(|line| {
            let value = line
                .trim()
                .strip_prefix("export ANTHROPIC_API_KEY=")?
                .trim();
            let value = value.trim_matches(|c| c == '"' || c == '\'');
            (!value.is_empty()).then(|| value.to_owned())
        })
        .ok_or_else(|| "ANTHROPIC_API_KEY is not configured".to_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeConfiguration {
    anthropic_key: bool,
    openai_key: bool,
    claude_code_installed: bool,
    claude_code_authenticated: bool,
}

#[tauri::command]
fn claude_configuration() -> ClaudeConfiguration {
    let cli = claude_code::status();
    ClaudeConfiguration {
        anthropic_key: anthropic_api_key().is_ok(),
        openai_key: openai_api_key().is_ok(),
        claude_code_installed: cli.installed,
        claude_code_authenticated: cli.authenticated,
    }
}

#[tauri::command]
fn google_workspace_status() -> google_workspace::GoogleWorkspaceStatus {
    google_workspace::status()
}

fn openai_response_text(value: &Value) -> Option<&str> {
    value
        .get("output")
        .and_then(Value::as_array)?
        .iter()
        .flat_map(|item| {
            item.get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .find_map(|part| part.get("text").and_then(Value::as_str))
}

#[cfg(test)]
mod openai_response_tests {
    use super::*;

    #[test]
    fn assistant_names_are_safe_for_wake_phrases() {
        assert!(valid_assistant_name("Mark"));
        assert!(!valid_assistant_name("M"));
        assert!(!valid_assistant_name("Mark Smith"));
        assert!(!valid_assistant_name("Mark\nIgnoreInstructions"));
    }

    #[test]
    fn wake_requires_recognized_phrase_and_word_evidence() {
        let mut message = json!({"phrase":"hey Zee", "grammar":"wake-phrase", "confidence":0.9,
            "wordConfidences":[0.9, 0.9], "duration":0.7});
        assert_eq!(validated_wake_phrase(&message, "Zee"), Some("hey Zee"));
        assert_eq!(validated_wake_phrase(&message, "Mark"), None);
        message["phrase"] = json!("hi Zee");
        assert_eq!(validated_wake_phrase(&message, "Zee"), Some("hi Zee"));
        message["confidence"] = json!(0.7);
        assert_eq!(validated_wake_phrase(&message, "Zee"), None);
        message["confidence"] = json!(0.9);
        message["wordConfidences"] = json!([0.9, 0.4]);
        assert_eq!(validated_wake_phrase(&message, "Zee"), None);
        message["wordConfidences"] = json!([0.9, 0.9]);
        message["grammar"] = json!("background-speech");
        assert_eq!(validated_wake_phrase(&message, "Zee"), None);
        assert_eq!(validated_wake_phrase(&json!({"type":"wake"}), "Zee"), None);
    }

    #[test]
    fn codex_catalog_uses_model_slugs_and_skips_hidden_entries() {
        let response = json!({"data": [
            {"id": "alias", "model": "gpt-6-sol", "hidden": false},
            {"id": "hidden", "model": "gpt-5.5", "hidden": true},
            {"id": "bad", "model": "unsafe\nmodel", "hidden": false}
        ]});
        assert_eq!(codex_model_ids(&response).unwrap(), vec!["gpt-6-sol"]);
        assert!(!valid_codex_model("../model"));
    }

    #[test]
    fn skips_empty_reasoning_and_reads_later_message() {
        let response = json!({"output": [
            {"type": "reasoning", "content": []},
            {"type": "message", "content": [{"type": "output_text", "text": "OK"}]}
        ]});
        assert_eq!(openai_response_text(&response), Some("OK"));
    }
}
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex, RwLock},
    time::{timeout, Duration},
};

struct AppState {
    assistant_profile: StdRwLock<identity::AssistantProfile>,
    claude_history: Mutex<Vec<Value>>,
    claude_epoch: AtomicU64,
    claude_code: claude_code::ClaudeCodeRuntime,
    runtime: Mutex<Option<Arc<CodexRuntime>>>,
    cold_wake_pending: AtomicBool,
    background_start: bool,
    quitting: AtomicBool,
    wake_enabled: AtomicBool,
    wake_ready: AtomicBool,
    wake_supervisor_running: AtomicBool,
    wake_pid: AtomicU32,
    wake_authorization: RwLock<String>,
}

#[tauri::command]
async fn reset_claude_conversation(state: State<'_, AppState>) -> Result<(), String> {
    state.claude_epoch.fetch_add(1, Ordering::SeqCst);
    state.claude_code.interrupt().await;
    state.claude_history.lock().await.clear();
    Ok(())
}

#[tauri::command]
async fn interrupt_claude(state: State<'_, AppState>) -> Result<(), String> {
    state.claude_epoch.fetch_add(1, Ordering::SeqCst);
    state.claude_code.interrupt().await;
    Ok(())
}

#[tauri::command]
async fn send_claude_code(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    model: String,
    cwd: String,
    session_id: Option<String>,
    permission_mode: PermissionMode,
    request_id: String,
) -> Result<claude_code::ClaudeCodeTurn, String> {
    const MODELS: &[&str] = &["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"];
    if !MODELS.contains(&model.as_str()) {
        return Err(format!("Unsupported Claude model: {model}"));
    }
    if text.trim().is_empty() {
        return Err("Claude Code request is empty".to_owned());
    }
    let cwd = validated_workspace(&cwd)?;
    let permission = match permission_mode {
        PermissionMode::Safe => "safe",
        PermissionMode::Auto => "auto",
        PermissionMode::Full => "full",
    };
    state
        .claude_code
        .run(
            &app,
            &request_id,
            &cwd,
            &text,
            &model,
            permission,
            &assistant_name(&state),
            &assistant_instructions(&state),
            session_id.as_deref(),
        )
        .await
}

#[tauri::command]
async fn send_claude_text(
    state: State<'_, AppState>,
    text: String,
    model: String,
) -> Result<String, String> {
    const MODELS: &[&str] = &["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"];
    if !MODELS.contains(&model.as_str()) {
        return Err(format!("Unsupported Claude model: {model}"));
    }
    let key = anthropic_api_key()?;
    let epoch = state.claude_epoch.load(Ordering::SeqCst);
    let mut history = state.claude_history.lock().await;
    let mut messages = history.clone();
    messages.push(json!({"role":"user","content":text}));
    let system = format!(
        "{} Keep spoken replies concise.",
        assistant_instructions(&state)
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| format!("Claude client setup failed: {error}"))?;
    let reply = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(
            json!({"model":model,"max_tokens":2048,"system":system,"messages":messages})
                .to_string(),
        )
        .send()
        .await
        .map_err(|error| format!("Claude connection failed: {error}"))?;
    let status = reply.status();
    let body = reply
        .text()
        .await
        .map_err(|error| format!("Claude response failed: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "Claude API returned {status}: {}",
            body.chars().take(400).collect::<String>()
        ));
    }
    let value: Value =
        serde_json::from_str(&body).map_err(|error| format!("Invalid Claude response: {error}"))?;
    let answer = value
        .get("content")
        .and_then(Value::as_array)
        .ok_or("Claude response contained no content")?
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    if answer.is_empty() {
        return Err("Claude response contained no text".to_owned());
    }
    if epoch != state.claude_epoch.load(Ordering::SeqCst) {
        return Err("Claude response interrupted".to_owned());
    }
    messages.push(json!({"role":"assistant","content":answer}));
    // Bound local history so long-running voice use does not resend every prior turn.
    if messages.len() > 24 {
        messages.drain(..messages.len() - 24);
    }
    *history = messages;
    Ok(answer)
}

#[tauri::command]
async fn transcribe_claude_audio(audio: Vec<u8>, mime_type: String) -> Result<String, String> {
    if audio.is_empty() || audio.len() > 25_000_000 {
        return Err("Recording is empty or too large".to_owned());
    }
    let (extension, content_type) = match mime_type.as_str() {
        "audio/mp4" | "audio/mp4;codecs=mp4a.40.2" => ("m4a", "audio/mp4"),
        "audio/webm" | "audio/webm;codecs=opus" => ("webm", "audio/webm"),
        _ => return Err("Unsupported microphone recording format".to_owned()),
    };
    let key = openai_api_key()?;
    let file = reqwest::multipart::Part::bytes(audio)
        .file_name(format!("speech.{extension}"))
        .mime_str(content_type)
        .map_err(|error| error.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("file", file)
        .text("model", "gpt-transcribe");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| error.to_string())?;
    let reply = client
        .post("https://api.openai.com/v1/audio/transcriptions")
        .bearer_auth(key)
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("Transcription connection failed: {error}"))?;
    let status = reply.status();
    let body = reply.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "Transcription returned {status}: {}",
            body.chars().take(400).collect::<String>()
        ));
    }
    let value: Value = serde_json::from_str(&body).map_err(|error| error.to_string())?;
    Ok(value
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned())
}

#[tauri::command]
async fn speak_claude_text(text: String, voice: String) -> Result<Vec<u8>, String> {
    const VOICES: &[&str] = &[
        "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer",
        "verse", "marin", "cedar",
    ];
    if !VOICES.contains(&voice.as_str()) {
        return Err(format!("Unsupported speech voice: {voice}"));
    }
    let key = openai_api_key()?;
    let input: String = text.chars().take(4096).collect();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| error.to_string())?;
    let reply = client
        .post("https://api.openai.com/v1/audio/speech")
        .bearer_auth(key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(
            json!({"model":"gpt-4o-mini-tts","voice":voice,"input":input,"response_format":"mp3"})
                .to_string(),
        )
        .send()
        .await
        .map_err(|error| format!("Speech connection failed: {error}"))?;
    let status = reply.status();
    if !status.is_success() {
        let body = reply.text().await.unwrap_or_default();
        return Err(format!(
            "Speech API returned {status}: {}",
            body.chars().take(400).collect::<String>()
        ));
    }
    reply
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn startup_is_background(state: State<'_, AppState>) -> bool {
    state.background_start
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn request_microphone_permission() -> Result<String, String> {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    use std::sync::Mutex as StdMutex;

    let media_type = unsafe { AVMediaTypeAudio }
        .ok_or_else(|| "macOS did not provide the audio authorization type".to_owned())?;
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };
    match status {
        AVAuthorizationStatus::Authorized => return Ok("authorized".to_owned()),
        AVAuthorizationStatus::Denied => return Ok("denied".to_owned()),
        AVAuthorizationStatus::Restricted => return Ok("restricted".to_owned()),
        _ => {}
    }

    let (sender, receiver) = oneshot::channel::<bool>();
    let sender = Arc::new(StdMutex::new(Some(sender)));
    {
        let completion_sender = sender.clone();
        let completion = RcBlock::new(move |granted: Bool| {
            if let Ok(mut guard) = completion_sender.lock() {
                if let Some(sender) = guard.take() {
                    let _ = sender.send(granted.as_bool());
                }
            }
        });
        unsafe {
            AVCaptureDevice::requestAccessForMediaType_completionHandler(media_type, &completion);
        }
    }
    let granted = receiver
        .await
        .map_err(|_| "macOS microphone authorization was interrupted".to_owned())?;
    Ok(if granted { "authorized" } else { "denied" }.to_owned())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn request_microphone_permission() -> Result<String, String> {
    Ok("authorized".to_owned())
}

struct CodexRuntime {
    memory: context_manager::ContextManager,
    writer: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    thread_id: RwLock<Option<String>>,
    active_turn: RwLock<Option<String>>,
    voice_active: AtomicBool,
    voice_phase: RwLock<String>,
    realtime_session_id: RwLock<Option<String>>,
    permission_mode: PermissionMode,
    workspace: String,
    model: Option<String>,
    assistant_profile: identity::AssistantProfile,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum PermissionMode {
    Safe,
    Auto,
    Full,
}

struct PermissionProfile {
    approval_policy: &'static str,
    sandbox: &'static str,
    instructions: &'static str,
}

impl PermissionMode {
    fn profile(self) -> PermissionProfile {
        match self {
            Self::Safe => PermissionProfile {
                approval_policy: "on-request",
                sandbox: "workspace-write",
                instructions: "Require explicit confirmation when Codex requests approval for actions outside the workspace boundary or for risky operations.",
            },
            Self::Auto => PermissionProfile {
                approval_policy: "never",
                sandbox: "workspace-write",
                instructions: "Work autonomously inside the selected workspace. Never request elevated access; if an action is blocked by the sandbox, explain the blocked boundary and continue with the safest in-workspace alternative.",
            },
            Self::Full => PermissionProfile {
                approval_policy: "never",
                sandbox: "danger-full-access",
                instructions: "Full filesystem and network access is enabled. Still avoid destructive or irreversible actions unless the user explicitly requested the exact action and target.",
            },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    thread_id: String,
    cwd: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectVoiceInfo {
    codex_connected: bool,
    voice_active: bool,
    phase: String,
    protocol: &'static str,
    thread_id: Option<String>,
    realtime_session_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WakeStatus {
    enabled: bool,
    ready: bool,
    authorization: String,
}

fn raise_jarvis_window(app: &AppHandle) {
    let app_handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        {
            use objc2::MainThreadMarker;
            use objc2_app_kit::NSApplication;

            if let Some(mtm) = MainThreadMarker::new() {
                let application = NSApplication::sharedApplication(mtm);
                #[allow(deprecated)]
                application.activateIgnoringOtherApps(true);
            }
        }

        if let Some(window) = app_handle.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            // A short floating interval lets macOS finish switching the
            // active application before the window returns to normal level.
            let _ = window.set_always_on_top(true);
            let _ = window.set_focus();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(700)).await;
                let compact = app_handle.state::<window_controls::WindowState>().is_compact();
                let _ = window.set_always_on_top(compact);
            });
        }
    });
}

impl CodexRuntime {
    async fn spawn(
        app: AppHandle,
        permission_mode: PermissionMode,
        workspace: String,
        model: Option<String>,
    ) -> Result<Arc<Self>, String> {
        let codex_binary = codex_binary_path(&app)?;
        let mut command = Command::new(&codex_binary);
        #[cfg(target_os = "windows")]
        command.creation_flags(0x08000000);
        let mut child = command
            // Realtime is an experimental app-server surface. Enable it only
            // for this isolated Jarvis child; never mutate ~/.codex/config.toml.
            .args(["app-server", "--enable", "realtime_conversation", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("Could not start Codex app-server: {error}"))?;
        let writer = child
            .stdin
            .take()
            .ok_or("Could not connect to Codex stdin")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Could not connect to Codex stdout")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("Could not connect to Codex stderr")?;
        let runtime = Arc::new(Self {
            memory: context_manager::ContextManager::new(
                app.path().app_config_dir().map_err(|e| e.to_string())?.join("conversation-memory"),
                codex_binary.clone(),
            ),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            thread_id: RwLock::new(None),
            active_turn: RwLock::new(None),
            voice_active: AtomicBool::new(false),
            voice_phase: RwLock::new("standby".to_owned()),
            realtime_session_id: RwLock::new(None),
            permission_mode,
            workspace,
            model,
            assistant_profile: assistant_profile(&app.state::<AppState>()),
        });

        let weak = Arc::downgrade(&runtime);
        let event_app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                eprintln!(
                    "codex rpc: id={} method={}",
                    message
                        .get("id")
                        .map(Value::to_string)
                        .unwrap_or_else(|| "-".to_owned()),
                    message.get("method").and_then(Value::as_str).unwrap_or("-")
                );
                if message.get("method").is_none() {
                    if let Some(id) = message.get("id").and_then(Value::as_u64) {
                        if let Some(runtime) = weak.upgrade() {
                            if let Some(sender) = runtime.pending.lock().await.remove(&id) {
                                let result = if let Some(error) = message.get("error") {
                                    Err(error
                                        .get("message")
                                        .and_then(Value::as_str)
                                        .unwrap_or("Codex request failed")
                                        .to_owned())
                                } else {
                                    Ok(message.get("result").cloned().unwrap_or(Value::Null))
                                };
                                let _ = sender.send(result);
                            }
                        }
                    }
                    continue;
                }
                let mut suppress = false;
                if let Some(runtime) = weak.upgrade() {
                    suppress = runtime.memory.observe(&message).await;
                    match message.get("method").and_then(Value::as_str) {
                        Some("turn/started") => {
                            *runtime.active_turn.write().await = message
                                .pointer("/params/turn/id")
                                .and_then(Value::as_str)
                                .map(str::to_owned);
                        }
                        Some("turn/completed") => *runtime.active_turn.write().await = None,
                        Some("thread/realtime/started") => {
                            runtime.voice_active.store(true, Ordering::SeqCst);
                            *runtime.voice_phase.write().await = "connected".to_owned();
                            *runtime.realtime_session_id.write().await = message
                                .pointer("/params/realtimeSessionId")
                                .and_then(Value::as_str)
                                .map(str::to_owned);
                        }
                        Some("thread/realtime/error") => {
                            runtime.voice_active.store(false, Ordering::SeqCst);
                            *runtime.voice_phase.write().await = "error".to_owned();
                        }
                        Some("thread/realtime/closed") => {
                            runtime.voice_active.store(false, Ordering::SeqCst);
                            *runtime.voice_phase.write().await = "closed".to_owned();
                            *runtime.realtime_session_id.write().await = None;
                        }
                        _ => {}
                    }
                }
                if !suppress { let _ = event_app.emit("codex-event", message); }
            }
        });
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("codex stderr: {line}");
                if line.contains("ERROR") {
                    let _ = app.emit("codex-diagnostic", line);
                }
            }
        });
        Ok(runtime)
    }

    async fn write(&self, message: &Value) -> Result<(), String> {
        let mut payload = serde_json::to_vec(message).map_err(|error| error.to_string())?;
        payload.push(b'\n');
        let mut writer = self.writer.lock().await;
        writer
            .write_all(&payload)
            .await
            .map_err(|error| error.to_string())?;
        writer.flush().await.map_err(|error| error.to_string())
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        if let Err(error) = self
            .write(&json!({"id": id, "method": method, "params": params}))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        timeout(Duration::from_secs(90), receiver)
            .await
            .map_err(|_| format!("{method} response timed out"))?
            .map_err(|_| format!("{method} response channel closed"))?
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write(&json!({"method": method, "params": params}))
            .await
    }

    async fn thread(&self) -> Result<String, String> {
        self.thread_id
            .read()
            .await
            .clone()
            .ok_or("Jarvis is not connected to a Codex thread".to_owned())
    }
}

fn codex_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(configured) = std::env::var("JARVIS_CODEX_BIN") {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return Ok(path);
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("codex");
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("bin/codex.exe");
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    platform::executable("codex", "JARVIS_CODEX_BIN").ok_or_else(|| {
        "Codex executable not found. Install Codex or set JARVIS_CODEX_BIN.".to_owned()
    })
}

async fn runtime(state: &State<'_, AppState>) -> Result<Arc<CodexRuntime>, String> {
    state
        .runtime
        .lock()
        .await
        .clone()
        .ok_or("Jarvis runtime has not started".to_owned())
}

async fn direct_voice_info(state: &State<'_, AppState>) -> DirectVoiceInfo {
    let runtime = state.runtime.lock().await.clone();
    let Some(runtime) = runtime else {
        return DirectVoiceInfo {
            codex_connected: false,
            voice_active: false,
            phase: "standby".to_owned(),
            protocol: "Codex app-server V3 · WebRTC",
            thread_id: None,
            realtime_session_id: None,
        };
    };
    let phase = runtime.voice_phase.read().await.clone();
    let thread_id = runtime.thread_id.read().await.clone();
    let realtime_session_id = runtime.realtime_session_id.read().await.clone();
    DirectVoiceInfo {
        codex_connected: true,
        voice_active: runtime.voice_active.load(Ordering::SeqCst),
        phase,
        protocol: "Codex app-server V3 · WebRTC",
        thread_id,
        realtime_session_id,
    }
}

#[tauri::command]
async fn direct_voice_status(state: State<'_, AppState>) -> Result<DirectVoiceInfo, String> {
    Ok(direct_voice_info(&state).await)
}

#[cfg(target_os = "windows")]
fn wake_helper_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let path = resource_dir.join("wake-helper/windows-wake.ps1");
        if path.is_file() {
            return Ok(path);
        }
    }
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("wake-helper/windows-wake.ps1");
    if path.is_file() {
        return Ok(path);
    }
    Err("Windows wake listener was not found. Extract the entire ZIP before launching.".to_owned())
}

async fn stop_wake_process(pid: u32) {
    #[cfg(target_os = "windows")]
    if pid > 0 {
        let _ = Command::new("taskkill.exe")
            .creation_flags(0x08000000)
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    #[cfg(target_os = "macos")]
    {
        if pid > 0 {
            let _ = Command::new("/bin/kill")
                .arg(pid.to_string())
                .status()
                .await;
        }
        let _ = Command::new("/usr/bin/pkill")
            .args(["-x", "JarvisWakeListener"])
            .status()
            .await;
    }
}

async fn wake_status_value(state: &AppState) -> WakeStatus {
    WakeStatus {
        enabled: state.wake_enabled.load(Ordering::SeqCst),
        ready: state.wake_ready.load(Ordering::SeqCst),
        authorization: state.wake_authorization.read().await.clone(),
    }
}

fn validated_wake_phrase<'a>(message: &'a Value, name: &str) -> Option<&'a str> {
    let phrase = message.get("phrase")?.as_str()?;
    let normalized = phrase
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    let name = name.to_ascii_lowercase();
    if message.get("grammar")?.as_str()? != "wake-phrase"
        || ![format!("hey {name}"), format!("hi {name}")].contains(&normalized)
        || message.get("confidence")?.as_f64()? < 0.80
    {
        return None;
    }
    let words = message.get("wordConfidences")?.as_array()?;
    let duration = message.get("duration")?.as_f64()?;
    if words.len() != 2
        || !words
            .iter()
            .all(|w| w.as_f64().is_some_and(|c| (0.75..=1.0).contains(&c)))
        || !(0.20..=2.5).contains(&duration)
    {
        return None;
    }
    Some(phrase)
}

#[cfg(target_os = "macos")]
fn start_wake_supervisor(app: AppHandle) {
    if app.state::<AppState>().quitting.load(Ordering::SeqCst) { return; }
    macos_wake::start(app);
}

#[cfg(target_os = "windows")]
fn start_wake_supervisor(app: AppHandle) {
    let state = app.state::<AppState>();
    if state.quitting.load(Ordering::SeqCst) { return; }
    if state.wake_supervisor_running.swap(true, Ordering::SeqCst) {
        return;
    }
    state.wake_enabled.store(true, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let event_file =
            std::env::temp_dir().join(format!("mark-wake-{}.jsonl", std::process::id()));
        let result: Result<Option<String>, String> = async {
            let helper = wake_helper_path(&app)?;
            fs::write(&event_file, "").map_err(|e| e.to_string())?;
            let mut child = Command::new("powershell.exe")
                .creation_flags(0x08000000)
                .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(helper).arg("-EventFile").arg(&event_file)
                .arg("-AssistantName").arg(assistant_name(&state))
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
                .kill_on_drop(true).spawn().map_err(|e| format!("Wake listener: {e}"))?;
            state.wake_pid.store(child.id().unwrap_or(0), Ordering::SeqCst);
            let mut processed = 0;
            let mut woke = None;
            while state.wake_enabled.load(Ordering::SeqCst) {
                let content = fs::read_to_string(&event_file).unwrap_or_default();
                // Only consume complete JSONL records; a concurrent write may be partial.
                let complete = content.rfind('\n').map(|i| &content[..=i]).unwrap_or("");
                let lines: Vec<_> = complete.lines().collect();
                for line in lines.iter().skip(processed) {
                    let Ok(message) = serde_json::from_str::<Value>(line.trim_start_matches('\u{feff}')) else { continue; };
                    match message.get("type").and_then(Value::as_str) {
                        Some("ready") => {
                            state.wake_ready.store(true, Ordering::SeqCst);
                            *state.wake_authorization.write().await = "authorized".into();
                        }
                        Some("wake") => {
                            if let Some(phrase) = validated_wake_phrase(&message, &assistant_name(&state)) {
                                woke = Some(phrase.to_owned());
                                state.wake_enabled.store(false, Ordering::SeqCst);
                            }
                        }
                        Some("error") => {
                            *state.wake_authorization.write().await = message.get("message")
                                .and_then(Value::as_str).unwrap_or("Windows speech unavailable").to_owned();
                            state.wake_enabled.store(false, Ordering::SeqCst);
                        }
                        _ => {}
                    }
                    let _ = app.emit("jarvis-wake-status", wake_status_value(&state).await);
                }
                processed = lines.len();
                if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                    if state.wake_enabled.load(Ordering::SeqCst) {
                        return Err("Windows speech listener exited. Check microphone access and the English speech pack.".into());
                    }
                    break;
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
            Ok(woke)
        }.await;
        state.wake_pid.store(0, Ordering::SeqCst);
        state.wake_enabled.store(false, Ordering::SeqCst);
        state.wake_ready.store(false, Ordering::SeqCst);
        state.wake_supervisor_running.store(false, Ordering::SeqCst);
        let _ = fs::remove_file(&event_file);
        match result {
            Ok(Some(phrase)) => {
                raise_jarvis_window(&app);
                let _ = app.emit("jarvis-wake", json!({"ok": true, "phrase": phrase}));
            }
            Err(error) => {
                *state.wake_authorization.write().await = error;
            }
            _ => {}
        }
        let _ = app.emit("jarvis-wake-status", wake_status_value(&state).await);
    });
}

#[tauri::command]
async fn arm_wake_listener(app: AppHandle) -> Result<WakeStatus, String> {
    start_wake_supervisor(app.clone());
    tokio::time::sleep(Duration::from_millis(80)).await;
    Ok(wake_status_value(&app.state::<AppState>()).await)
}

#[tauri::command]
async fn disarm_wake_listener(app: AppHandle) -> Result<WakeStatus, String> {
    let state = app.state::<AppState>();
    state.wake_enabled.store(false, Ordering::SeqCst);
    state.wake_ready.store(false, Ordering::SeqCst);
    let pid = state.wake_pid.swap(0, Ordering::SeqCst);
    stop_wake_process(pid).await;
    for _ in 0..20 {
        if !state.wake_supervisor_running.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tokio::time::sleep(Duration::from_millis(350)).await;
    Ok(wake_status_value(&state).await)
}

#[tauri::command]
async fn wake_listener_status(app: AppHandle) -> WakeStatus {
    wake_status_value(&app.state::<AppState>()).await
}

#[tauri::command]
async fn consume_cold_wake(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    if !state.cold_wake_pending.swap(false, Ordering::SeqCst) {
        return Ok(false);
    }
    // Replay a cold launch through the same external event path as a normal
    // warm wake, but only after the newly spawned listener fully releases mic.
    state.wake_enabled.store(false, Ordering::SeqCst);
    state.wake_ready.store(false, Ordering::SeqCst);
    let pid = state.wake_pid.swap(0, Ordering::SeqCst);
    stop_wake_process(pid).await;
    for _ in 0..20 {
        if !state.wake_supervisor_running.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tokio::time::sleep(Duration::from_millis(350)).await;
    raise_jarvis_window(&app);
    let _ = app.emit("jarvis-wake", json!({"ok": true, "cold": true}));
    Ok(true)
}

#[tauri::command]
fn default_workspace() -> Result<String, String> {
    if let Ok(configured) = std::env::var("JARVIS_WORKSPACE") {
        let path = PathBuf::from(configured);
        if path.is_dir() {
            return path
                .canonicalize()
                .map(|value| value.to_string_lossy().into_owned())
                .map_err(|error| format!("Could not read JARVIS_WORKSPACE: {error}"));
        }
    }
    if let Some(path) = platform::home_dir() {
        if path.is_dir() {
            return Ok(path.to_string_lossy().into_owned());
        }
    }
    std::env::current_dir()
        .map(|value| value.to_string_lossy().into_owned())
        .map_err(|error| format!("Could not determine the default workspace: {error}"))
}

fn validated_workspace(cwd: &str) -> Result<String, String> {
    let path = PathBuf::from(cwd);
    if !path.is_dir() {
        return Err(format!(
            "Workspace does not exist or is not a folder: {cwd}"
        ));
    }
    path.canonicalize()
        .map(|value| value.to_string_lossy().into_owned())
        .map_err(|error| format!("Could not read workspace: {error}"))
}

async fn terminate_runtime(state: &AppState) -> Result<(), String> {
    if let Some(runtime) = state.runtime.lock().await.take() {
        runtime.memory.stopping.store(true, Ordering::SeqCst);
        runtime.memory.cancel();
        runtime
            .child
            .lock()
            .await
            .kill()
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn list_codex_models(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let existing = { state.runtime.lock().await.clone() };
    let temporary = existing.is_none();
    let runtime = match existing {
        Some(runtime) => runtime,
        None => CodexRuntime::spawn(app, PermissionMode::Safe, String::new(), None).await?,
    };
    let result = timeout(Duration::from_secs(12), async {
        if temporary {
            runtime.request("initialize", json!({
                "clientInfo": {"name": "jarvis-codex", "title": "Mark Codex", "version": env!("CARGO_PKG_VERSION")},
                "capabilities": {"experimentalApi": true}
            })).await?;
            runtime.notify("initialized", json!({})).await?;
        }
        let response = runtime.request("model/list", json!({"limit": 100})).await?;
        codex_model_ids(&response)
    }).await.unwrap_or_else(|_| Err("Codex model catalog timed out".to_owned()));
    if temporary {
        let _ = runtime.child.lock().await.kill().await;
    }
    result
}

async fn ensure_runtime(
    app: AppHandle,
    state: &State<'_, AppState>,
    cwd: &str,
    resume_thread_id: Option<&str>,
    permission_mode: PermissionMode,
    model: Option<&str>,
) -> Result<Arc<CodexRuntime>, String> {
    if let Some(model) = model {
        if !valid_codex_model(model) {
            return Err("Invalid Codex model name".to_owned());
        }
    }
    let cwd = validated_workspace(cwd)?;
    let existing = { state.runtime.lock().await.clone() };
    if let Some(existing) = existing {
        if existing.permission_mode == permission_mode
            && existing.workspace == cwd
            && existing.model.as_deref() == model
            && existing.assistant_profile == assistant_profile(state)
        {
            return Ok(existing);
        }
        terminate_runtime(state).await?;
    }
    let profile = permission_mode.profile();
    let runtime =
        CodexRuntime::spawn(app, permission_mode, cwd.clone(), model.map(str::to_owned)).await?;
    runtime.request("initialize", json!({
        "clientInfo": {"name": "jarvis-codex", "title": "Mark Codex", "version": env!("CARGO_PKG_VERSION")},
        "capabilities": {"experimentalApi": true}
    })).await?;
    runtime.notify("initialized", json!({})).await?;
    let mut thread_options = json!({
        "cwd": cwd,
        "approvalPolicy": profile.approval_policy,
        "sandbox": profile.sandbox,
        "developerInstructions": runtime.assistant_profile.instructions(),
        "baseInstructions": format!(
            "You are {name}, an assistant speaking through a local voice interface. Keep voice replies concise and natural, execute real tasks with Codex tools when asked, report progress while work continues, and accept spoken corrections in the same thread. {} {}",
            ENGLISH_DEFAULT_INSTRUCTIONS,
            format!("{} {}", profile.instructions, google_workspace::agent_instructions()),
            name = assistant_name(state)
        )
    });
    if let Some(model) = model {
        thread_options["model"] = Value::String(model.to_owned());
    }
    let started = if let Some(thread_id) = resume_thread_id.filter(|value| !value.trim().is_empty())
    {
        let mut resume_options = thread_options.clone();
        resume_options["threadId"] = Value::String(thread_id.to_owned());
        runtime.request("thread/resume", resume_options).await.map_err(|error| {
            format!("Could not restore the saved conversation: {error}. Retry, or choose New Thread in Settings to start over.")
        })?
    } else {
        let mut start_options = thread_options;
        start_options["ephemeral"] = Value::Bool(false);
        runtime.request("thread/start", start_options).await?
    };
    let thread_id = started
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .ok_or("Codex did not return a thread ID")?
        .to_owned();
    *runtime.thread_id.write().await = Some(thread_id.clone());
    let journal = started.pointer("/thread/path").and_then(Value::as_str)
        .map(PathBuf::from).filter(|path| path.is_absolute())
        .ok_or("Codex did not return the saved conversation path")?;
    runtime.memory.configure(&thread_id, &cwd, &journal).await?;
    *state.runtime.lock().await = Some(runtime.clone());
    context_manager::start(&runtime);
    Ok(runtime)
}

#[tauri::command]
async fn start_jarvis(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    thread_id: Option<String>,
    permission_mode: PermissionMode,
    model: Option<String>,
) -> Result<SessionInfo, String> {
    let runtime = ensure_runtime(
        app,
        &state,
        &cwd,
        thread_id.as_deref(),
        permission_mode,
        model.as_deref(),
    )
    .await?;
    let thread_id = runtime.thread().await?;
    Ok(SessionInfo { thread_id, cwd })
}

#[tauri::command]
async fn start_codex_voice(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    thread_id: Option<String>,
    permission_mode: PermissionMode,
    model: Option<String>,
    sdp: String,
    voice: Option<String>,
) -> Result<DirectVoiceInfo, String> {
    if !sdp.starts_with("v=0") {
        return Err("Invalid WebRTC SDP offer".to_owned());
    }
    let runtime = ensure_runtime(
        app,
        &state,
        &cwd,
        thread_id.as_deref(),
        permission_mode,
        model.as_deref(),
    )
    .await?;
    let _memory_gate = runtime.memory.user_gate().await;
    let thread_id = runtime.thread().await?;
    if runtime.voice_active.load(Ordering::SeqCst) {
        let _ = runtime
            .request("thread/realtime/stop", json!({"threadId": thread_id}))
            .await;
    }
    *runtime.voice_phase.write().await = "starting".to_owned();
    runtime.voice_active.store(false, Ordering::SeqCst);
    *runtime.realtime_session_id.write().await = None;

    let initial_items = runtime.memory.initial_items(runtime.assistant_profile.clone()).await?;

    let mut params = json!({
        "threadId": thread_id,
        "outputModality": "audio",
        "version": "v3",
        "includeStartupContext": true,
        "initialItems": initial_items,
        "clientManagedHandoffs": false,
        // STOP must be final. Flushing the tail can create a new Codex turn
        // after the user has already stopped the session.
        "flushTranscriptTailOnSessionEnd": false,
        "codexResponsesAsItems": false,
        "codexResponseHandoffMode": "commentary",
        "transport": {"type": "webrtc", "sdp": sdp}
    });
    if let Some(voice) = voice {
        const SUPPORTED: &[&str] = &[
            "alloy", "arbor", "ash", "ballad", "breeze", "cedar", "coral", "cove", "echo", "ember",
            "juniper", "maple", "marin", "sage", "shimmer", "sol", "spruce", "vale", "verse",
        ];
        if SUPPORTED.contains(&voice.as_str()) {
            params["voice"] = Value::String(voice);
        }
    }
    if let Err(error) = runtime.request("thread/realtime/start", params).await {
        *runtime.voice_phase.write().await = "error".to_owned();
        return Err(format!("Codex Voice V3 failed to start: {error}"));
    }
    Ok(direct_voice_info(&state).await)
}

#[tauri::command]
async fn stop_codex_voice(state: State<'_, AppState>) -> Result<DirectVoiceInfo, String> {
    let Ok(runtime) = runtime(&state).await else {
        return Ok(direct_voice_info(&state).await);
    };
    let thread_id = runtime.thread().await?;
    *runtime.voice_phase.write().await = "stopping".to_owned();
    let result = runtime
        .request("thread/realtime/stop", json!({"threadId": thread_id}))
        .await;
    runtime.voice_active.store(false, Ordering::SeqCst);
    *runtime.voice_phase.write().await = "closed".to_owned();
    *runtime.realtime_session_id.write().await = None;
    result?;
    Ok(direct_voice_info(&state).await)
}

#[tauri::command]
async fn append_codex_voice_text(state: State<'_, AppState>, text: String) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Voice text cannot be empty".to_owned());
    }
    let runtime = runtime(&state).await?;
    let _memory_gate = runtime.memory.user_gate().await;
    if !runtime.voice_active.load(Ordering::SeqCst) {
        return Err("Codex Voice is not connected".to_owned());
    }
    let thread_id = runtime.thread().await?;
    // appendText does not persist typed input as a voice transcript. Save it
    // to the existing thread without starting a turn, then deliver it live.
    runtime.request("thread/inject_items", json!({
        "threadId": thread_id,
        "items": [{"type":"message", "role":"user", "content":[{"type":"input_text", "text":text}]}]
    })).await?;
    runtime
        .request(
            "thread/realtime/appendText",
            json!({"threadId": thread_id, "role": "user", "text": text}),
        )
        .await?;
    Ok(())
}

#[tauri::command]
async fn send_text(state: State<'_, AppState>, text: String) -> Result<(), String> {
    let runtime = runtime(&state).await?;
    let _memory_gate = runtime.memory.user_gate().await;
    let thread_id = runtime.thread().await?;
    runtime
        .request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{"type": "text", "text": text, "text_elements": []}]
            }),
        )
        .await?;
    Ok(())
}

#[tauri::command]
async fn send_openai_text(
    state: State<'_, AppState>,
    text: String,
    model: String,
) -> Result<String, String> {
    const MODELS: &[&str] = &["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"];
    if !MODELS.contains(&model.as_str()) {
        return Err(format!("Unsupported OpenAI text model: {model}"));
    }
    let key = openai_api_key()?;
    let instructions = assistant_instructions(&state);
    let body = json!({"model":model,"input":text,"instructions":instructions}).to_string();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("OpenAI client setup failed: {e}"))?;
    let answer = client
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("OpenAI connection failed: {e}"))?;
    let status = answer.status();
    let body = answer
        .text()
        .await
        .map_err(|e| format!("OpenAI response failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("OpenAI API returned {status}: {body}"));
    }
    let value: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    openai_response_text(&value)
        .map(str::to_owned)
        .ok_or_else(|| "OpenAI response contained no text".to_owned())
}

#[tauri::command]
async fn start_openai_realtime(
    state: State<'_, AppState>,
    sdp: String,
    model: String,
    voice: String,
) -> Result<String, String> {
    const MODELS: &[&str] = &[
        "gpt-realtime",
        "gpt-realtime-1.5",
        "gpt-realtime-2",
        "gpt-realtime-2.1",
        "gpt-realtime-2.1-mini",
    ];
    const VOICES: &[&str] = &[
        "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar",
    ];
    if !MODELS.contains(&model.as_str()) {
        return Err(format!("Unsupported OpenAI Realtime model: {model}"));
    }
    if !VOICES.contains(&voice.as_str()) {
        return Err(format!("Unsupported OpenAI Realtime voice: {voice}"));
    }
    if !sdp.starts_with("v=0") {
        return Err("Invalid WebRTC SDP offer".to_owned());
    }
    let key = openai_api_key()?;
    let instructions = assistant_instructions(&state);
    let session = json!({"type":"realtime","model":model,"instructions":instructions,"audio":{"output":{"voice":voice}}}).to_string();
    let form = reqwest::multipart::Form::new()
        .text("sdp", sdp)
        .text("session", session);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("OpenAI realtime client setup failed: {e}"))?;
    let answer = client
        .post("https://api.openai.com/v1/realtime/calls")
        .bearer_auth(key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("OpenAI realtime connection failed: {e}"))?;
    let status = answer.status();
    let body = answer
        .text()
        .await
        .map_err(|e| format!("OpenAI realtime response failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("OpenAI realtime returned {status}: {body}"));
    }
    if !body.starts_with("v=0") {
        return Err("OpenAI returned an invalid WebRTC SDP answer".to_owned());
    }
    Ok(body)
}

#[tauri::command]
async fn stop_all(state: State<'_, AppState>) -> Result<(), String> {
    state.claude_epoch.fetch_add(1, Ordering::SeqCst);
    state.claude_code.interrupt().await;
    let Ok(runtime) = runtime(&state).await else {
        return Ok(());
    };
    runtime.memory.cancel();
    let thread_id = runtime.thread().await?;
    // A realtime handoff and STOP can cross in flight. Re-check briefly so a
    // turn that starts just after realtime/stop is interrupted as well.
    let mut interrupted_turn: Option<String> = None;
    for _ in 0..6 {
        if let Some(turn_id) = runtime.active_turn.read().await.clone() {
            if interrupted_turn.as_deref() != Some(turn_id.as_str()) {
                let _ = runtime
                    .request(
                        "turn/interrupt",
                        json!({"threadId": thread_id, "turnId": turn_id}),
                    )
                    .await;
                interrupted_turn = Some(turn_id);
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
    if let Ok(background) = runtime
        .request(
            "thread/backgroundTerminals/list",
            json!({"threadId": thread_id, "limit": 100}),
        )
        .await
    {
        if let Some(terminals) = background.get("data").and_then(Value::as_array) {
            for terminal in terminals {
                if let Some(process_id) = terminal.get("processId").and_then(Value::as_str) {
                    let _ = runtime
                        .request(
                            "thread/backgroundTerminals/terminate",
                            json!({"threadId": thread_id, "processId": process_id}),
                        )
                        .await;
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn resolve_server_request(
    state: State<'_, AppState>,
    request_id: Value,
    approved: bool,
) -> Result<(), String> {
    let runtime = runtime(&state).await?;
    runtime.write(&json!({"id": request_id, "result": {"decision": if approved {"accept"} else {"decline"}}})).await
}

#[tauri::command]
async fn shutdown(state: State<'_, AppState>) -> Result<(), String> {
    state.claude_code.interrupt().await;
    terminate_runtime(&state).await
}

fn request_application_exit(app: AppHandle) {
    let state = app.state::<AppState>();
    if state.quitting.swap(true, Ordering::SeqCst) { return; }
    state.wake_enabled.store(false, Ordering::SeqCst);
    state.wake_ready.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); }
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let pid = state.wake_pid.swap(0, Ordering::SeqCst);
        stop_wake_process(pid).await;
        // Bound graceful cancellation so an unresponsive provider cannot block Quit.
        let _ = timeout(Duration::from_secs(2), stop_all(app.state::<AppState>())).await;
        let _ = timeout(Duration::from_secs(2), terminate_runtime(&state)).await;
        for _ in 0..20 {
            if !state.wake_supervisor_running.load(Ordering::SeqCst) { break; }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        // LaunchServices starts the Mac microphone helper as a separate process.
        // Stop it again after the supervisor has settled, before exiting the host.
        stop_wake_process(state.wake_pid.swap(0, Ordering::SeqCst)).await;
        app.exit(0);
    });
}

#[tauri::command]
fn opaque_window() -> bool {
    cfg!(target_os = "windows") && std::env::var("MARK_OPAQUE_WINDOW").as_deref() == Ok("1")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Set this before WebView2 is created; setting the controller color later alone
    // can still flash white during its initial navigation (Microsoft WebView2 docs).
    #[cfg(target_os = "windows")]
    std::env::set_var(
        "WEBVIEW2_DEFAULT_BACKGROUND_COLOR",
        if opaque_window() {
            "FF02070B"
        } else {
            "0002070B"
        },
    );
    let arguments: Vec<String> = std::env::args().collect();
    let cold_wake_pending = arguments.iter().any(|argument| argument == "--jarvis-wake");
    let background_start = arguments.iter().any(|argument| argument == "--background");
    let builder = tauri::Builder::default();
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        if !app.state::<AppState>().quitting.load(Ordering::SeqCst) {
            raise_jarvis_window(app);
        }
    }));
    builder
        .manage(window_controls::WindowState::default())
        .manage(AppState {
            assistant_profile: StdRwLock::new(identity::AssistantProfile::default()),
            claude_history: Mutex::new(Vec::new()),
            claude_epoch: AtomicU64::new(0),
            claude_code: claude_code::ClaudeCodeRuntime::new(),
            runtime: Mutex::new(None),
            cold_wake_pending: AtomicBool::new(cold_wake_pending),
            background_start,
            quitting: AtomicBool::new(false),
            wake_enabled: AtomicBool::new(false),
            wake_ready: AtomicBool::new(false),
            wake_supervisor_running: AtomicBool::new(false),
            wake_pid: AtomicU32::new(0),
            wake_authorization: RwLock::new("notDetermined".to_owned()),
        })
        .invoke_handler(tauri::generate_handler![
            window_controls::window_is_compact,
            window_controls::minimize_or_hide_window,
            window_controls::toggle_window_mode,
            window_controls::quit_application,
            opaque_window,
            direct_voice_status,
            arm_wake_listener,
            disarm_wake_listener,
            wake_listener_status,
            consume_cold_wake,
            get_assistant_name,
            set_assistant_name,
            get_assistant_profile,
            set_assistant_profile,
            default_workspace,
            startup_is_background,
            request_microphone_permission,
            list_codex_models,
            start_jarvis,
            start_codex_voice,
            stop_codex_voice,
            append_codex_voice_text,
            send_text,
            send_openai_text,
            send_claude_text,
            send_claude_code,
            claude_configuration,
            google_workspace_status,
            transcribe_claude_audio,
            speak_claude_text,
            reset_claude_conversation,
            interrupt_claude,
            start_openai_realtime,
            stop_all,
            resolve_server_request,
            shutdown
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                request_application_exit(window.app_handle().clone());
            }
        })
        .on_page_load(|window, payload| {
            #[cfg(target_os = "windows")]
            if payload.event() == tauri::webview::PageLoadEvent::Finished
                && !window.state::<AppState>().background_start
            {
                raise_jarvis_window(window.app_handle());
            }
            #[cfg(not(target_os = "windows"))]
            let _ = (window, payload);
        })
        .setup(move |app| {
            if let (Ok(path), Ok(legacy)) = (
                assistant_profile_path(app.handle()), assistant_name_path(app.handle())
            ) {
                match identity::load(&path, &legacy) {
                    Ok(profile) => *app.state::<AppState>().assistant_profile
                        .write().expect("assistant profile lock poisoned") = profile,
                    Err(error) => eprintln!("{error}"),
                }
            }
            use tauri_plugin_autostart::MacosLauncher;
            app.handle().plugin(tauri_plugin_autostart::init(
                MacosLauncher::LaunchAgent,
                Some(vec!["--background"]),
            ))?;
            // Portable Windows edition: do not change Windows startup settings automatically.
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                window.set_background_color(Some(tauri::window::Color(
                    2,
                    7,
                    11,
                    if opaque_window() { 255 } else { 0 },
                )))?;
                if background_start {
                    let _ = window.hide();
                } else {
                    #[cfg(not(target_os = "windows"))]
                    raise_jarvis_window(app.handle());
                }
            }
            if background_start {
                start_wake_supervisor(app.handle().clone());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Mark Codex")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                if !app.state::<AppState>().quitting.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    request_application_exit(app.clone());
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if !app.state::<AppState>().quitting.load(Ordering::SeqCst) {
                    raise_jarvis_window(app);
                }
            }
            _ => {}
        });
}
