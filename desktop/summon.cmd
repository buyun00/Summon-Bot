@echo off
setlocal
"%~dp0resources\summon-runtime\runtime\node.exe" "%~dp0resources\summon-runtime\scripts\installation\desktop.mjs" %*
exit /b %errorlevel%
