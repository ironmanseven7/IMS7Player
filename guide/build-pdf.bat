@echo off
rem Rebuilds the PDF from install-guide.html using headless Chrome.
cd /d "%~dp0"
"C:\Program Files\Google\Chrome\Application\chrome.exe" --headless --disable-gpu ^
  --no-pdf-header-footer --virtual-time-budget=8000 ^
  --print-to-pdf="%~dp0install-guide.pdf" "file:///%~dp0install-guide.html"
copy /y install-guide.pdf "Fire TV Install Guide - Large Print.pdf" >nul
echo Done.
pause
