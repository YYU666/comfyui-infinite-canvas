param(
    [string]$PythonPath = 'C:\ComfyUI_windows_portable\python_embeded\python.exe'
)

$ErrorActionPreference = 'Stop'
$developmentRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
    throw "找不到项目 Python，请通过 -PythonPath 指定已安装工作台依赖的 Python。"
}
if (-not (Test-Path -LiteralPath (Join-Path $developmentRoot 'dist\index.html'))) {
    throw '请先在开发工作区运行 npm ci 和 npm run build。'
}

# These paths are intentionally separate from the production runtime and projects.
# The projects directory contains saved work; do not treat it as disposable cache.
$env:H3_WORKBENCH_RUNTIME_DIR = Join-Path $developmentRoot '.cache\feature-dev\runtime'
$env:H3_WORKBENCH_DATA_DIR = Join-Path $developmentRoot '.cache\feature-dev\data'
$env:H3_PROJECTS_ROOT = Join-Path $developmentRoot '.cache\feature-dev\projects'
$env:H3_COMFY_URL = 'http://127.0.0.1:8199'
$env:H3_WORKBENCH_TEST_MODE = '1'
$env:H3_WORKBENCH_NO_BROWSER = '1'
$env:PYTHONUTF8 = '1'

Push-Location -LiteralPath $developmentRoot
try {
    & $PythonPath -X utf8 video_workbench_launcher.py --debug
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
