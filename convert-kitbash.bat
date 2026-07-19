@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================
echo  KitBash -^> Engine-Ready
echo  LOD0/1/2 + LOD3 boxcards (6-plane)
echo  NO ktx2 / max-texture 2048 / no legacy impostor
echo ============================================
echo.

if not exist "node_modules\" call npm install

set INPUT=%~1
if "%INPUT%"=="" set INPUT=.\Kitbash Assets\Manhattan\Office_Plaza.glb

if not defined LOD3_RES set "LOD3_RES=2048"

echo Input: %INPUT%
echo LOD3 : ON — 6-plane boxcards + MASK atlas (%LOD3_RES%px)
echo        vypnout: pridej --no-lod3-silhouette za convert
echo        legacy impostor: pridej --impostor (viz legacy\README.md)
echo        batch: convert-kitbash-all.bat  (CONVERT_JOBS=7)
echo.

call npm run convert -- --input "%INPUT%" --output ./output --no-ktx2 --max-texture 2048 --no-impostor --lod3-silhouette --lod3-res %LOD3_RES% --shared-textures --jobs 1

echo.
echo Hotovo. Vystup: output\^<AssetName^>\  (nebo output\^<Kit^>\^<Asset^>\)
echo   default.glb  lod0.glb  ^(external URI → _shared\textures\^)
echo   lod1.glb  lod2.glb
echo   lod3.glb + lod3_atlas\     ^(6-plane boxcards + MASK, embedded^)
echo   asset.json  ^(sharedTextures: true^)
echo   kit: output\^<Kit^>\_shared\textures\
echo.
echo Do enginu:
echo   ship-to-engine.bat Manhattan\Office_Plaza
echo   ve scene: Buildings\Manhattan\Office_Plaza\lod0.glb
pause
