@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================
echo  KitBash -^> Engine-Ready
echo  LOD0/1/2 + LOD3 height-slice + impostor
echo  NO ktx2 / max-texture 2048 / impostor 4096x16
echo ============================================
echo.

if not exist "node_modules\" call npm install

set INPUT=%~1
if "%INPUT%"=="" set INPUT=.\Kitbash Assets\Manhattan\Office_Plaza.glb

rem LOD3 v2 defaults (override before run if needed):
if not defined LOD3_RES set "LOD3_RES=2048"
if not defined LOD3_SLICES set "LOD3_SLICES=8"

echo Input: %INPUT%
echo LOD3 : ON — height-slice + MASK  (%LOD3_RES%px, ≤%LOD3_SLICES% A(z) bands)
echo        vypnout: pridej --no-lod3-silhouette za convert
echo        batch: convert-kitbash-all.bat  (CONVERT_JOBS=7)
echo.

if not defined LOD3_METHOD set "LOD3_METHOD=visual-hull"
call npm run convert -- --input "%INPUT%" --output ./output --no-ktx2 --max-texture 2048 --impostor-res 4096 --impostor-frames 16 --lod3-silhouette --lod3-res %LOD3_RES% --lod3-slices %LOD3_SLICES% --lod3-method %LOD3_METHOD% --jobs 1

echo.
echo Hotovo. Vystup: output\^<AssetName^>\  (nebo output\^<Kit^>\^<Asset^>\)
echo   default.glb
echo   lod0.glb  lod1.glb  lod2.glb
echo   lod3.glb + lod3_atlas\     ^(height-slice silhouette + MASK^)
echo   asset.json  (+ impostor.glb pokud OK)
echo.
echo Do enginu:
echo   ship-to-engine.bat Manhattan\Office_Plaza
echo   ve scene: Buildings\Manhattan\Office_Plaza\lod0.glb
pause
