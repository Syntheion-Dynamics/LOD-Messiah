@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================
echo  KitBash -^> Engine-Ready
echo  LOD + impostor + max-texture 2048
echo  (NO atlas / ktx2)
echo ============================================
echo.

if not exist "node_modules\" call npm install

set INPUT=%~1
if "%INPUT%"=="" set INPUT=.\Kitbash Assets\Manhattan\Office_Plaza.glb

echo Input: %INPUT%
echo.

call npm run convert -- --input "%INPUT%" --output ./output --no-ktx2 --max-texture 2048 --impostor-res 2048 --impostor-frames 12

echo.
echo Hotovo. Vystup: output\
echo   lod0/1/2.glb + default.glb + impostor.glb + asset.json
echo Do enginu: celou slozku zkopiruj, ve scene odkazuj lod0.glb
pause
