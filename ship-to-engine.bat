@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================
echo  Ship cooked asset -^> Bungac Assets
echo  default + lod0/1/2/3 + asset.json + atlasy
echo  (+ kit _shared/ kdyz existuje)
echo  Cisti stale raw .glb vedle cooked slozky
echo ============================================
echo.

if not exist "node_modules\" call npm install

set REL=%~1
if "%REL%"=="" set REL=Manhattan\Office_Plaza

set EXTRA=
if /I "%~2"=="--no-default" set EXTRA=%EXTRA% --no-default
if /I "%~3"=="--no-default" set EXTRA=%EXTRA% --no-default

echo Asset: %REL%
if not "%EXTRA%"=="" echo Mode:%EXTRA%
echo.

node scripts\ship-to-engine.js "%REL%"%EXTRA%
if errorlevel 1 (
  echo.
  echo Ship FAILED.
  exit /b 1
)

echo.
echo Hotovo. Ve scene odkazuj: Buildings\%REL%\lod0.glb
echo NE Buildings\%REL%.glb  (raw KitBash = vice budov v jednom)
echo default.glb vedle lod0 = close-up LOD0
if /I "%~2"=="--no-pause" goto :eof
if /I "%~3"=="--no-pause" goto :eof
pause

