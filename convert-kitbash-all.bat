@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================
echo  KitBash ALL -^> Engine-Ready
echo  LOD0/1/2 + LOD3 height-slice + impostor
echo  NO ktx2 / max-texture 2048 / impostor 4096x16
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

rem LOD3 + parallel defaults (override before run if needed):
if not defined LOD3_RES set "LOD3_RES=2048"
if not defined LOD3_SLICES set "LOD3_SLICES=8"
if not defined LOD3_METHOD set "LOD3_METHOD=visual-hull"
if not defined CONVERT_JOBS set "CONVERT_JOBS=7"

echo LOD3 : ON — %LOD3_METHOD% %LOD3_RES%px (fallback slices)
echo JOBS : %CONVERT_JOBS% assets najednou (3800X: 5-7; GPU OOM → set CONVERT_JOBS=2)
echo.

set KIT=%~1

if "%KIT%"=="" (
  echo Mode: VSECHNY kity
  echo.
  call npm run convert -- --kits-root ".\Kitbash Assets" --output ./output --no-ktx2 --max-texture 2048 --impostor-res 4096 --impostor-frames 16 --lod3-silhouette --lod3-res %LOD3_RES% --lod3-slices %LOD3_SLICES% --lod3-method %LOD3_METHOD% --jobs %CONVERT_JOBS%
) else (
  echo Mode: jen kit "%KIT%"
  echo.
  call npm run convert -- --kits-root ".\Kitbash Assets" --only "%KIT%" --output ./output --no-ktx2 --max-texture 2048 --impostor-res 4096 --impostor-frames 16 --lod3-silhouette --lod3-res %LOD3_RES% --lod3-slices %LOD3_SLICES% --lod3-method %LOD3_METHOD% --jobs %CONVERT_JOBS%
)

echo.
echo ============================================
echo Hotovo.
echo   Budovy : output\^<Kit^>\^<Asset^>\
echo            lod0/1/2.glb  lod3.glb + lod3_atlas\  default.glb  impostor  asset.json
echo.
echo Jen LOD3 znovu: rebake-lod3-kitbash.bat
echo Preview: gallery.bat
echo ============================================
pause
