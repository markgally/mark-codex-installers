@echo off
setlocal
cd /d "%~dp0"
if defined JARVIS_CODEX_BIN if exist "%JARVIS_CODEX_BIN%" goto launch
if exist "%~dp0bin\mark-codex-bridge.exe" (
  set "JARVIS_CODEX_BIN=%~dp0bin\mark-codex-bridge.exe"
  goto launch
)
if exist "%~dp0bin\codex.exe" goto bundled
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-Codex.ps1"
if errorlevel 1 goto failed
:bundled
set "JARVIS_CODEX_BIN=%~dp0bin\codex.exe"
:launch
set "MARK_GWS_BIN=%~dp0bin\gws.exe"
set "PATH=%~dp0bin;%~dp0bin\codex-path;%PATH%"
start "" "%~dp0Mark Codex.exe"
exit /b 0
:failed
echo Codex setup failed. Check your internet connection and try step 1 again.
pause
exit /b 1
