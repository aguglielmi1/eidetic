@echo off
rem launch.cmd - wrapper that keeps the window open so you can read output
rem even if launch.ps1 fails before its own pause handler runs.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1"

echo.
echo (launcher exited - press any key to close this window)
pause >nul
