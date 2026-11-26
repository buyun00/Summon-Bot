!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "& { param($$r) $$d = [IO.Path]::GetFullPath($$r).ToLowerInvariant(); Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.ToLowerInvariant().StartsWith($$d) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue } }" "$INSTDIR\summon-runtime"'
  Pop $0
  Pop $1
  Sleep 350
!macroend

!macro NSIS_HOOK_POSTINSTALL
  IfSilent 0 +2
    Exec '"$INSTDIR\${MAINBINARYNAME}.exe"'
!macroend
