param([string]$CacheDirectory = '')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
if (-not $CacheDirectory) { $CacheDirectory = Join-Path $repoRoot '.cache/native3d/uv-atlas-native-v1' }
$cacheRoot = [IO.Path]::GetFullPath($CacheDirectory)
$sourceRoot = Join-Path $cacheRoot 'UVAtlas'
$buildRoot = Join-Path $cacheRoot 'runtime-build'
$commit = '3a7eaedb26dec6c1a5b5321692b6da2a6902cd4c'
New-Item -ItemType Directory -Force $cacheRoot | Out-Null
Get-Command cmake,git -ErrorAction Stop | Out-Null
if (-not (Test-Path -LiteralPath $sourceRoot)) {
    & git clone --no-checkout https://github.com/microsoft/UVAtlas.git $sourceRoot
    if ($LASTEXITCODE -ne 0) { throw 'UVAtlas source download failed' }
    & git -C $sourceRoot checkout --detach $commit
    if ($LASTEXITCODE -ne 0) { throw 'Pinned UVAtlas checkout failed' }
}
$actual = (& git -C $sourceRoot rev-parse HEAD).Trim()
if ($actual -ne $commit) { throw 'UVAtlas source is not the reviewed pinned commit; use a fresh cache directory' }
$dirty = & git -C $sourceRoot status --porcelain
if ($dirty) { throw 'UVAtlas source has local modifications; use a clean pinned source' }
& cmake -S (Join-Path $PSScriptRoot 'native3d-uvatlas') -B $buildRoot -G 'Visual Studio 17 2022' -A x64 "-DUVATLAS_SOURCE_DIR=$sourceRoot"
if ($LASTEXITCODE -ne 0) { throw 'UVAtlas CMake configuration failed; existing VS2022 C++ tools are required' }
& cmake --build $buildRoot --config Release --target patch --parallel 4
if ($LASTEXITCODE -ne 0) { throw 'UVAtlas native build failed' }
Write-Output (Join-Path $buildRoot 'Release/patch.exe')
