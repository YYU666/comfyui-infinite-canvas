@echo off
setlocal
set "PORTABLE_ROOT=%~dp0.."
set "PYTHON=%PORTABLE_ROOT%\python_embeded\python.exe"
if not exist "%PYTHON%" (
  echo.
  echo 未找到 ComfyUI 便携版 Python：%PYTHON%
  echo 不会回退系统 Python。请检查便携版目录或传入正确路径。
  pause
  exit /b 1
)
"%PYTHON%" "%~dp0install.py" --comfy-root "%PORTABLE_ROOT%" %*
if errorlevel 1 (
  echo.
  echo 安装未完成，请查看上方错误信息。
  pause
  exit /b 1
)
echo.
echo 安装完成。之后双击 启动.vbs 启动工作台。
pause
