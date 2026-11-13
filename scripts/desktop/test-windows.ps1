# SPDX-License-Identifier: AGPL-3.0-only
# Test actual installer/upgrade plus native WebView2/mpv using isolated user data,
# then the integrated updater against real local Velopack feeds.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $root
try {
  $setup = Get-ChildItem '.embedded-releases/*Setup.exe' | Select-Object -First 1
  if (-not $setup) { throw 'Build the Windows installer first.' }
  $portable = Get-ChildItem '.embedded-releases/*Portable.zip' | Select-Object -First 1
  $stage = Join-Path $root '.embedded-build/stage'
  $node = Join-Path $stage 'backend/node.exe'
  $vpk = Join-Path $root '.embedded-build/tools/vpk/vpk.exe'
  # Test-only newer packages, never published or included in release artifacts.
  # They contain the same app; only their version differs.
  function Pack-Test([string]$Version, [string]$Output) {
    & $vpk pack --packId aiostreams-integrated --packVersion $Version `
      --packDir $stage --mainExe aiostreams-desktop.exe --packTitle 'AIOStreams' `
      --packAuthors 'AIOStreams contributors; integrated desktop contributors' `
      --icon packages/desktop/app/icons/aiostreams.ico --channel win-x64 `
      --runtime win-x64 --shortcuts StartMenuRoot --instLocation PerUser --outputDir $Output
    if ($LASTEXITCODE -ne 0) { throw "Could not create the $Version test package." }
  }
  $upgradeDir = Join-Path $root '.embedded-build/upgrade-test'
  $nextDir = Join-Path $root '.embedded-build/update-test-next'
  Pack-Test '999.0.0' $upgradeDir
  Pack-Test '999.1.0' $nextDir
  $upgrade = Get-ChildItem "$upgradeDir/*Setup.exe" | Select-Object -First 1
  if (-not $upgrade) { throw 'Upgrade test installer missing.' }
  & $node scripts/desktop/native-smoke.mjs $stage .embedded-build/native-evidence `
    --installer $setup.FullName --upgrade $upgrade.FullName
  if ($LASTEXITCODE -ne 0) { throw 'Native installer/playback/upgrade validation failed.' }
  $updateArgs = @('--installer', $setup.FullName, '--feed', $upgradeDir, '--next-feed', $nextDir, '--evidence', '.embedded-build/native-evidence')
  if ($portable) { $updateArgs += @('--portable', $portable.FullName) }
  & $node scripts/desktop/native-update.mjs @updateArgs
  if ($LASTEXITCODE -ne 0) { throw 'Native update validation failed.' }
} finally { Pop-Location }
