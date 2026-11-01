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
set "INSTALL_EXIT=%ERRORLEVEL%"
if not "%INSTALL_EXIT%"=="0" (
  echo.
  echo 安装未完成，请查看上方错误信息。
  pause
  exit /b %INSTALL_EXIT%
)
echo.
echo 本次请求的安装步骤已完成；工作台离线和在线验收尚未运行。
echo 请按安装器提示执行 verify_workbench.py 验收。
pause
