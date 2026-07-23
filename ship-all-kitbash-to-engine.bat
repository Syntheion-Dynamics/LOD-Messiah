@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================
echo  Ship ALL KitBash kits -^> Bungac Assets
echo  Dynamicky z "Kitbash Assets" ^(vsechny slozky^)
echo  default.glb + lod0/1/2/3 + atlasy + _shared/
echo ============================================
echo.
echo  Scena: Buildings\^<Kit^>\^<Asset^>\lod0.glb
echo  Opt: --dry-run   --no-default   --no-pause
echo  Alias: ship-to-engine.bat  ^(bez argumentu = totez^)
echo ============================================
echo.

if not exist "node_modules\" call npm install

set EXTRA=
if /I "%~1"=="--dry-run" set EXTRA=%EXTRA% --dry-run
if /I "%~2"=="--dry-run" set EXTRA=%EXTRA% --dry-run
if /I "%~3"=="--dry-run" set EXTRA=%EXTRA% --dry-run
if /I "%~1"=="--no-default" set EXTRA=%EXTRA% --no-default
if /I "%~2"=="--no-default" set EXTRA=%EXTRA% --no-default
if /I "%~3"=="--no-default" set EXTRA=%EXTRA% --no-default

echo Spoustim: node scripts\ship-kit-to-engine.js --all%EXTRA%
echo.

node scripts\ship-kit-to-engine.js --all%EXTRA%
if errorlevel 1 (
  echo.
  echo Ship ALL FAILED.
  if /I "%~1"=="--no-pause" goto :eof
  if /I "%~2"=="--no-pause" goto :eof
  if /I "%~3"=="--no-pause" goto :eof
  pause
  exit /b 1
)

echo.
echo ============================================
echo Hotovo. Vsechny uvarene kity v Assets\Buildings\
echo ============================================
if /I "%~1"=="--no-pause" goto :eof
if /I "%~2"=="--no-pause" goto :eof
if /I "%~3"=="--no-pause" goto :eof
pause
