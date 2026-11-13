Option Explicit
Dim shell, fso, root, comfyRoot, workbenchPort, pythonw, launcher
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
' H3_COMFY_ROOT is the directory that contains python_embeded\pythonw.exe.
' For an official isolated launch that directory is the managed Python runtime,
' not a ComfyUI portable root. Comfy startup is H3_COMFY_AUTOSTART, not this lookup.
comfyRoot = Trim(shell.Environment("PROCESS").Item("H3_COMFY_ROOT"))
workbenchPort = Trim(shell.Environment("PROCESS").Item("H3_WORKBENCH_PORT"))
If comfyRoot = "" Then
  If workbenchPort <> "" Then
    MsgBox "H3_WORKBENCH_PORT is set, but H3_COMFY_ROOT is empty. Official isolated launch will not use the parent of the install directory. Set H3_COMFY_ROOT to the directory that contains python_embeded\pythonw.exe.", 16, "Refmuse Local Workbench"
    WScript.Quit 1
  End If
  comfyRoot = fso.GetParentFolderName(root)
End If
pythonw = fso.BuildPath(comfyRoot, "python_embeded\pythonw.exe")
launcher = fso.BuildPath(root, "video_workbench_launcher.py")
If Not fso.FileExists(pythonw) Then
  MsgBox "ComfyUI portable pythonw.exe was not found. Check the ComfyUI installation path.", 16, "Refmuse Local Workbench"
  WScript.Quit 1
End If
shell.CurrentDirectory = root
shell.Run Chr(34) & pythonw & Chr(34) & " " & Chr(34) & launcher & Chr(34), 0, False
