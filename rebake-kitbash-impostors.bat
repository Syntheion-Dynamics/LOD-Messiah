@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

echo ============================================
echo  KitBash impostor-only rebake
echo  Source : default.glb (fallback lod0)
echo  Atlas  : 4096px / 16x16 + 2x SS
echo ============================================
echo.
echo  Bez argumentu = vsechny kity z "Kitbash Assets"
echo  S argumentem  = jen ty kity, napr.:
echo    rebake-kitbash-impostors.bat Manhattan
echo    rebake-kitbash-impostors.bat Brooklyn "Every City"
echo.
echo  Pozaduje uz uvarene output\^<Kit^>\^<Asset^>\default.glb
echo  Ctrl+C ukonci.
echo.

if not exist "node_modules\" call npm install

if not exist "output\" (
  echo CHYBA: chybi output\ — nejdriv spust convert-kitbash-all.bat
  pause
  exit /b 1
)

set "IMPOSTOR_RES=4096"
set "IMPOSTOR_FRAMES=16"

if "%~1"=="" (
  if not exist "Kitbash Assets\" (
    echo CHYBA: chybi "Kitbash Assets" — zadej kity rucne jako argumenty
    pause
    exit /b 1
  )
  set "KITS="
  for /d %%D in ("Kitbash Assets\*") do (
    set "KITS=!KITS! "%%~nxD""
  )
  echo Mode: VSECHNY kity!KITS!
  echo.
  call npm run rebake:impostors -- --force !KITS!
) else (
  echo Mode: %*
  echo.
  call npm run rebake:impostors -- --force %*
)

echo.
echo Hotovo. Preview: gallery.bat
pause
