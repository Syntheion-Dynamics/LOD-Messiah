@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================
echo  KitBash ALL -^> Engine-Ready
echo  LOD0/1/2 + LOD3 boxcards (6-plane)
echo  NO ktx2 / max-texture 2048 / no legacy impostor
echo  PARALLEL assets (CONVERT_JOBS)
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

if not defined LOD3_RES set "LOD3_RES=2048"
if not defined CONVERT_JOBS set "CONVERT_JOBS=7"

echo LOD3 : ON — boxcards %LOD3_RES%px atlas
echo JOBS : %CONVERT_JOBS% assets najednou (3800X: 5-7; GPU OOM → set CONVERT_JOBS=2)
echo.

set KIT=%~1

if "%KIT%"=="" (
  echo Mode: VSECHNY kity
  echo.
  call npm run convert -- --kits-root ".\Kitbash Assets" --output ./output --no-ktx2 --max-texture 2048 --no-impostor --lod3-silhouette --lod3-res %LOD3_RES% --shared-textures --jobs %CONVERT_JOBS%
) else (
  echo Mode: jen kit "%KIT%"
  echo.
  call npm run convert -- --kits-root ".\Kitbash Assets" --only "%KIT%" --output ./output --no-ktx2 --max-texture 2048 --no-impostor --lod3-silhouette --lod3-res %LOD3_RES% --shared-textures --jobs %CONVERT_JOBS%
)

echo.
echo ============================================
echo Hotovo.
echo   Budovy : output\^<Kit^>\^<Asset^>\
echo            lod0/1/2.glb  lod3.glb + lod3_atlas\  default.glb  asset.json
echo   Shared : output\^<Kit^>\_shared\textures\  ^(SHA1 PNG, once per kit^)
echo.
echo Jen LOD3 znovu: rebake-lod3-kitbash.bat
echo Preview: gallery.bat
echo ============================================
pause
