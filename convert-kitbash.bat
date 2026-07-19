@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================
echo  KitBash -^> Engine-Ready
echo  LOD + max-texture 2048  (NO atlas/ktx2/impostor)
echo ============================================
echo.

if not exist "node_modules\" call npm install

set INPUT=%~1
if "%INPUT%"=="" set INPUT=.\Kitbash Assets\Manhattan\Office_Plaza.glb

echo Input: %INPUT%
echo.

call npm run convert -- --input "%INPUT%" --output ./output --no-impostor --no-ktx2 --max-texture 2048

echo.
echo Hotovo. Vystup: output\
echo Do enginu: celou slozku zkopiruj, ve scene odkazuj lod0.glb
pause
