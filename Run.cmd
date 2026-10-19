@echo off
cd /d "%~dp0"
node src\server.mjs
if errorlevel 1 pause
