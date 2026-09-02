@echo off
title Xtream Web Player
cd /d "%~dp0"
rem Uncomment the next line if your panel uses a self-signed certificate:
rem set XTREAM_INSECURE_TLS=1
start "" http://127.0.0.1:8787
node server.js
echo.
echo Player stopped.
pause
