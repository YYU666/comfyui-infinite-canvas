@echo off
setlocal
chcp 65001 >nul
set "PYTHON=%~dp0..\python_embeded\python.exe"
if not exist "%PYTHON%" set "PYTHON=C:\ComfyUI_windows_portable\python_embeded\python.exe"
if not exist "%PYTHON%" (
  echo 未找到 ComfyUI 便携版 Python。
  pause
  exit /b 1
)
"%PYTHON%" "%~dp0stop.py"
if errorlevel 1 pause
