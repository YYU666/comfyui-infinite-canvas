@echo off
setlocal
set "PYTHON=%~dp0..\python_embeded\python.exe"
if defined H3_COMFY_ROOT set "PYTHON=%H3_COMFY_ROOT%\python_embeded\python.exe"
if not exist "%PYTHON%" (
  echo 未找到 ComfyUI 便携版 Python。请检查 ComfyUI 安装位置。
  pause
  exit /b 1
)
"%PYTHON%" "%~dp0video_workbench_launcher.py" --debug
pause
