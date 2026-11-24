use super::{AppHandle, AppState, CodexRuntime, Duration, PermissionMode, State};
use reqwest::Url;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::{sync::watch, time::timeout};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LoginResult {
    login_id: Option<String>,
    success: bool,
}

fn sign_in_required(response: &Value) -> Result<bool, String> {
    let requires_auth = response["requiresOpenaiAuth"]
        .as_bool()
        .ok_or("Codex did not report whether sign-in is required.")?;
    let account = response
        .get("account")
        .ok_or("Codex did not report the current account status.")?;
    Ok(requires_auth && account.is_null())
}

async fn read_account(runtime: &CodexRuntime) -> Result<bool, String> {
    let account = runtime
        .request("account/read", json!({ "refreshToken": false }))
        .await?;
    sign_in_required(&account)
}

async fn start_account_runtime(app: AppHandle) -> Result<Arc<CodexRuntime>, String> {
    let runtime = CodexRuntime::spawn(app, PermissionMode::Safe, String::new(), None).await?;
    runtime.initialize().await?;
    Ok(runtime)
}

#[tauri::command]
pub(super) async fn codex_sign_in_required(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let existing = state.runtime.lock().await.clone();
    timeout(Duration::from_secs(12), async {
        let runtime = match existing {
            Some(runtime) => runtime,
            None => start_account_runtime(app).await?,
        };
        read_account(&runtime).await
    })
    .await
    .map_err(|_| "The Codex sign-in check timed out.".to_owned())?
}

#[tauri::command]
pub(super) async fn sign_in_with_chatgpt(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let (cancel, mut canceled) = watch::channel(false);
    {
        let mut active = state.chatgpt_login.lock().await;
        if active.is_some() {
            return Err("ChatGPT sign-in is already running.".into());
        }
        *active = Some(cancel);
    }
    let result = tokio::select! {
        biased;
        _ = canceled.changed() => Ok(false),
        result = timeout(Duration::from_secs(300), browser_login(app)) => {
            result.unwrap_or_else(|_| Err("ChatGPT sign-in timed out. Try again.".into()))
        }
    };
    *state.chatgpt_login.lock().await = None;
    result
}

#[tauri::command]
pub(super) async fn cancel_chatgpt_login(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(cancel) = state.chatgpt_login.lock().await.as_ref() {
        cancel.send_replace(true);
    }
    Ok(())
}

async fn browser_login(app: AppHandle) -> Result<bool, String> {
    let runtime = start_account_runtime(app).await?;
    if !read_account(&runtime).await? {
        return Ok(true);
    }

    let mut completion = runtime.login_result.subscribe();
    let login = runtime
        .request("account/login/start", json!({ "type": "chatgpt" }))
        .await?;
    let login_id = login["loginId"]
        .as_str()
        .ok_or("Codex did not return a login ID.")?;
    let auth_url = login["authUrl"]
        .as_str()
        .ok_or("Codex did not return a sign-in link.")?;
    let url = chatgpt_auth_url(auth_url)?;
    open_browser(&url).await?;

    let wait_for_completion = async {
        loop {
            if let Some(result) = completion.borrow_and_update().clone() {
                if result.login_id.as_deref() == Some(login_id) {
                    return if result.success {
                        Ok(true)
                    } else {
                        Err("ChatGPT sign-in did not finish. Try again.".into())
                    };
                }
            }
            completion.changed().await.map_err(|_| "Codex closed the sign-in connection.")?;
        }
    };
    tokio::select! {
        result = wait_for_completion => result,
        _ = async { runtime.child.lock().await.wait().await } => {
            Err("Codex closed the sign-in connection. Try again.".into())
        }
    }
}

fn chatgpt_auth_url(raw: &str) -> Result<Url, String> {
    Url::parse(raw)
        .ok()
        .filter(|url| {
            url.scheme() == "https"
                && url.host_str() == Some("auth.openai.com")
                && url.username().is_empty()
                && url.password().is_none()
                && url.port().is_none()
        })
        .ok_or_else(|| "Codex returned an unexpected ChatGPT sign-in link.".into())
}

#[cfg(target_os = "windows")]
async fn open_browser(url: &Url) -> Result<(), String> {
    use std::{ffi::c_void, ptr::null};
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            window: *mut c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> isize;
    }
    let url: Vec<u16> = url.as_str().encode_utf16().chain([0]).collect();
    // ShellExecuteW reads the null-terminated URL during this call.
    let result = unsafe {
        ShellExecuteW(std::ptr::null_mut(), null(), url.as_ptr(), null(), null(), 1)
    };
    if result > 32 {
        Ok(())
    } else {
        Err("Could not open your default browser.".into())
    }
}

#[cfg(not(target_os = "windows"))]
async fn open_browser(url: &Url) -> Result<(), String> {
    let opener = if cfg!(target_os = "macos") {
        "/usr/bin/open"
    } else {
        "xdg-open"
    };
    let status = tokio::process::Command::new(opener)
        .arg(url.as_str())
        .status()
        .await;
    if status.is_ok_and(|status| status.success()) {
        Ok(())
    } else {
        Err("Could not open your default browser.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompts_only_when_codex_requires_auth_and_no_account_exists() {
        assert_eq!(sign_in_required(&json!({"requiresOpenaiAuth":true,"account":null})), Ok(true));
        for account in ["chatgpt", "apiKey"] {
            assert_eq!(sign_in_required(&json!({"requiresOpenaiAuth":true,"account":{"type":account}})), Ok(false));
        }
        assert_eq!(sign_in_required(&json!({"requiresOpenaiAuth":false,"account":null})), Ok(false));
        assert!(sign_in_required(&json!({"requiresOpenaiAuth":true})).is_err());
    }

    #[test]
    fn opens_only_the_official_https_sign_in_origin() {
        assert!(chatgpt_auth_url("https://auth.openai.com/oauth/authorize?state=test").is_ok());
        for url in [
            "http://auth.openai.com/",
            "https://auth.openai.com.example.net/",
            "https://auth.openai.com@elsewhere.example/",
            "https://user@auth.openai.com/",
            "https://auth.openai.com:8080/",
        ] {
            assert!(chatgpt_auth_url(url).is_err(), "{url}");
        }
    }
}
