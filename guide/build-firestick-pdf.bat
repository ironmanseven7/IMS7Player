@echo off
rem Rebuilds the Fire TV Stick guide from firestick-install-guide.html.
rem (build-pdf.bat does the large-print one, which is a separate document.)
cd /d "%~dp0"
"C:\Program Files\Google\Chrome\Application\chrome.exe" --headless --disable-gpu ^
  --no-pdf-header-footer --virtual-time-budget=8000 ^
  --print-to-pdf="%~dp0Fire TV Stick Install Guide.pdf" "file:///%~dp0firestick-install-guide.html"
echo Done.
pause
