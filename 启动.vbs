Option Explicit
Dim shell, fso, root, pythonw, launcher
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
pythonw = fso.BuildPath(fso.GetParentFolderName(root), "python_embeded\pythonw.exe")
If Not fso.FileExists(pythonw) Then
  pythonw = "C:\ComfyUI_windows_portable\python_embeded\pythonw.exe"
End If
launcher = fso.BuildPath(root, "video_workbench_launcher.py")
If Not fso.FileExists(pythonw) Then
  MsgBox "ComfyUI portable pythonw.exe was not found. Check the ComfyUI installation path.", 16, "H3 Workbench"
  WScript.Quit 1
End If
shell.CurrentDirectory = root
shell.Run Chr(34) & pythonw & Chr(34) & " " & Chr(34) & launcher & Chr(34), 0, False
