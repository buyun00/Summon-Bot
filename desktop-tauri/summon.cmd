@echo off
setlocal
"%~dp0summon-runtime\runtime\node.exe" "%~dp0summon-runtime\scripts\installation\desktop.mjs" %*
exit /b %errorlevel%
