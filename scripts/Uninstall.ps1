[CmdletBinding()]
param([string]$InstallDirectory = (Join-Path $env:USERPROFILE 'Applications\Framekeep'), [switch]$RemoveSettings)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Install-Common.ps1')
$app = Assert-FramekeepPath $InstallDirectory
if (-not (Test-Path -LiteralPath $app)) { Write-Output 'Framekeep is not installed at that location.'; return }
$receipt = Assert-FramekeepReceipt $app
$name = $receipt.nativeHostName; if (-not $name) { $name = 'com.framekeep.downloader' }
if ($name -notmatch '^com\.framekeep\.[a-z][a-z0-9_.]*$') { throw 'Invalid recorded native host identity.' }
$registry = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$name"
if ($receipt.registered -ne $false) {
    Assert-FramekeepRegistrationContext
    if (Test-Path -LiteralPath $registry) {
        if ((Get-Item -LiteralPath $registry).GetValue('') -ne (Join-Path $app 'host-manifest.json')) { throw 'Native host registration belongs to another installation.' }
        Remove-Item -LiteralPath $registry
    }
}
if ($receipt.shortcuts) {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($path in $receipt.shortcuts) { if (Test-Path -LiteralPath $path) { $link = $shell.CreateShortcut($path); if ($link.TargetPath -eq (Join-Path $app 'Framekeep.exe')) { Remove-Item -LiteralPath $path } } }
}
# Delete only known application files, never downloaded media or recursive trees.
$files = @((Get-FramekeepFiles).Keys) + @('Framekeep.exe','launcher.json','launcher-build.json','host.cmd','host-manifest.json','desktop-health.json','ui\popup.js','ui\popup.html')
if ($RemoveSettings) { $files += @('config.json','desktop-settings.json') }
foreach ($relative in $files) {
    $file = Join-Path $app $relative
    $null = Assert-FramekeepPath $file
    if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file }
}
if ($RemoveSettings) { Remove-Item -LiteralPath (Join-Path $app 'framekeep-install.json') }
else {
    foreach ($pair in @{registered=$false;shortcuts=@();uninstalled=$true}.GetEnumerator()) { $receipt | Add-Member -NotePropertyName $pair.Key -NotePropertyValue $pair.Value -Force }
    Write-FramekeepJson (Join-Path $app 'framekeep-install.json') $receipt
}
foreach ($folder in @((Join-Path $app 'ui\icons'),(Join-Path $app 'ui'),$app)) { if ((Test-Path -LiteralPath $folder) -and @(Get-ChildItem -LiteralPath $folder -Force).Count -eq 0) { Remove-Item -LiteralPath $folder } }
Write-Output 'Framekeep application removed. Saved media and shared dependencies retained. Remove the extension at chrome://extensions.'
if (-not $RemoveSettings) { Write-Output "Settings retained in $app. Use -RemoveSettings during uninstall to remove only application settings." }
