@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

echo ============================================
echo  Ship cooked asset(s) -^> Bungac Assets
echo  default + lod0/1/2/3 + asset.json + atlasy
echo  (+ kit _shared/ kdyz existuje)
echo ============================================
echo.
echo  Bez argumentu / --all = VSECHNY slozky v
echo    "Kitbash Assets"  ^(Arch Vogue, Brooklyn, ...^)
echo  Cely kit:
echo    ship-to-engine.bat Brooklyn
echo  Jeden asset:
echo    ship-to-engine.bat Manhattan\Office_Plaza
echo  Interaktivne: kitbash-pick.bat
echo  Opt: --dry-run  --no-default  --no-pause
echo ============================================
echo.

if not exist "node_modules\" call npm install

set EXTRA=
set MODE=all
set REL=

:parse
if "%~1"=="" goto :run
if /I "%~1"=="--all" (
  set MODE=all
  shift
  goto :parse
)
if /I "%~1"=="--dry-run" (
  set EXTRA=!EXTRA! --dry-run
  shift
  goto :parse
)
if /I "%~1"=="--no-default" (
  set EXTRA=!EXTRA! --no-default
  shift
  goto :parse
)
if /I "%~1"=="--no-pause" (
  set NOPAUSE=1
  shift
  goto :parse
)
REM prvni ne-flag = jeden asset Kit\Asset
set MODE=one
set REL=%~1
shift
goto :parse

:run
if /I "%MODE%"=="all" (
  echo Mode: ALL kits from "Kitbash Assets"
  if not "!EXTRA!"=="" echo Extra:!EXTRA!
  echo.
  node scripts\ship-kit-to-engine.js --all!EXTRA!
  goto :after_ship
)

REM Cesta s \ nebo / = jeden asset; jinak cele jmeno kitu
set "HASPATH="
echo.%REL%| findstr /R "[\\/]" >nul && set "HASPATH=1"

if defined HASPATH (
  echo Asset: %REL%
  if not "!EXTRA!"=="" echo Mode:!EXTRA!
  echo.
  node scripts\ship-to-engine.js "%REL%"!EXTRA!
) else if exist "Kitbash Assets\%REL%\" (
  echo Kit: %REL%
  if not "!EXTRA!"=="" echo Mode:!EXTRA!
  echo.
  node scripts\ship-kit-to-engine.js "%REL%"!EXTRA!
) else if exist "output\%REL%\" (
  echo Kit: %REL% ^(z output^)
  if not "!EXTRA!"=="" echo Mode:!EXTRA!
  echo.
  node scripts\ship-kit-to-engine.js "%REL%"!EXTRA!
) else (
  echo Asset: %REL%
  if not "!EXTRA!"=="" echo Mode:!EXTRA!
  echo.
  node scripts\ship-to-engine.js "%REL%"!EXTRA!
)

:after_ship
if errorlevel 1 (
  echo.
  echo Ship FAILED.
  if defined NOPAUSE goto :eof
  pause
  exit /b 1
)

echo.
if /I "%MODE%"=="all" (
  echo Hotovo. Ve scene: Buildings\^<Kit^>\^<Asset^>\lod0.glb
) else if not defined HASPATH (
  echo Hotovo. Ve scene: Buildings\%REL%\^<Asset^>\lod0.glb
) else (
  echo Hotovo. Ve scene odkazuj: Buildings\%REL%\lod0.glb
  echo NE Buildings\%REL%.glb  ^(raw KitBash = vice budov v jednom^)
  echo default.glb vedle lod0 = close-up LOD0
)
if defined NOPAUSE goto :eof
pause
