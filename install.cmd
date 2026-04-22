@echo off
rem install.cmd - wrapper that keeps the window open so you can read output
rem even if install.ps1 fails before its own pause handler runs.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"

echo.
echo (installer exited - press any key to close this window)
pause >nul
