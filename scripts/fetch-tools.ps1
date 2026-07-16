<#
.SYNOPSIS
    Fetches the ffmpeg + exiftool binaries Ingest Pilot bundles for thumbnail extraction.

.DESCRIPTION
    These binaries are large (~100 MB combined) and are NOT committed to git — see
    .gitignore. Run this once after cloning, and in CI before `tauri build`.

    Places, relative to the repo root:

      src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe   <- Tauri sidecar (externalBin)
      src-tauri/resources/tools/exiftool/exiftool.exe        <- Tauri resource
      src-tauri/resources/tools/exiftool/exiftool_files/      <- (bundled Perl runtime)

    Downloads are SHA-256 verified against the publishers' own checksum files.
    Idempotent: an already-installed tool that runs `-version` is skipped unless -Force.

    Neither binary is required to build or run the app. Without them, cinema-RAW
    (.R3D/.BRAW) and standard-video thumbnails fall back to placeholder cards.
    See docs/design/BUNDLING.md.

    ffmpeg is deliberately the **LGPL** build from BtbN, not a GPL one — see the
    licensing section of docs/design/BUNDLING.md. This script re-verifies that on every
    install and refuses to install a GPL/nonfree binary.

.PARAMETER ExifToolVersion
    ExifTool version to pin. Defaults to a known-good release. Pass 'latest' to
    resolve the current version from the publisher.

.PARAMETER FfmpegRelease
    BtbN FFmpeg-Builds release tag to pin. Dated 'autobuild-*' tags are immutable, so
    the default is fully reproducible. ('latest' is a rolling tag whose assets are
    replaced in place — pinned by default on purpose.)

.PARAMETER FfmpegAsset
    Asset within that release. Defaults to the win64 **LGPL static** build on the 8.1
    release line: one self-contained ffmpeg.exe, which is what the Tauri sidecar wants.

.PARAMETER Force
    Re-download and replace tools even if they are already installed and working.

.EXAMPLE
    pwsh -File scripts/fetch-tools.ps1

.EXAMPLE
    pwsh -File scripts/fetch-tools.ps1 -Force -ExifToolVersion latest
#>
[CmdletBinding()]
param(
    [string]$ExifToolVersion = '13.59',
    [string]$FfmpegRelease   = 'autobuild-2026-07-15-14-01',
    [string]$FfmpegAsset     = 'ffmpeg-n8.1.2-22-g94138f6973-win64-lgpl-8.1.zip',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 negotiates TLS 1.0 by default; every source here requires 1.2+.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoRoot     = Split-Path -Parent $PSScriptRoot
$BinariesDir  = Join-Path $RepoRoot 'src-tauri\binaries'
$ExifToolDir  = Join-Path $RepoRoot 'src-tauri\resources\tools\exiftool'
$FfmpegTarget = Join-Path $BinariesDir 'ffmpeg-x86_64-pc-windows-msvc.exe'
$ExifTarget   = Join-Path $ExifToolDir 'exiftool.exe'
$ExifFilesDir = Join-Path $ExifToolDir 'exiftool_files'

# Scratch space for archives; reused across runs so re-runs are cheap.
$Work = Join-Path ([IO.Path]::GetTempPath()) 'ingest-pilot-tools'

function Write-Step  { param([string]$m) Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok    { param([string]$m) Write-Host "    $m" -ForegroundColor Green }
function Write-Note  { param([string]$m) Write-Host "    $m" -ForegroundColor DarkGray }

# SourceForge sniffs the User-Agent: browser-ish agents get a 403 or an HTML
# interstitial page *in place of* the file, while plain tool agents get raw bytes.
# Identify ourselves honestly and non-browser-like.
$UserAgent = 'ingest-pilot-fetch-tools/1.0'

function Get-Url {
    param([string]$Uri, [string]$OutFile)
    Write-Note "GET $Uri"
    Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing -UserAgent $UserAgent
}

function Get-Text {
    param([string]$Uri)
    # Servers that send these .txt files as application/octet-stream (SourceForge does)
    # make Invoke-WebRequest hand back a Byte[]; interpolating that yields "83 72 65 ..."
    # rather than the text. Decode explicitly.
    $content = (Invoke-WebRequest -Uri $Uri -UseBasicParsing -UserAgent $UserAgent).Content
    if ($content -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($content) }
    return [string]$content
}

# Encodes the licensing decision in code. We moved off the gyan.dev "essentials" build
# precisely because it is GPLv3 (--enable-gpl --enable-version3); --enable-nonfree would
# be worse still (not redistributable at all). Re-checked on every install so a future
# URL/version bump cannot silently reintroduce a GPL binary into the installer.
function Assert-FfmpegIsLgpl {
    param([string]$Exe)
    $config = (& $Exe -version | Out-String)

    # `--enable-gpl` is the decisive flag. ffmpeg is LGPL *by default* and you opt into
    # GPL — there is no `--enable-lgpl` flag to look for. `--enable-nonfree` would make
    # the binary non-redistributable outright.
    foreach ($flag in @('--enable-gpl', '--enable-nonfree')) {
        if ($config -match [regex]::Escape($flag)) {
            throw "Refusing to install: this ffmpeg's build configuration reports '$flag', so it is NOT an LGPL build. See the licensing section of docs/design/BUNDLING.md."
        }
    }

    # `--enable-version3` is NOT a GPL marker: it is orthogonal to `--enable-gpl` and only
    # moves (L)GPLv2.1 -> v3 (some LGPL deps, e.g. libopencore-amr, require it). With
    # `--enable-gpl` absent, a build carrying version3 is LGPLv3.
    $tier = if ($config -match '--enable-version3') { 'v3' } else { 'v2.1+' }
    Write-Ok "license verified: LGPL$tier (no --enable-gpl, no --enable-nonfree)"
}

function Assert-Sha256 {
    param([string]$Path, [string]$Expected, [string]$Label)
    $actual = (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    $want   = $Expected.Trim().ToLowerInvariant()
    if ($actual -ne $want) {
        throw "$Label checksum mismatch.`n  expected: $want`n  actual:   $actual`nRefusing to install a binary that does not match the publisher's checksum."
    }
    Write-Ok "sha256 verified ($Label)"
}

# Runs <exe> <arg> and returns its first line of output, or $null if it won't run.
# Retries briefly: a just-written exe can fail its very first exec while the
# on-access AV scanner still has it open, and exiftool.exe (PAR-packed) unpacks its
# Perl runtime on first run, which is slow enough to matter on a cold machine.
function Get-ToolVersion {
    param([string]$Exe, [string]$VersionArg, [int]$Attempts = 3)
    if (-not (Test-Path -LiteralPath $Exe)) { return $null }
    for ($i = 1; $i -le $Attempts; $i++) {
        try {
            # No 2>&1: in PS 5.1 that wraps a native command's stderr in ErrorRecords and
            # trips $ErrorActionPreference='Stop' even on a clean exit-code 0.
            $out = & $Exe $VersionArg
            if ($LASTEXITCODE -eq 0 -and $out) {
                return "$(@($out)[0])".Trim()
            }
            $script:LastToolError = "exit code $LASTEXITCODE"
        } catch {
            $script:LastToolError = $_.Exception.Message
        }
        if ($i -lt $Attempts) { Start-Sleep -Milliseconds 750 }
    }
    return $null
}

New-Item -ItemType Directory -Force -Path $Work, $BinariesDir, $ExifToolDir | Out-Null

# ---------------------------------------------------------------------------
# 1. ffmpeg — LGPL *static* Windows x64 build from BtbN/FFmpeg-Builds.
#    Static (not -shared) means a single self-contained ffmpeg.exe, which is exactly what
#    Tauri's externalBin sidecar model expects; the -shared build would drag DLLs along
#    and could not be a sidecar. We keep ONLY ffmpeg.exe (ffplay/ffprobe/docs dropped).
#    The -x86_64-pc-windows-msvc suffix is REQUIRED by Tauri's externalBin.
# ---------------------------------------------------------------------------
Write-Step 'ffmpeg (sidecar, LGPL)'

$existing = Get-ToolVersion -Exe $FfmpegTarget -VersionArg '-version'
if ($existing -and -not $Force) {
    Write-Ok "already installed: $existing"
    # Cheap, and catches a stale GPL binary left over from an older checkout.
    Assert-FfmpegIsLgpl -Exe $FfmpegTarget
} else {
    $base = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$FfmpegRelease"
    $zip  = Join-Path $Work $FfmpegAsset

    Get-Url -Uri "$base/$FfmpegAsset" -OutFile $zip

    # BtbN publishes one checksums.sha256 per release: "<sha256>  <filename>" per line.
    $sums  = Get-Text -Uri "$base/checksums.sha256"
    $match = [regex]::Match($sums, "([0-9a-fA-F]{64})\s+$([regex]::Escape($FfmpegAsset))\b")
    if (-not $match.Success) { throw "No SHA-256 entry for $FfmpegAsset in $FfmpegRelease/checksums.sha256." }
    Assert-Sha256 -Path $zip -Expected $match.Groups[1].Value -Label 'ffmpeg zip'

    $extract = Join-Path $Work 'ffmpeg-extract'
    if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
    Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force

    # Archive root is a versioned folder, e.g. ffmpeg-n8.1.2-…-win64-lgpl-8.1/bin/ffmpeg.exe
    $src = Get-ChildItem -Path $extract -Filter 'ffmpeg.exe' -Recurse -File | Select-Object -First 1
    if (-not $src) { throw 'ffmpeg.exe not found inside the downloaded archive.' }

    Copy-Item -LiteralPath $src.FullName -Destination $FfmpegTarget -Force
    Remove-Item -Recurse -Force $extract

    $version = Get-ToolVersion -Exe $FfmpegTarget -VersionArg '-version'
    if (-not $version) { throw "Installed $FfmpegTarget but it would not run ($script:LastToolError)." }
    Assert-FfmpegIsLgpl -Exe $FfmpegTarget
    Write-Ok "installed: $version"
}

# ---------------------------------------------------------------------------
# 2. exiftool — the Windows package is exiftool(-k).exe PLUS an exiftool_files/
#    directory (its bundled Perl runtime). Both must ship together, so this is a
#    Tauri *resource* folder, not a sidecar. The (-k) build pauses for a keypress
#    on exit; renaming to exiftool.exe disables that, which is what we want.
# ---------------------------------------------------------------------------
Write-Step 'exiftool (resource folder)'

$existing = Get-ToolVersion -Exe $ExifTarget -VersionArg '-ver'
if ($existing -and (Test-Path -LiteralPath $ExifFilesDir) -and -not $Force) {
    Write-Ok "already installed: $existing"
} else {
    if ($ExifToolVersion -eq 'latest') {
        $ExifToolVersion = (Get-Text -Uri 'https://exiftool.org/ver.txt').Trim()
        Write-Note "resolved latest exiftool version: $ExifToolVersion"
    }

    $name = "exiftool-${ExifToolVersion}_64.zip"
    $zip  = Join-Path $Work $name

    # exiftool.org is the canonical host but rate-limits aggressively; SourceForge is
    # the author's own mirror and carries the same files + checksums. Try both.
    $mirrors = @(
        @{ Zip = "https://exiftool.org/$name"
           Sums = 'https://exiftool.org/checksums.txt' },
        @{ Zip = "https://downloads.sourceforge.net/project/exiftool/$name"
           Sums = "https://downloads.sourceforge.net/project/exiftool/checksums-$ExifToolVersion.txt" }
    )

    # Verify *inside* the loop: a mirror that serves an HTML error/interstitial page
    # instead of the archive fails the checksum, and we fall through to the next one
    # rather than aborting the whole run.
    $verified = $false
    foreach ($mirror in $mirrors) {
        try {
            Get-Url -Uri $mirror.Zip -OutFile $zip
            $sums = Get-Text -Uri $mirror.Sums
            # Checksums file format: SHA2-256(exiftool-13.59_64.zip)= <hex>
            $match = [regex]::Match($sums, "SHA2-256\($([regex]::Escape($name))\)\s*=\s*([0-9a-fA-F]{64})")
            if (-not $match.Success) { throw "no SHA2-256 entry for $name in the checksums file" }
            Assert-Sha256 -Path $zip -Expected $match.Groups[1].Value -Label 'exiftool zip'
            $verified = $true
            break
        } catch {
            Write-Note "mirror failed ($($_.Exception.Message)); trying next"
        }
    }
    if (-not $verified) { throw "Could not download a checksum-verified $name from any mirror." }

    $extract = Join-Path $Work 'exiftool-extract'
    if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
    Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force

    # Layout inside the zip: exiftool-<ver>_64/exiftool(-k).exe + exiftool_files/
    $srcExe = Get-ChildItem -Path $extract -Filter 'exiftool(-k).exe' -Recurse -File | Select-Object -First 1
    if (-not $srcExe) {
        $srcExe = Get-ChildItem -Path $extract -Filter 'exiftool*.exe' -Recurse -File | Select-Object -First 1
    }
    if (-not $srcExe) { throw 'exiftool(-k).exe not found inside the downloaded archive.' }

    $srcFiles = Get-ChildItem -Path $extract -Filter 'exiftool_files' -Recurse -Directory | Select-Object -First 1
    if (-not $srcFiles) { throw 'exiftool_files/ not found inside the downloaded archive.' }

    # Replace wholesale so a -Force run never leaves stale Perl modules behind.
    if (Test-Path -LiteralPath $ExifFilesDir) { Remove-Item -Recurse -Force $ExifFilesDir }
    Copy-Item -LiteralPath $srcExe.FullName -Destination $ExifTarget -Force
    Copy-Item -LiteralPath $srcFiles.FullName -Destination $ExifFilesDir -Recurse -Force
    Remove-Item -Recurse -Force $extract

    $version = Get-ToolVersion -Exe $ExifTarget -VersionArg '-ver'
    if (-not $version) { throw "Installed $ExifTarget but it would not run ($script:LastToolError)." }
    Write-Ok "installed: $version"
}

# ---------------------------------------------------------------------------
# 3. Invalidate stale staged copies.
#    `tauri-build` stages the sidecar + resources into src-tauri/target/<profile>/ at
#    build time, and dev discovery deliberately prefers those exe-adjacent copies
#    (they mirror the packaged layout). That means a previously-staged copy of an OLD
#    tool silently shadows whatever we just installed — which is exactly how a GPL
#    ffmpeg survived the swap to the LGPL build, since `cargo check` alone does not
#    re-run build.rs. Drop them: the next build re-stages, and until then discovery
#    falls through to the source tree we just wrote.
# ---------------------------------------------------------------------------
Write-Step 'Invalidating stale staged copies'

$stale = foreach ($profile in @('debug', 'release')) {
    $dir = Join-Path $RepoRoot "src-tauri\target\$profile"
    Join-Path $dir 'ffmpeg.exe'
    Join-Path $dir 'resources\tools\exiftool'
}
$removed = $false
foreach ($path in $stale) {
    if (Test-Path -LiteralPath $path) {
        Remove-Item -Recurse -Force -LiteralPath $path
        Write-Note "removed $path"
        $removed = $true
    }
}
if ($removed) { Write-Ok 'stale staged copies cleared; next build re-stages' }
else { Write-Note 'none found' }

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Step 'Summary'

$ffVersion   = Get-ToolVersion -Exe $FfmpegTarget -VersionArg '-version'
$exifVersion = Get-ToolVersion -Exe $ExifTarget   -VersionArg '-ver'
$ffSize      = [math]::Round((Get-Item -LiteralPath $FfmpegTarget).Length / 1MB, 1)
$exifSize    = [math]::Round(((Get-ChildItem -LiteralPath $ExifToolDir -Recurse -File |
                               Measure-Object -Property Length -Sum).Sum) / 1MB, 1)

Write-Host ("  ffmpeg   {0,-8} {1}" -f "${ffSize}MB", $ffVersion)
Write-Host ("           {0}" -f $FfmpegTarget)
Write-Host ("  exiftool {0,-8} {1}" -f "${exifSize}MB", $exifVersion)
Write-Host ("           {0}" -f $ExifTarget)
Write-Host ''
Write-Ok 'Tools ready. Restart `npm run tauri:dev` to pick them up.'
