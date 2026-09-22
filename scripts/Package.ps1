$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
& python -B (Join-Path $PSScriptRoot 'package_source.py') $packageRoot
if ($LASTEXITCODE -ne 0) { throw 'Source packaging failed.' }
