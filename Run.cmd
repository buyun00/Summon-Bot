@echo off
start "" "%SystemRoot%\System32\wscript.exe" //B //NoLogo "%~dp0Start-Hidden.vbs" %*
