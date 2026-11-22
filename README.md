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

## Which file to download

- Mac computer: download `Mark.Codex_0.2.0_aarch64.zip`. This is the existing 0.2.0 application archive, not a v0.2.7 DMG. It contains only `Mark Codex.app`. GitHub lists it with a dot in place of the space in `Mark Codex`.
- Windows computer: download `MARK-Codex-Windows-x64-Setup-0.2.8.zip`. It includes the Windows x64 app and its matching source archive. Version 0.2.8 adds standard Windows minimize, runtime checks on launch, and fixes saved conversation restore when Windows returns an equivalent journal path.

Codex sign-in, API keys, Google accounts, and conversations are not inside either file. Each computer signs in on its own.

## Mac

Requirements: Apple Silicon and macOS 13 or newer.

1. Unzip `Mark.Codex_0.2.0_aarch64.zip`.
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
