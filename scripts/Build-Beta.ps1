[CmdletBinding()]
param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
# Uses only existing user/machine runtimes. This command installs nothing.
& node (Join-Path $PSScriptRoot 'check.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Source checks failed.' }
if ($OutputDirectory) { & python -B (Join-Path $PSScriptRoot 'package_source.py') $root --output $OutputDirectory }
else { & python -B (Join-Path $PSScriptRoot 'package_source.py') $root }
if ($LASTEXITCODE -ne 0) { throw 'Beta packaging failed.' }
