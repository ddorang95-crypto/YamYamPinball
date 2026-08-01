@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
set "URL=http://localhost:8787/admin.html?room=YAMYAM"
title YAMYAM Marble Pinball Server

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 'http://127.0.0.1:8787/api/state?room=YAMYAM'; if($r.StatusCode -eq 200){exit 0}else{exit 1} } catch { exit 1 }"
if not errorlevel 1 (
  echo Server is already running. Opening admin page...
  start "" "%URL%"
  exit /b 0
)

echo Starting YAMYAM Marble Pinball...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
set "ERR=%ERRORLEVEL%"
echo.
if not "%ERR%"=="0" (
  echo Server failed to start. Error code: %ERR%
  echo Please send a screenshot of this black window if it fails again.
  pause
)
endlocal
