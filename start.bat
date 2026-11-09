@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js is not installed. Please install the LTS version from https://nodejs.org and run this file again.
  start https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing packages for the first run. This takes 1-2 minutes...
  call npm install
  if errorlevel 1 (
    echo [!] npm install failed.
    pause
    exit /b 1
  )
)
echo Starting server... Open http://localhost:3000 in your browser. Close this window to stop.
start "" http://localhost:3000
npm start
pause
