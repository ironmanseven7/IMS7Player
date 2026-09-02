@echo off
title Xtream Web Player
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo.
  echo   Install the LTS version from  https://nodejs.org
  echo   then run this file again.
  echo.
  pause
  exit /b 1
)

rem Uncomment if your panel uses a self-signed certificate:
rem set XTREAM_INSECURE_TLS=1

rem To let other devices on your network use this, uncomment BOTH lines and
rem pick your own passcode. Without a passcode, anyone who can reach this
rem machine can relay traffic through your connection.
rem set BIND=0.0.0.0
rem set XTREAM_PASSCODE=change-me

start "" http://127.0.0.1:8787
node server.js
echo.
echo Player stopped.
pause
