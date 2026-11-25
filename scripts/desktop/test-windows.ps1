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
  # The channel of the build under test (win-x64 or win-x64-preview): its test
  # updates must be on the same Velopack channel, or the installed app would
  # look for a different feed.
  $channel = (Get-Content '.embedded-releases/BUILD-INFO.json' -Raw | ConvertFrom-Json).velopackChannel
  if ($channel -notin @('win-x64', 'win-x64-preview')) { throw "Unexpected Velopack channel '$channel' in BUILD-INFO.json." }
  # Test-only newer packages, never published or included in release artifacts.
  # They contain the same app; only their version differs.
  function Pack-Test([string]$Version, [string]$Output) {
    & $vpk pack --packId aiostreams-integrated --packVersion $Version `
      --packDir $stage --mainExe aiostreams-desktop.exe --packTitle 'AIOStreams Integrated' `
      --packAuthors 'AIOStreams contributors; integrated desktop contributors' `
      --icon packages/desktop/app/icons/aiostreams.ico --channel $channel `
      --runtime win-x64 --shortcuts Desktop,StartMenuRoot --instLocation PerUser --outputDir $Output
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
  $updateArgs = @('--installer', $setup.FullName, '--feed', $upgradeDir, '--next-feed', $nextDir, '--evidence', '.embedded-build/native-evidence', '--channel', $channel)
  if ($portable) { $updateArgs += @('--portable', $portable.FullName) }
  & $node scripts/desktop/native-update.mjs @updateArgs
  if ($LASTEXITCODE -ne 0) { throw 'Native update validation failed.' }
} finally { Pop-Location }
