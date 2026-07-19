@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================
echo  Ship cooked asset -^> Bungac Assets
echo  Day-1: lod0/1/2 + asset.json (+ lod2_atlas)
echo ============================================
echo.

if not exist "node_modules\" call npm install

set REL=%~1
if "%REL%"=="" set REL=Manhattan\Office_Plaza

echo Asset: %REL%
echo.

node scripts\ship-to-engine.js "%REL%"
if errorlevel 1 (
  echo.
  echo Ship FAILED.
  exit /b 1
)

echo.
echo Hotovo. Ve scene odkazuj: Buildings\%REL%\lod0.glb
if /I "%~2"=="--no-pause" goto :eof
pause
