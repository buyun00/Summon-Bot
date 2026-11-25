!macro customHeader
  !ifndef BUILD_UNINSTALLER
    SilentInstall silent
  !endif
!macroend

!macro customInit
  !ifndef BUILD_UNINSTALLER
    ${IfNot} ${isUpdated}
      Delete "$TEMP\summon-installer-handoff.ready"
      File "/oname=$TEMP\summon-installer-splash.ps1" "${PROJECT_DIR}\installer-splash.ps1"
      System::Call 'shell32::ShellExecuteW(p 0, w "open", w "powershell.exe", w `-NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -File "$TEMP\summon-installer-splash.ps1" -InstDir "$INSTDIR" -SignalFile "$TEMP\summon-installer-handoff.ready"`, w "", i 0)'
    ${EndIf}
  !endif
!macroend

!macro customInstall
  !ifndef BUILD_UNINSTALLER
    ${IfNot} ${isUpdated}
      Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --from-installer'
    ${EndIf}
  !endif
!macroend
