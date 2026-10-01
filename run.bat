@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download it from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies - first run only...
  call npm install
  echo.
)

node scaha.js %*

echo.
pause
