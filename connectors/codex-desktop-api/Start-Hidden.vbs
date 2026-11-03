Option Explicit
Dim shell, files, root, command, result
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
command = Chr(34) & shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe") & Chr(34) & " -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Chr(34) & root & "\Start.ps1" & Chr(34)
result = shell.Run(command, 0, True)
If result <> 0 Then shell.Popup "Codex connector did not start. See D:\Relay-Bot-data\connectors\codex-desktop-api\startup.log", 0, "Summon Bot", 16
WScript.Quit result
