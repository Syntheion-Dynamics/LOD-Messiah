@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================
echo  Ship ALL KitBash kits -^> Bungac Assets
echo  Manhattan + Brooklyn + Every City
echo  default.glb + lod0/1/2/3 + atlasy + _shared/
echo ============================================
echo.
echo  Scena: Buildings\^<Kit^>\^<Asset^>\lod0.glb
echo  default.glb vedle = close-up (engine LOD0)
echo  _shared\textures\ = sdilene textury (jednou za kit)
echo.
echo  Opt: --dry-run   --no-default   --no-pause
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

set FAILED=0

echo.
echo --- Manhattan ---
node scripts\ship-kit-to-engine.js Manhattan%EXTRA%
if errorlevel 1 set FAILED=1

echo.
echo --- Brooklyn ---
node scripts\ship-kit-to-engine.js Brooklyn%EXTRA%
if errorlevel 1 set FAILED=1

echo.
echo --- Every City ---
node scripts\ship-kit-to-engine.js "Every City"%EXTRA%
if errorlevel 1 set FAILED=1

echo.
if "%FAILED%"=="1" (
  echo Ship ALL FAILED ^(alespon jeden kit^).
  if /I "%~1"=="--no-pause" goto :eof
  if /I "%~2"=="--no-pause" goto :eof
  if /I "%~3"=="--no-pause" goto :eof
  pause
  exit /b 1
)

echo ============================================
echo Hotovo. Vsechny kity v Assets\Buildings\
echo   Manhattan\  Brooklyn\  Every City\
echo   + _shared\textures\ u kazdeho kitu
echo ============================================
if /I "%~1"=="--no-pause" goto :eof
if /I "%~2"=="--no-pause" goto :eof
if /I "%~3"=="--no-pause" goto :eof
pause
