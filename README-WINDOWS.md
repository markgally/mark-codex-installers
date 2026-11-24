# MARK Codex for Windows 0.2.10

This Windows x64 edition includes the original helmet, Cyber Boy, Cyber Girl,
blinking and reactions, customizable assistant identity and form of address,
and Minimize / Compact-Restore / Quit controls.
The default appearance remains the original helmet.

## Run the ZIP release

Extract the whole setup ZIP into a new folder on the Windows laptop.
Run `1 - Set up and sign in.cmd`, then `2 - Start MARK Codex.cmd`.
The app and Google Workspace CLI are included. First setup downloads the pinned
official Codex runtime and validates its SHA-256 before installing it locally.
The launcher checks for missing runtime support files each time it starts.
No Node.js or Rust is needed to run the release. Edge WebView2 Runtime is required.

Exit the old MARK version before opening this one. Existing settings use the same
application identity; each Windows user supplies their own sign-in and API keys.
Saved conversations resume when Windows returns an equivalent path to their
existing journal. New conversations can start while Codex creates their journal.

With the bundled Codex runtime, Mark opens a Sign in with ChatGPT screen if
Codex needs an account. Choose Sign in with ChatGPT and finish in your default
browser. An existing Codex sign-in is reused.

## Window controls

- Minimize keeps MARK running on the taskbar. Select its taskbar icon to restore the window.
- Compact creates a 360 x 480 floating window at the current screen's bottom-right,
  above the taskbar. Clicking Restore returns the previous window size and position.
- Quit exits MARK and stops its wake listener. It also works from Windows Close.
- Opening MARK again brings the existing window to the foreground.
- Opening Settings from compact mode restores the full window for readable fields.

Transparent native-window, WebView startup-color, and CSS settings are aligned.
If a graphics configuration does not support transparency, use
`Start with dark background.cmd` for the opaque dark fallback.

## Identity and avatars

Settings contains Assistant name, What should the assistant call you?, and
Assistant role and personality. Save applies the profile to new voice sessions
and text requests. Identity changes stop active work and voice.
Your profile is stored on that Windows machine; no Mac profile is packaged.

Cyber Boy/Girl portraits, blink PNGs, helmet default, mask shapes, and color
behavior are preserved. The post-Save assembly completion fix is included.

## Build on Windows

Install Node.js 20 or newer, Rust stable with the x64 MSVC target, Microsoft Visual
C++ Build Tools (Desktop development with C++), and WebView2.
See https://v2.tauri.app/start/prerequisites/ .
Run `powershell -NoProfile -ExecutionPolicy Bypass -File .\Build-Windows.ps1`.
This prepares checksum-verified runtimes, runs the checks, and builds an NSIS installer.

## Cross-build

With the Windows Rust target, cargo-xwin and LLVM available, build the frontend
with `npm ci` and `npm run web:build`, then run:
`cargo xwin build --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --release --features tauri/custom-protocol --locked`.
The custom-protocol feature embeds the production frontend into the executable.
Copy the executable with its `bin/` and `wake-helper/` resources for the portable ZIP.

## Package a portable release

After building the release executable from a committed revision, run
`scripts/package-windows-setup.ps1` with the executable, the verified Windows
0.2.7 setup ZIP as `-BaseArchive`, and an `-OutputDirectory`. The script reads
the version from the source commit and includes the matching source ZIP and
SHA-256 manifest.

## Validation boundary

Shared frontend checks and native unit checks run on the Mac build host.
The executable is cross-compiled for AMD64 Windows GUI, and the production
assets, PowerShell syntax, imports, checksums and ZIP contents are verified.
A real Windows laptop is still needed to verify rendering, taskbar placement,
microphone permissions, speech recognition, sign-in, and bidirectional voice.
The unsigned release is not represented as a Windows end-to-end tested build.

Voice sleep and reconnect now restore recent conversation from the same saved Codex thread, including after an app restart. Earlier requests are loaded as history, without replaying tasks. If restoring a saved thread fails, the app reports the error; New Thread is the explicit way to start over. This is bounded recent context, not unlimited long-term memory.

Automatic context management: Codex retains the same conversation and separate identity settings. A short goals/decisions/facts/unfinished-tasks summary and up to 20 recent exchanges are restored within a strict voice context budget. At 70% current context, maintenance waits for voice and tasks to finish, then summarizes older messages and compacts the Codex thread. Full local transcripts are retained for lookup. New speech/work cancels background maintenance. Failed summaries keep the previous checkpoint and retry later. No routine interaction is required.
