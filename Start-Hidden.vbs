Option Explicit
Dim shell, files, root, command, argument, result
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
command = Quote(shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")) & " -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Quote(root & "\Start.ps1")
For Each argument In WScript.Arguments
    command = command & " " & Quote(argument)
Next
' Wait so Task Scheduler owns the launcher and its watchdog for their full lifetime.
result = shell.Run(command, 0, True)
WScript.Quit result

Function Quote(value)
    Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
