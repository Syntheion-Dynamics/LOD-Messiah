@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================
echo  High-Poly -^> Engine-Ready  (batch)
echo  Input : %CD%\input
echo  Output: %CD%\output
echo ============================================
echo.

if not exist "node_modules\" (
  echo [1/2] npm install...
  call npm install
  if errorlevel 1 (
    echo npm install FAILED
    pause
    exit /b 1
  )
) else (
  echo [1/2] node_modules OK
)

if not exist "input\" (
  echo Slozka input\ neexistuje. Dej sem .glb / .obj / .fbx
  pause
  exit /b 1
)

echo.
echo [2/2] Konverze vsech budov v input\ ...
echo   LOD0 ratio 0.5 + octahedral impostor 8x8 @ 1024px
echo   max-texture 2048
echo.

call npm run convert -- --input .\input --output .\output --max-texture 2048 --ratio 0.5 --impostor-mode octahedral --impostor-frames 8 --impostor-res 1024

set ERR=%ERRORLEVEL%
echo.
echo ============================================
if %ERR% equ 0 (
  echo  HOTOVO. Vystup: %CD%\output\
  echo  Kazda budova: lod0.glb + impostor + preview.html
) else (
  echo  DOKONCENO S CHYBAMI ^(exit %ERR%^). Viz log vyse.
)
echo ============================================
echo.
pause
exit /b %ERR%
