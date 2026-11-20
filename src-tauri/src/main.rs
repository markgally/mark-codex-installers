#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// macOS development needs an app bundle for application identity, native
// microphone attribution, and desktop accessibility. Run the freshly compiled
// source binary inside that bundle while `tauri dev` keeps Vite alive.
#[cfg(all(target_os = "macos", debug_assertions))]
fn launch_source_bundle() -> std::io::Result<std::process::ExitStatus> {
    use std::{fs, path::PathBuf, process::Command};
    let executable = std::env::current_exe()?;
    let parent = executable
        .parent()
        .expect("the development binary has a parent");
    let bundle = parent.join("bundle/Mark Codex Cyber Preview.app");
    let contents = bundle.join("Contents");
    fs::create_dir_all(contents.join("MacOS"))?;
    fs::create_dir_all(contents.join("Resources"))?;
    fs::copy(&executable, contents.join("MacOS/jarvis-codex"))?;
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>jarvis-codex</string>
<key>CFBundleIdentifier</key><string>com.bigguan.jarvis-codex</string>
<key>CFBundleName</key><string>Mark Codex Cyber Preview</string>
<key>CFBundleDisplayName</key><string>Mark Codex</string>
<key>CFBundleVersion</key><string>{version}</string>
<key>CFBundleShortVersionString</key><string>{version}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSMicrophoneUsageDescription</key><string>M.A.R.K. uses microphone audio for your voice requests.</string>
<key>NSSpeechRecognitionUsageDescription</key><string>M.A.R.K. recognizes your configured wake phrase locally.</string>
<key>NSCameraUsageDescription</key><string>M.A.R.K. does not capture video; WebKit requires this media permission declaration.</string>
</dict></plist>"#,
        version = env!("CARGO_PKG_VERSION")
    );
    fs::write(contents.join("Info.plist"), plist)?;
    fs::copy(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("icons/icon.icns"),
        contents.join("Resources/icon.icns"),
    )?;
    Command::new("/usr/bin/open")
        .args(["-n", "-W"])
        .arg(&bundle)
        .arg("--args")
        .arg("--mark-source-dev-app")
        .args(std::env::args().skip(1))
        .status()
}

fn main() {
    #[cfg(all(target_os = "macos", debug_assertions))]
    if !std::env::args().any(|argument| argument == "--mark-source-dev-app") {
        match launch_source_bundle() {
            Ok(status) => std::process::exit(status.code().unwrap_or(1)),
            Err(error) => {
                eprintln!("Could not open the Mac source app: {error}");
                std::process::exit(1);
            }
        }
    }
    jarvis_codex_lib::run();
}
