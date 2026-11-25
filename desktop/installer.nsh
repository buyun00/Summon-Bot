!macro customHeader
  !ifndef BUILD_UNINSTALLER
    SilentInstall silent
  !endif
!macroend

!macro customInit
  !ifndef BUILD_UNINSTALLER
    ${IfNot} ${isUpdated}
      Delete "$TEMP\summon-installer-handoff.ready"
      Delete "$TEMP\summon-installer-extracted.ready"
      File "/oname=$TEMP\summon-installer-splash.ps1" "${PROJECT_DIR}\installer-splash.ps1"
      System::Call 'shell32::ShellExecuteW(p 0, w "open", w "powershell.exe", w `-NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -File "$TEMP\summon-installer-splash.ps1" -InstDir "$INSTDIR" -ExtractedFile "$TEMP\summon-installer-extracted.ready" -SignalFile "$TEMP\summon-installer-handoff.ready"`, w "", i 0)'
    ${EndIf}
  !endif
!macroend

!macro customInstall
  !ifndef BUILD_UNINSTALLER
    ${IfNot} ${isUpdated}
      FileOpen $0 "$TEMP\summon-installer-extracted.ready" w
      FileWrite $0 "ok"
      FileClose $0
      Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --from-installer'
    ${Else}
      Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
    ${EndIf}
  !endif
!macroend
