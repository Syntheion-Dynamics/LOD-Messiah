@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================
echo  Cook UI — kit + LOD picker
echo  http://127.0.0.1:4174
echo ============================================
echo.
echo  Vyber kity a LODy v prohlizeci.
echo  Ctrl+C ukonci server.
echo.

if not exist "node_modules\" call npm install

if not exist "Kitbash Assets\" (
  echo [!] Kitbash Assets\ chybi — UI nabehne, ale seznam kitu bude prazdny.
  echo.
)

REM Kill stale cook-ui on same port
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":4174" ^| findstr "LISTENING"') do (
  echo [i] Ukoncuji stary cook-ui server PID %%P
  taskkill /F /PID %%P >nul 2>&1
)

start "" "http://127.0.0.1:4174"
call npm run cook-ui
