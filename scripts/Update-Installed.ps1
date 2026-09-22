[CmdletBinding()]
param([string]$InstallDirectory = (Join-Path $env:USERPROFILE 'Applications\Framekeep'))
# Source-only update. Settings, library, registry and shortcuts are preserved.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Install-Common.ps1')
$root = Split-Path -Parent $PSScriptRoot
$app = Assert-FramekeepPath $InstallDirectory
$receipt = Assert-FramekeepReceipt $app
$null = Get-FramekeepExtensionId $root
Copy-FramekeepFiles $root $app
& (Join-Path $PSScriptRoot 'Build-Launcher.ps1') -Destination $app -Python $receipt.python
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
foreach ($pair in @{version=$version;source=$root;installDirectory=$app;installedAt=[DateTime]::UtcNow.ToString('o');files=(@((Get-FramekeepFiles).Keys) + @('Framekeep.exe','launcher.json','launcher-build.json','host.cmd','host-manifest.json'))}.GetEnumerator()) { $receipt | Add-Member -NotePropertyName $pair.Key -NotePropertyValue $pair.Value -Force }
Write-FramekeepJson (Join-Path $app 'framekeep-install.json') $receipt
Write-Output "Updated Framekeep to $version. Settings and saved media preserved: $app"
