@echo off
setlocal
chcp 65001 >nul
node "%~dp0tools\wechat-voice-local.cjs" stop
set "VOICE_EXIT=%ERRORLEVEL%"
if not "%~1"=="--no-pause" pause
exit /b %VOICE_EXIT%
