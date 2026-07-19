@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================
echo  Impostor / LOD gallery preview
echo  http://127.0.0.1:4173
echo ============================================
echo.
echo  Ctrl+C ukonci server.
echo.

if not exist "node_modules\" call npm install
if not exist "output\" (
  echo [!] output\ chybi — nejdriv spust convert.
  pause
  exit /b 1
)

REM Kill stale gallery on same port (otherwise UI stays on old code).
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":4173" ^| findstr "LISTENING"') do (
  echo [i] Ukoncuji stary gallery server PID %%P
  taskkill /F /PID %%P >nul 2>&1
)

start "" "http://127.0.0.1:4173"
call npm run gallery
