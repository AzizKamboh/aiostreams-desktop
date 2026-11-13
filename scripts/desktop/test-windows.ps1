# SPDX-License-Identifier: AGPL-3.0-only
# Test actual installer/upgrade plus native WebView2/mpv using isolated user data.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $root
try {
  $setup = Get-ChildItem '.embedded-releases/*Setup.exe' | Select-Object -First 1
  if (-not $setup) { throw 'Build the Windows installer first.' }
  $stage = Join-Path $root '.embedded-build/stage'
  $node = Join-Path $stage 'backend/node.exe'
  $vpk = Join-Path $root '.embedded-build/tools/vpk/vpk.exe'
  # A test-only newer package, never published or included in release artifacts.
  $upgradeDir = Join-Path $root '.embedded-build/upgrade-test'
  & $vpk pack --packId aiostreams-integrated --packVersion 999.0.0 `
    --packDir $stage --mainExe aiostreams-desktop.exe --packTitle 'AIOStreams' `
    --packAuthors 'AIOStreams contributors; integrated desktop contributors' `
    --icon packages/desktop/app/icons/aiostreams.ico --channel win-x64 `
    --runtime win-x64 --shortcuts StartMenuRoot --instLocation PerUser --outputDir $upgradeDir
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the upgrade test package.' }
  $upgrade = Get-ChildItem "$upgradeDir/*Setup.exe" | Select-Object -First 1
  if (-not $upgrade) { throw 'Upgrade test installer missing.' }
  & $node scripts/desktop/native-smoke.mjs $stage .embedded-build/native-evidence `
    --installer $setup.FullName --upgrade $upgrade.FullName
  if ($LASTEXITCODE -ne 0) { throw 'Native installer/playback/upgrade validation failed.' }
} finally { Pop-Location }
