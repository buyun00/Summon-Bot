@echo off
title Relay Bot - remove development tests
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0remove-tests.ps1"
echo.
pause
