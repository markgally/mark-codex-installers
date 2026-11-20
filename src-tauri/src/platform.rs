use std::{env, path::PathBuf};

pub fn home_dir() -> Option<PathBuf> {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
}

pub fn executable(name: &str, override_name: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = env::var_os(override_name) {
        candidates.push(PathBuf::from(path));
    }
    #[cfg(target_os = "windows")]
    let file = format!("{name}.exe");
    #[cfg(not(target_os = "windows"))]
    let file = name.to_owned();
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("bin").join(&file));
        }
    }
    if let Some(home) = home_dir() {
        candidates.push(home.join(".local/bin").join(&file));
        candidates.push(home.join(".cargo/bin").join(&file));
    }
    if let Some(path) = env::var_os("PATH") {
        candidates.extend(
            env::split_paths(&path)
                .filter(|p| p.is_absolute())
                .map(|p| p.join(&file)),
        );
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin").join(&file));
        candidates.push(PathBuf::from("/usr/local/bin").join(&file));
    }
    candidates.into_iter().find(|p| p.is_file())
}
