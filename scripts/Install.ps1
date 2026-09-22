[CmdletBinding()]
param(
    [string]$InstallDirectory = (Join-Path $env:USERPROFILE 'Applications\Framekeep'),
    [string]$DownloadDirectory,
    [string]$Python,
    [string]$Node,
    [string]$Ffmpeg,
    [ValidatePattern('^com\.framekeep\.[a-z][a-z0-9_.]*$')][string]$NativeHostName = 'com.framekeep.downloader',
    [ValidatePattern('^[a-p]{32}$')][string]$ExtensionId = 'mddibmfbdbahbimeclofpakiekckanio',
    [switch]$NoRegistration,
    [switch]$NoShortcuts,
    [switch]$SkipOptionalDependencies,
    [switch]$UpdateDownloader,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Install-Common.ps1')
$taskProject = Split-Path -Parent $PSScriptRoot
$taskApp = Assert-FramekeepPath $InstallDirectory
$sourceId = Get-FramekeepExtensionId $taskProject
if ($ExtensionId -ne $sourceId -and $NativeHostName -eq 'com.framekeep.downloader') { throw 'A test extension must use a separate native host name.' }
if ($taskApp -eq [IO.Path]::GetFullPath($taskProject)) { throw 'The install directory must be separate from the source.' }
if ((Test-Path -LiteralPath $taskApp) -and -not (Test-Path -LiteralPath (Join-Path $taskApp 'framekeep-install.json'))) { throw 'Existing unmanaged install directory. Choose an empty, new directory.' }
$previous = $null
if (Test-Path -LiteralPath (Join-Path $taskApp 'framekeep-install.json')) { $previous = Assert-FramekeepReceipt $taskApp }
if ($previous -and ($previous.extensionId -ne $ExtensionId -or ($previous.nativeHostName -and $previous.nativeHostName -ne $NativeHostName))) { throw 'Existing installation identity differs from the requested identity.' }
foreach ($entry in (Get-FramekeepFiles).Values) { if (-not (Test-Path -LiteralPath (Join-Path $taskProject $entry) -PathType Leaf)) { throw "Incomplete source: $entry" } }
if (-not $Python) { $Python = (Get-Command python.exe -ErrorAction Stop).Source }
if (-not $Node) { $Node = (Get-Command node.exe -ErrorAction Stop).Source }
if (-not $Ffmpeg) { $command = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue; if ($command) { $Ffmpeg = $command.Source } }
foreach ($runtime in @($Python,$Node)) { if (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) { throw "Runtime not found: $runtime" } }
if ($Ffmpeg -and -not (Test-Path -LiteralPath $Ffmpeg -PathType Leaf)) { throw 'FFmpeg executable was not found.' }
& $Python -c "import sys,struct; assert sys.version_info >= (3, 11) and struct.calcsize('P') == 8, '64-bit Python 3.11+ is required'"
if ($LASTEXITCODE -ne 0) { throw '64-bit Python 3.11 or newer is required.' }
if ([int]((& $Node --version).TrimStart('v').Split('.')[0]) -lt 22) { throw 'Node.js 22 or newer is required.' }
$availability = & $Python -c "import importlib.util,json; print(json.dumps({n:bool(importlib.util.find_spec(n)) for n in ['webview','yt_dlp','yt_dlp_ejs']}))" | ConvertFrom-Json
if (-not $DownloadDirectory) {
    if (Test-Path -LiteralPath (Join-Path $taskApp 'config.json')) { $DownloadDirectory = (Get-Content -LiteralPath (Join-Path $taskApp 'config.json') -Raw | ConvertFrom-Json).directory }
    else { $DownloadDirectory = Join-Path $env:USERPROFILE 'Downloads\Framekeep' }
}
$DownloadDirectory = [IO.Path]::GetFullPath($DownloadDirectory)
if ($DownloadDirectory -eq $taskApp -or $DownloadDirectory.StartsWith($taskApp + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Keep saved media outside the application directory.' }
$plan = [ordered]@{installDirectory=$taskApp;downloadDirectory=$DownloadDirectory;python=$Python;node=$Node;ffmpeg=$Ffmpeg;dependencies=$availability;nativeHostName=$NativeHostName;extensionId=$ExtensionId;register=(-not $NoRegistration);shortcuts=(-not $NoShortcuts)}
if ($CheckOnly) { $plan | ConvertTo-Json -Depth 4; return }
if (-not $NoRegistration -or -not $NoShortcuts) { Assert-FramekeepRegistrationContext }
$registry = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$NativeHostName"
$hostManifest = Join-Path $taskApp 'host-manifest.json'
if (-not $NoRegistration -and (Test-Path -LiteralPath $registry) -and (Get-Item -LiteralPath $registry).GetValue('') -ne $hostManifest) { throw 'The native host is registered to another installation. Use that directory to update it, or use an isolated host name.' }
if (-not $SkipOptionalDependencies) {
    Push-Location -LiteralPath $env:USERPROFILE
    try {
        if (-not $availability.webview) { & $Python -m pip install --user --no-cache-dir 'pywebview>=6.2.1,<7'; if ($LASTEXITCODE -ne 0) { throw 'Could not install the user-level desktop UI dependency.' } }
        if (-not $availability.yt_dlp -or -not $availability.yt_dlp_ejs -or $UpdateDownloader) { & $Python -m pip install --user --no-cache-dir --upgrade 'yt-dlp[default]'; if ($LASTEXITCODE -ne 0) { throw 'Could not install the user-level downloader dependency.' } }
    } finally { Pop-Location }
}
New-Item -ItemType Directory -Path $taskApp -Force | Out-Null
Copy-FramekeepFiles $taskProject $taskApp
& (Join-Path $PSScriptRoot 'Build-Launcher.ps1') -Destination $taskApp -Python $Python
if (Test-Path -LiteralPath (Join-Path $taskApp 'config.json')) { $config = Get-Content -LiteralPath (Join-Path $taskApp 'config.json') -Raw | ConvertFrom-Json }
else { $config = [pscustomobject]@{} }
foreach ($pair in @{node=$Node;ffmpeg=$Ffmpeg;directory=$DownloadDirectory;allowedExtensionId=$ExtensionId}.GetEnumerator()) { $config | Add-Member -NotePropertyName $pair.Key -NotePropertyValue $pair.Value -Force }
Write-FramekeepJson (Join-Path $taskApp 'config.json') $config
$hostCommand = '@echo off' + "`r`n" + '"' + $Python + '" -B "' + (Join-Path $taskApp 'host.py') + '" %*' + "`r`n"
[IO.File]::WriteAllText((Join-Path $taskApp 'host.cmd'),$hostCommand,[Text.Encoding]::Default)
Write-FramekeepJson $hostManifest @{name=$NativeHostName;description='Framekeep local media helper';path=(Join-Path $taskApp 'host.cmd');type='stdio';allowed_origins=@("chrome-extension://$ExtensionId/")}
$shortcuts = @()
if ($previous -and $previous.shortcuts) { $shortcuts = @($previous.shortcuts) }
if (-not $NoShortcuts) {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($folder in @($shell.SpecialFolders.Item('Programs'),$shell.SpecialFolders.Item('Desktop'))) {
        $linkPath = Join-Path $folder 'Framekeep.lnk'
        if (Test-Path -LiteralPath $linkPath) { $existing = $shell.CreateShortcut($linkPath); if ($existing.TargetPath -ne (Join-Path $taskApp 'Framekeep.exe')) { throw 'A Framekeep shortcut belongs to another installation.' } }
        $link = $shell.CreateShortcut($linkPath); $link.TargetPath = Join-Path $taskApp 'Framekeep.exe'; $link.WorkingDirectory = $taskApp; $link.IconLocation = $link.TargetPath + ',0'; $link.Description = 'Framekeep media library'; $link.Save(); Set-FramekeepShortcutIdentity $linkPath; $shortcuts += $linkPath
    }
}
if (-not $NoRegistration) { New-Item -Path $registry -Force | Out-Null; Set-Item -LiteralPath $registry -Value $hostManifest }
$manifest = Get-Content -LiteralPath (Join-Path $taskProject 'extension\manifest.json') -Raw | ConvertFrom-Json
$version = (Get-Content -LiteralPath (Join-Path $taskProject 'package.json') -Raw | ConvertFrom-Json).version
$ownedFiles = @((Get-FramekeepFiles).Keys) + @('Framekeep.exe','launcher.json','launcher-build.json','host.cmd','host-manifest.json')
$registered = (-not $NoRegistration) -or ($previous -and $previous.registered -eq $true)
Write-FramekeepJson (Join-Path $taskApp 'framekeep-install.json') @{name='Framekeep';version=$version;extensionVersion=$manifest.version;extensionId=$ExtensionId;nativeHostName=$NativeHostName;python=$Python;installDirectory=$taskApp;installedAt=[DateTime]::UtcNow.ToString('o');source=$taskProject;registered=$registered;shortcuts=@($shortcuts | Select-Object -Unique);files=$ownedFiles}
Write-Output "Framekeep $version installed: $taskApp"
Write-Output "Saved media: $DownloadDirectory"
Write-Output ('Chrome: enable Developer mode at chrome://extensions, Load unpacked, select ' + (Join-Path $taskProject 'extension'))
if (-not $Ffmpeg) { Write-Warning 'FFmpeg is unavailable. Install it at user or machine scope and rerun setup to enable video/audio conversion.' }
if ($SkipOptionalDependencies -and -not $availability.webview) { Write-Warning 'Desktop requires pywebview; this source-only test installation cannot launch its window yet.' }
