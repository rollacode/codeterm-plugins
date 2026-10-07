# Called from the provider's PowerShell launch, preserving args as an array.
param([Parameter(ValueFromRemainingArguments=$true)][string[]] $AiderArguments)
$ErrorActionPreference = 'Stop'
function Get-AiderInterpreter {
    param([string] $Entry)
    Add-Type -AssemblyName System.IO.Compression
    $bytes = [System.IO.File]::ReadAllBytes($Entry)
    if ($bytes.Length -lt 64 -or $bytes[0] -ne 77 -or $bytes[1] -ne 90) {
        throw 'Unknown Windows launcher (expected a PE console entry point)'
    }
    $pe = [BitConverter]::ToInt32($bytes, 60)
    if ($pe -lt 64 -or $pe + 4 -ge $bytes.Length -or [BitConverter]::ToUInt32($bytes, $pe) -ne 17744) {
        throw 'Invalid PE launcher'
    }
    # Read the framed ZIP, not arbitrary strings found inside a binary.
    # SFX/uv/distlib prepend a PE stub to a ZIP whose directory offsets can
    # remain relative to the ZIP start. .NET does not apply Python zipfile's
    # concatenated-archive adjustment, so derive the framed start from EOCD.
    $archiveEnd = $bytes.Length
    $trailerPython = $null
    # Legacy uv: ZIP + UTF-8 interpreter + u32 byte length + UVSC.
    if ([Text.Encoding]::ASCII.GetString($bytes, $bytes.Length - 4, 4) -eq 'UVSC') {
        $pathLength = [BitConverter]::ToUInt32($bytes, $bytes.Length - 8)
        if ($pathLength -eq 0 -or $pathLength -gt 32768 -or $pathLength -gt $bytes.Length - 8) { throw 'Invalid uv trailer length' }
        $archiveEnd = $bytes.Length - 8 - $pathLength
        $utf8 = [Text.UTF8Encoding]::new($false, $true)
        $trailerPython = Convert-Shebang ($utf8.GetString($bytes, $archiveEnd, $pathLength)) $Entry
    }
    $eocd = -1
    for ($cursor = $archiveEnd - 22; $cursor -ge [Math]::Max(0, $archiveEnd - 65557); $cursor--) {
        if ([BitConverter]::ToUInt32($bytes, $cursor) -eq 101010256 -and
            $cursor + 22 + [BitConverter]::ToUInt16($bytes, $cursor + 20) -eq $archiveEnd) {
            $eocd = $cursor
            break
        }
    }
    if ($eocd -lt 0 -or [BitConverter]::ToUInt32($bytes, $eocd + 4) -ne 0) { throw 'Unknown ZIP end frame' }
    $directorySize = [BitConverter]::ToUInt32($bytes, $eocd + 12)
    $directoryOffset = [BitConverter]::ToUInt32($bytes, $eocd + 16)
    $zipStart = [long]$eocd - $directorySize - $directoryOffset
    if ($zipStart -lt 0 -or $zipStart -gt $eocd) { throw 'Invalid ZIP directory range' }
    [byte[]] $zipBytes = $bytes[$zipStart..($archiveEnd - 1)]
    $memory = [System.IO.MemoryStream]::new($zipBytes, $false)
    try {
        $zip = [System.IO.Compression.ZipArchive]::new($memory, [System.IO.Compression.ZipArchiveMode]::Read)
        try {
            $main = $zip.GetEntry('__main__.py')
            if ($null -eq $main -or $main.Length -gt 65536) { throw 'Missing launcher __main__.py' }
            $reader = [System.IO.StreamReader]::new($main.Open(), [Text.Encoding]::UTF8)
            try { $script = $reader.ReadToEnd() } finally { $reader.Dispose() }
        } finally { $zip.Dispose() }
    } finally { $memory.Dispose() }
    if ($script -notmatch '(?m)^from aider\.main import main\s*$') { throw 'Launcher is not aider.main:main' }
    if ($null -ne $trailerPython) { return $trailerPython }
    # Installed uv tool launchers put the interpreter in __main__.py itself.
    $line = ($script -split "`n", 2)[0].TrimEnd("`r")
    if ($line.StartsWith('#!')) { return Convert-Shebang $line.Substring(2) $Entry }
    # distlib/pip/pipx: outer PE + #!absolute-python + ZIP local header.
    $outer = [Text.Encoding]::UTF8.GetString($bytes)
    $frames = [regex]::Matches($outer, '(?m)#!([^\r\n]+)\r?\nPK\x03\x04')
    if ($frames.Count -eq 1) { return Convert-Shebang $frames[0].Groups[1].Value $Entry }
    # New uv versions store typed metadata as PE RCDATA resources. Load as
    # data only: never execute an unknown launcher to discover its interpreter.
    if (-not ('DomiosAiderResources' -as [type])) {
        Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DomiosAiderResources {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr LoadLibraryExW(string p, IntPtr f, uint flags);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindResourceW(IntPtr h, string n, IntPtr t);
 [DllImport("kernel32.dll")] static extern IntPtr LoadResource(IntPtr h, IntPtr r);
 [DllImport("kernel32.dll")] static extern IntPtr LockResource(IntPtr h);
 [DllImport("kernel32.dll")] static extern uint SizeofResource(IntPtr h, IntPtr r);
 [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr h);
 public static byte[] Read(string p, string n) {
  var h=LoadLibraryExW(p,IntPtr.Zero,2); if(h==IntPtr.Zero) return null;
  try { var r=FindResourceW(h,n,new IntPtr(10)); if(r==IntPtr.Zero) return null;
   var size=SizeofResource(h,r); if(size==0 || size>65536) return null;
   var ptr=LockResource(LoadResource(h,r)); if(ptr==IntPtr.Zero) return null;
   var data=new byte[(int)size]; Marshal.Copy(ptr,data,0,data.Length); return data;
  } finally { FreeLibrary(h); }
 }
}
'@
    }
    $kind = [DomiosAiderResources]::Read($Entry, 'UV_TRAMPOLINE_KIND')
    $path = [DomiosAiderResources]::Read($Entry, 'UV_PYTHON_PATH')
    if ($null -ne $kind -and $kind.Length -eq 1 -and $kind[0] -eq 1 -and $null -ne $path) {
        return Convert-Shebang ([Text.Encoding]::UTF8.GetString($path)) $Entry
    }
    throw 'Unknown Windows aider launcher framing'
}
function Convert-Shebang {
    param([string] $Value, [string] $Entry)
    if ($Value -match '^"([^"\r\n]+)"$') { $Value = $Matches[1] }
    if ($Value -match '["\r\n\x00]' -or $Value -notmatch '(?i)python(?:w|\d+(?:\.\d+)*)?\.exe$') {
        throw 'Unknown Python shebang arguments'
    }
    if (-not [IO.Path]::IsPathRooted($Value)) { $Value = Join-Path (Split-Path -Parent $Entry) $Value }
    if (-not [IO.File]::Exists($Value)) { throw 'Entry-point Python is unavailable' }
    return $Value
}
if ($MyInvocation.InvocationName -eq '.') { return }
try {
    $entry = (Get-Command aider -CommandType Application -ErrorAction Stop).Source
    $python = Get-AiderInterpreter $entry
    & $python (Join-Path $PSScriptRoot 'domios_adapter.py') @AiderArguments
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine("Domios Aider adapter refused launch: $($_.Exception.Message). Install aider-chat==0.86.2 with uv tool or pipx, or explicitly set plainMode=true.")
    exit 2
}
