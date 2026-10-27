@echo off
setlocal
set "PYTHON=%~dp0..\python_embeded\python.exe"
if not exist "%PYTHON%" (
  echo 未找到 ComfyUI 便携版 Python。请把本仓库放在 ComfyUI_windows_portable 根目录内。
  pause
  exit /b 1
)
"%PYTHON%" "%~dp0video_workbench_launcher.py"
pause
