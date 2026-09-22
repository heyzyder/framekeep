[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Destination,[Parameter(Mandatory=$true)][string]$Python)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Install-Common.ps1')
& $Python -c "import sys,struct; assert sys.version_info >= (3, 11) and struct.calcsize('P') == 8, '64-bit Python 3.11+ is required'"
if ($LASTEXITCODE -ne 0) { throw 'The Windows x64 launcher requires 64-bit Python 3.11 or newer.' }
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskSource=Join-Path $taskRoot 'native\launcher.cs'
$taskIcon=Join-Path $taskRoot 'extension\icons\framekeep-app.ico'
$taskCompiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $taskCompiler)) {throw 'Windows .NET Framework 4 compiler is required for the desktop launcher.'}
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
$taskExe=Join-Path $Destination 'Framekeep.exe'
$taskStamp=Join-Path $Destination 'launcher-build.json'
$taskFingerprint=@{source=(Get-FramekeepSha256 $taskSource);icon=(Get-FramekeepSha256 $taskIcon)}
$taskPrevious=$null
if(Test-Path -LiteralPath $taskStamp){$taskPrevious=Get-Content -LiteralPath $taskStamp -Raw | ConvertFrom-Json}
if (-not (Test-Path -LiteralPath $taskExe) -or $taskPrevious.source -ne $taskFingerprint.source -or $taskPrevious.icon -ne $taskFingerprint.icon -or $taskPrevious.exe -ne (Get-FramekeepSha256 $taskExe)) {
    $taskPending=Join-Path $Destination 'Framekeep.pending.exe'
    & $taskCompiler /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll "/win32icon:$taskIcon" "/out:$taskPending" $taskSource
    if($LASTEXITCODE -ne 0){throw 'Framekeep launcher compilation failed.'}
    Move-Item -LiteralPath $taskPending -Destination $taskExe -Force
    $taskFingerprint.exe=Get-FramekeepSha256 $taskExe
    [IO.File]::WriteAllText($taskStamp,($taskFingerprint|ConvertTo-Json))
}
$taskDll=& $Python -c "import sys; from pathlib import Path; print(Path(sys.base_prefix) / ('python%d%d.dll' % sys.version_info[:2]))"
if(-not (Test-Path -LiteralPath $taskDll)){throw 'The global Python shared library is missing.'}
[IO.File]::WriteAllText((Join-Path $Destination 'launcher.json'),(@{python=$Python;dll=$taskDll}|ConvertTo-Json))
Write-Output "Stable desktop launcher: $taskExe"
