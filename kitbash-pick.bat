@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo  Kitbash pick — vyber kit, pak convert / ship / oboji
echo  (slozky z "Kitbash Assets")
echo.

if not exist "node_modules\" call npm install
if not exist "Kitbash Assets\" (
  echo CHYBA: chybi "Kitbash Assets"
  pause
  exit /b 1
)

if not defined LOD3_RES set "LOD3_RES=2048"
if not defined CONVERT_JOBS set "CONVERT_JOBS=7"

node scripts\kitbash-pick.js
set ERR=%ERRORLEVEL%

echo.
if not "%ERR%"=="0" (
  echo Selhalo ^(exit %ERR%^).
  pause
  exit /b %ERR%
)
pause
