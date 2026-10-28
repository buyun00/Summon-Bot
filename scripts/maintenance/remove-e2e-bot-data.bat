@echo off
title Relay Bot - remove E2E Bot data only
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0remove-e2e-bot-data.ps1"
set "cleanupExit=%ERRORLEVEL%"
echo.
pause
exit /b %cleanupExit%
