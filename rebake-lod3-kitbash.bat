@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

echo ============================================
echo  KitBash LOD3 silhouette rebake (v2)
echo  Source : default.glb  (fallback Kitbash .glb)
echo  Output : output\^<Kit^>\^<Asset^>\lod3.glb + lod3_atlas\
echo  Kits   : Manhattan / Every City / Brooklyn
echo ============================================
echo.
echo  Bez argumentu = tyto tri kity z "Kitbash Assets"
echo  S argumentem  = jen ty kity, napr.:
echo    rebake-lod3-kitbash.bat
echo    rebake-lod3-kitbash.bat Manhattan
echo    rebake-lod3-kitbash.bat Brooklyn "Every City"
echo.
echo  Paralelne: LOD3_JOBS=2 (default) — 3800X klidne 2-3
echo    set LOD3_JOBS=3
echo  Vzdy --force (prepise existujici lod3.glb)
echo  Ctrl+C ukonci.
echo.

if not exist "node_modules\" call npm install

if not exist "Kitbash Assets\" (
  echo CHYBA: chybi "Kitbash Assets"
  pause
  exit /b 1
)

rem Optional overrides:
rem   set LOD3_RES=2048
rem   set LOD3_SLICES=8
rem   set LOD3_JOBS=2
if not defined LOD3_RES set "LOD3_RES=2048"
if not defined LOD3_SLICES set "LOD3_SLICES=8"
if not defined LOD3_JOBS set "LOD3_JOBS=2"
echo  Settings: RES=%LOD3_RES%  SLICES=%LOD3_SLICES%  JOBS=%LOD3_JOBS%
echo.

if "%~1"=="" (
  echo Mode: Manhattan + Every City + Brooklyn
  echo.
  call npm run rebake:lod3 -- --force --jobs %LOD3_JOBS% Manhattan "Every City" Brooklyn
) else (
  echo Mode: %*
  echo.
  call npm run rebake:lod3 -- --force --jobs %LOD3_JOBS% %*
)

echo.
echo Hotovo. Vystup: output\^<Kit^>\^<Asset^>\lod3.glb
echo Preview: gallery.bat
pause
