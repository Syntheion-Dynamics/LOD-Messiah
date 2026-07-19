@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================
echo  KitBash -^> Engine-Ready
echo  Atlas 1K + Permissive LOD + KTX2 + Impostor
echo ============================================
echo.

if not exist "node_modules\" call npm install

set INPUT=%~1
if "%INPUT%"=="" set INPUT=.\Kitbash Assets\Manhattan\Office_Plaza.glb

echo Input: %INPUT%
echo.

call npm run convert -- -i "%INPUT%" -o .\output --atlas --ktx2 --ratio 0.5,0.3,0.1 --impostor-mode octahedral --impostor-frames 8 --impostor-res 1024

echo.
echo Hotovo. Vystup: output\
echo Do enginu: lod0.glb  (+ impostor.glb daleko)
echo Preview: output\...\preview.html
pause
