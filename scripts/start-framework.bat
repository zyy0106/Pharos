@echo off
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 18 or newer is required.
  echo         Install from https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [INIT] Installing Node dependencies...
  call npm ci
  if errorlevel 1 exit /b 1
)

echo [START] Launching the supervised WebUI...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-framework.ps1"
if errorlevel 1 pause
