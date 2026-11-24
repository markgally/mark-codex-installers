# M.A.R.K. Codex

Mark Codex is a desktop voice assistant for Codex. The source in this repository is GPL-3 and is based on [jarvis-codex](https://github.com/Big-Guan/jarvis-codex) by Big-Guan.

This page is the project homepage. The privacy policy is [PRIVACY.md](PRIVACY.md). Downloads are on the [Releases](https://github.com/markgally/mark-codex-installers/releases) page.

The current release files were built before SignPath signing and are still unsigned. macOS and Windows may warn before they open.

## Code signing policy

Free code signing provided by SignPath.io, certificate by SignPath Foundation.

The certificate is issued to SignPath Foundation. The only file submitted for that signature is `Mark Codex.exe`, built from this repository by the Windows executable workflow. The Codex runtime and `gws.exe` are separate programs and are not signed with this certificate.

- Committers and reviewers: [Mark Gally Reboton](https://github.com/markgally)
- Approvers: [Mark Gally Reboton](https://github.com/markgally)

## Source build

The Windows executable workflow installs the dependencies and runs `npm run build` on `windows-latest`. Its artifact is `Mark Codex.exe`. Build tools for a local Windows build are described in [README-WINDOWS.md](README-WINDOWS.md).

### Build on Mac

Install Node.js 22, Rust stable, and the Xcode Command Line Tools. On an Apple Silicon Mac, run:

```sh
npm ci
npm run wake:build
npm run check
npm run build
```

Tauri automatically loads `src-tauri/tauri.macos.conf.json` for the transparent Mac window, native wake helper, microphone permissions, and macOS 13 minimum. The Cargo feature and matching `macOSPrivateApi` setting enable the required Mac transparency support; these settings have no effect on Windows. The app and DMG are written under `src-tauri/target/release/bundle/`. Local Mac builds use ad hoc signing; they are not notarized.

The checked-in Mac configuration comes from the local 0.2.7 build installed on the maintainer’s Mac. Shared app source remains at 0.2.7, and the Windows build configuration is preserved.

## Which file to download

- Mac computer: download `MARK-Codex-Mac-arm64-0.2.7.zip`. This contains the 0.2.7 `Mark Codex.app` currently installed on the maintainer’s Mac. The older `Mark.Codex_0.2.0_aarch64.zip` remains available as a historical download.
- Windows computer: download `MARK-Codex-Windows-x64-Setup-0.2.7.zip`. This is the 64-bit Windows setup archive for version 0.2.7. It also includes `MARK-Codex-Windows-Source-0.2.7.zip`, so the Windows source is in that same download.

Codex sign-in, API keys, Google accounts, and conversations are not inside either file. Each computer signs in on its own.

## Mac

Requirements: Apple Silicon and macOS 13 or newer.

1. Quit any running copy of Mark Codex, then unzip `MARK-Codex-Mac-arm64-0.2.7.zip`.
2. Move `Mark Codex.app` to Applications.
3. If macOS blocks the first open, right-click the app and choose Open.
4. Allow the microphone and speech recognition when macOS asks.

The wake phrase follows the assistant name in Settings. The default is “Hey Mark.”

## Windows

Requirements: 64-bit Windows and the [Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/). Node.js and Rust are not required to run the app.

1. Extract the whole ZIP into a new folder. Do not run it from inside the ZIP.
2. Run `Check Windows requirements.cmd`.
3. Run `1 - Set up and sign in.cmd`. The first run downloads the official Codex runtime, checks its checksum, and opens Codex sign-in. Internet is required.
4. Run `2 - Start MARK Codex.cmd`.
5. Allow the desktop microphone in Windows Settings. Wake phrases also need an English speech language pack.

Keep `bin`, `scripts`, and `wake-helper` beside `Mark Codex.exe`. If the transparent window does not display, use `Start with dark background.cmd`. Optional Gmail, Calendar, and Sheets access is started with `3 - Google Workspace setup.cmd`.

OpenAI API mode needs your own `OPENAI_API_KEY`. Claude Chat also needs `ANTHROPIC_API_KEY`. Restart the app after changing those variables.
