@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================
echo  KitBash ALL -^> Engine-Ready
echo  LOD + impostor + max-texture 2048
echo  NO atlas / ktx2
echo ============================================
echo.
echo  Bez argumentu = VSECHNY kity ve "Kitbash Assets"
echo  S argumentem  = jen ten kit, napr.:
echo    convert-kitbash-all.bat Manhattan
echo    convert-kitbash-all.bat Brooklyn
echo    convert-kitbash-all.bat "Every City"
echo.

if not exist "node_modules\" (
  echo npm install...
  call npm install
)

if not exist "Kitbash Assets\" (
  echo CHYBA: chybi slozka "Kitbash Assets"
  pause
  exit /b 1
)

set KIT=%~1

if "%KIT%"=="" (
  echo Mode: VSECHNY kity
  echo.
  call npm run convert -- --kits-root ".\Kitbash Assets" --output ./output --no-ktx2 --max-texture 2048 --impostor-res 2048 --impostor-frames 12
) else (
  echo Mode: jen kit "%KIT%"
  echo.
  call npm run convert -- --kits-root ".\Kitbash Assets" --only "%KIT%" --output ./output --no-ktx2 --max-texture 2048 --impostor-res 2048 --impostor-frames 12
)

echo.
echo ============================================
echo Hotovo.
echo   Budovy : output\^<Kit^>\^<Asset^>\  (lod0/1/2, default, impostor, asset.json)
echo   Textury: output\_textures\  (pokud --shared-textures)
echo.
echo Do enginu zkopiruj slozku budovy.
echo Ve scene odkazuj lod0.glb
echo Preview: gallery.bat
echo ============================================
pause
