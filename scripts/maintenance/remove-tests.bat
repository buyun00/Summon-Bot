@echo off
title Summon Bot - remove development tests
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0remove-tests.ps1"
echo.
pause
