@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\apply-mark-fixes.ps1"
if errorlevel 1 goto failed
goto done
:failed
echo The MARK fixes were not finished. Check the message above.
:done
pause
