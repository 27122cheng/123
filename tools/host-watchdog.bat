@echo off
rem host-watchdog.bat - launches host-watchdog.ps1 (keep this window open)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0host-watchdog.ps1"
pause
