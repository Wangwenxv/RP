@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [card] 正在扫描角色卡并生成预览...
node build-preview.cjs
if errorlevel 1 (
  echo.
  echo 生成失败，请检查上面的报错。
  pause
  exit /b 1
)
echo.
echo 正在打开预览...
start "" "preview.html"
