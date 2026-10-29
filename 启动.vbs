Option Explicit
Dim shell, fso, root, comfyRoot, pythonw, launcher
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
comfyRoot = shell.Environment("PROCESS").Item("H3_COMFY_ROOT")
If comfyRoot = "" Then comfyRoot = fso.GetParentFolderName(root)
pythonw = fso.BuildPath(comfyRoot, "python_embeded\pythonw.exe")
launcher = fso.BuildPath(root, "video_workbench_launcher.py")
If Not fso.FileExists(pythonw) Then
  MsgBox "ComfyUI portable pythonw.exe was not found. Check the ComfyUI installation path.", 16, "Refmuse Local Workbench"
  WScript.Quit 1
End If
shell.CurrentDirectory = root
shell.Run Chr(34) & pythonw & Chr(34) & " " & Chr(34) & launcher & Chr(34), 0, False
