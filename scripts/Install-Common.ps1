# Shared installation helpers. Importing this script has no side effects.
$ErrorActionPreference = 'Stop'
function Get-FramekeepSha256([string]$Path) {
    # Use .NET directly: Explorer-launched Windows PowerShell may inherit a
    # different PSModulePath from the invoking terminal.
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','') }
    finally { $sha.Dispose(); $stream.Dispose() }
}
function Get-FramekeepExtensionId([string]$Root) {
    $manifest = Get-Content -LiteralPath (Join-Path $Root 'extension\manifest.json') -Raw | ConvertFrom-Json
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hex = ([BitConverter]::ToString($sha.ComputeHash([Convert]::FromBase64String($manifest.key)))).Replace('-','').ToLower().Substring(0,32) } finally { $sha.Dispose() }
    $id = -join ($hex.ToCharArray() | ForEach-Object { [char](97 + [Convert]::ToInt32([string]$_,16)) })
    if ($id -ne 'mddibmfbdbahbimeclofpakiekckanio') { throw 'The source extension identity is not recognized.' }
    return $id
}
function Assert-FramekeepPath([string]$Path) {
    if (-not [IO.Path]::IsPathRooted($Path)) { throw 'Use an absolute local installation path.' }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($full.StartsWith('\\') -or $full -eq [IO.Path]::GetPathRoot($full).TrimEnd('\') -or $full -eq $env:USERPROFILE -or $full -eq $env:WINDIR) { throw 'Choose a dedicated local Framekeep directory.' }
    $item = $full
    while ($item) {
        if ((Test-Path -LiteralPath $item) -and ((Get-Item -LiteralPath $item -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Linked installation paths are not supported: $item" }
        $item = Split-Path -Parent $item
    }
    return $full
}
function Get-FramekeepFiles {
    $files = [ordered]@{}
    foreach ($name in @('host.py','recycle.py','desktop.pyw','desktop_bridge.py','windows_identity.py','page_source.py','browser_sources.py','media_capture.py','podcast_audio.py','wrapped_hls.py','library_state.py','media_preview.py','study_adapter.py','framekeep_cli.py','framekeep_mcp.py','platforms.json')) { $files[$name] = "native\$name" }
    foreach ($name in @('desktop.html','desktop.css','desktop.js','design.css','transport.js','ui-icons.js','shared.js','view.js')) { $files["ui\$name"] = "extension\$name" }
    foreach ($name in @('icon48.png','icon128.png')) { $files["ui\icons\$name"] = "extension\icons\$name" }
    foreach ($name in @('framekeep.ico','framekeep-app.ico','icon128.png')) { $files[$name] = "extension\icons\$name" }
    return $files
}
function Test-FramekeepCloudTag([uint32]$Tag) {
    # IO_REPARSE_TAG_CLOUD and CLOUD_1 through CLOUD_F are data placeholders,
    # unlike name-surrogate tags (symlink/junction) which redirect a pathname.
    return (($Tag -band [Convert]::ToUInt32('FFFF0FFF',16)) -eq [Convert]::ToUInt32('9000001A',16))
}
function Assert-FramekeepSourceFile([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.LinkType -or $item.Target) { throw 'Linked source file refused.' }
    if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
    # Inspect only the tag; never emit opaque cloud-provider reparse metadata.
    $record = & (Join-Path $env:WINDIR 'System32\fsutil.exe') reparsepoint query $Path 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Cannot verify source reparse type.' }
    $match = [regex]::Match(($record -join "`n"), '0x([0-9a-fA-F]{8})')
    if (-not $match.Success -or -not (Test-FramekeepCloudTag ([Convert]::ToUInt32($match.Groups[1].Value,16)))) { throw 'Unrecognized or redirecting source reparse type refused.' }
}
function Copy-FramekeepFiles([string]$Root, [string]$Destination) {
    $files = Get-FramekeepFiles
    foreach ($target in $files.Keys) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $files[$target]) -PathType Leaf)) { throw "Incomplete Framekeep source: $($files[$target])" }
        $null = Assert-FramekeepPath (Join-Path $Destination $target)
    }
    foreach ($target in $files.Keys) {
        $source = Join-Path $Root $files[$target]
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Incomplete Framekeep source: $($files[$target])" }
        Assert-FramekeepSourceFile $source
        $output = Join-Path $Destination $target
        $null = Assert-FramekeepPath $output
        New-Item -ItemType Directory -Path (Split-Path -Parent $output) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $output -Force
        if ((Get-FramekeepSha256 $source) -ne (Get-FramekeepSha256 $output)) { throw "Installed file verification failed: $target" }
    }
}
function Write-FramekeepJson([string]$Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
}
function Assert-FramekeepReceipt([string]$Directory) {
    $null = Assert-FramekeepPath $Directory
    $receipt = Get-Content -LiteralPath (Join-Path $Directory 'framekeep-install.json') -Raw | ConvertFrom-Json
    if ($receipt.name -ne 'Framekeep' -or $receipt.extensionId -notmatch '^[a-p]{32}$') { throw 'Unrecognized Framekeep installation.' }
    if ($receipt.installDirectory -and [IO.Path]::GetFullPath($receipt.installDirectory) -ne $Directory) { throw 'Installation receipt belongs to another directory.' }
    return $receipt
}
function Assert-FramekeepRegistrationContext {
    if (-not ('FramekeepPackageContext' -as [type])) {
        Add-Type @'
using System; using System.Runtime.InteropServices;
public static class FramekeepPackageContext {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern int GetCurrentPackageFullName(ref uint size, IntPtr name);
}
'@
    }
    $size = [uint32]0
    if ([FramekeepPackageContext]::GetCurrentPackageFullName([ref]$size,[IntPtr]::Zero) -ne 15700) { throw 'Run Install Framekeep.cmd from File Explorer or a regular PowerShell window for normal Chrome registration. Packaged terminals can redirect registry writes. Isolated testing supports -NoRegistration -NoShortcuts and an explicit -InstallDirectory.' }
}
function Set-FramekeepShortcutIdentity([string]$Path) {
    if (-not ('FramekeepShortcutIdentity' -as [type])) {
        Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FramekeepShortcutIdentity {
    [StructLayout(LayoutKind.Sequential)] public struct Key { public Guid format; public uint id; }
    [StructLayout(LayoutKind.Explicit, Size=24)] public struct Value { [FieldOffset(0)] public ushort type; [FieldOffset(8)] public IntPtr text; }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface Store {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out Key key);
        [PreserveSig] int GetValue(ref Key key, out Value value);
        [PreserveSig] int SetValue(ref Key key, ref Value value);
        [PreserveSig] int Commit();
    }
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=true)]
    static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr context, uint flags, ref Guid iid, out Store store);
    [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
    static extern void SHChangeNotify(uint action, uint flags, string path, IntPtr unused);
    public static void Set(string path) {
        Guid iid = typeof(Store).GUID; Store store;
        Marshal.ThrowExceptionForHR(SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 2, ref iid, out store));
        var key = new Key {format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), id = 5};
        var value = new Value {type = 31, text = Marshal.StringToCoTaskMemUni("Framekeep.Desktop")};
        try { Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref value)); Marshal.ThrowExceptionForHR(store.Commit()); }
        finally { Marshal.FreeCoTaskMem(value.text); Marshal.ReleaseComObject(store); }
        SHChangeNotify(0x2000, 5, path, IntPtr.Zero);
    }
}
'@
    }
    [FramekeepShortcutIdentity]::Set($Path)
}
