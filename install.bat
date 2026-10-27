@echo off
setlocal
set "PORTABLE_ROOT=%~dp0.."
set "PYTHON=%PORTABLE_ROOT%\python_embeded\python.exe"
if not exist "%PYTHON%" (
  set "PYTHON=py"
  set "PYTHON_ARGS=-3"
)
"%PYTHON%" %PYTHON_ARGS% "%~dp0install.py" --comfy-root "%PORTABLE_ROOT%" %*
if errorlevel 1 (
  echo.
  echo 安装未完成，请查看上方错误信息。
  pause
  exit /b 1
)
echo.
echo 安装完成。之后双击 start.bat 启动工作台。
pause
