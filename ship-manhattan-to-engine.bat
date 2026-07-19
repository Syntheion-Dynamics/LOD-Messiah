@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================
echo  Ship Manhattan kit -^> Bungac Assets
echo  default + lod0/1/2/3 + atlasy + _shared/
echo ============================================
echo.
echo  Scena: Buildings\Manhattan\^<Asset^>\lod0.glb
echo  default.glb vedle = close-up (engine LOD0)  ^<= kopiruje se VZDY
echo  _shared\textures\ = sdilene textury (jednou)
echo  Bez default: pridej --no-default
echo  Vsechny kity: ship-all-kitbash-to-engine.bat
echo ============================================
echo.

if not exist "node_modules\" call npm install

REM Pouziti:
REM   ship-manhattan-to-engine.bat
REM   ship-manhattan-to-engine.bat --dry-run
REM   ship-manhattan-to-engine.bat --no-default
REM   ship-manhattan-to-engine.bat --no-default --dry-run

set EXTRA=
if /I "%~1"=="--dry-run" set EXTRA=%EXTRA% --dry-run
if /I "%~2"=="--dry-run" set EXTRA=%EXTRA% --dry-run
if /I "%~3"=="--dry-run" set EXTRA=%EXTRA% --dry-run
if /I "%~1"=="--no-default" set EXTRA=%EXTRA% --no-default
if /I "%~2"=="--no-default" set EXTRA=%EXTRA% --no-default
if /I "%~3"=="--no-default" set EXTRA=%EXTRA% --no-default

echo Spoustim: node scripts\ship-kit-to-engine.js Manhattan%EXTRA%
echo.

node scripts\ship-kit-to-engine.js Manhattan%EXTRA%
if errorlevel 1 (
  echo.
  echo Ship Manhattan FAILED.
  if /I "%~1"=="--no-pause" goto :eof
  if /I "%~2"=="--no-pause" goto :eof
  if /I "%~3"=="--no-pause" goto :eof
  pause
  exit /b 1
)

echo.
echo Hotovo. Scena: Buildings\Manhattan\^<Asset^>\lod0.glb
if /I "%~1"=="--no-pause" goto :eof
if /I "%~2"=="--no-pause" goto :eof
if /I "%~3"=="--no-pause" goto :eof
pause
