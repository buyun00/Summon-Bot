!macro NSIS_HOOK_POSTINSTALL
  IfSilent 0 +2
    Exec '"$INSTDIR\${MAINBINARYNAME}.exe"'
!macroend
