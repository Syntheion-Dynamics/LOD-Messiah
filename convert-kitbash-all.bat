@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================
echo  KitBash ALL -^> Engine-Ready
echo  LOD + max-texture 2048
echo  NO atlas / ktx2 / impostor
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
  call npm run convert -- --kits-root ".\Kitbash Assets" --output ./output --no-impostor --no-ktx2 --max-texture 2048
) else (
  echo Mode: jen kit "%KIT%"
  echo.
  call npm run convert -- --kits-root ".\Kitbash Assets" --only "%KIT%" --output ./output --no-impostor --no-ktx2 --max-texture 2048
)

echo.
echo ============================================
echo Hotovo.
echo   Budovy : output\^<Kit^>\^<Asset^>\  (lod0/1/2, default, asset.json)
echo   Textury: output\_textures\
echo.
echo Do enginu zkopiruj:
echo   1) slozku budovy
echo   2) slozku _textures  (jako SOUROZENCE te budovy)
echo Ve scene odkazuj lod0.glb
echo ============================================
pause
