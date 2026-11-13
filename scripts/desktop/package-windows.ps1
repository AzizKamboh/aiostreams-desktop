# SPDX-License-Identifier: AGPL-3.0-only
# Run on Windows x64 in PowerShell 7 after building ffprobe with build-ffprobe.sh.
param(
  [string]$Version = '0.1.0',
  # Integrated release channel: stable (Velopack channel win-x64) or preview
  # (win-x64-preview). Each has its own update feed; see docs/AUTO-UPDATE.md.
  [ValidateSet('stable', 'preview')]
  [string]$Channel = 'stable',
  # Optional. The published feed of this channel; its newest full package is
  # downloaded so Velopack can also build a delta (smaller update) package.
  [string]$FeedUrl = '',
  # GitHub owner/repository whose updates-<channel> releases the app updates
  # from. Compiled into the app; never the upstream client-only feed.
  [string]$UpdateRepository = 'AzizKamboh/aiostreams-desktop',
  [switch]$SkipBuild,
  # Ship a pinned WebView2 inside the package instead of using the one Windows
  # keeps up to date. Larger, and only patched when a new release is published.
  [switch]$BundleWebView2,
  [switch]$SkipSmoke
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$pins = Get-Content (Join-Path $PSScriptRoot 'runtime-pins.json') -Raw | ConvertFrom-Json
$work = Join-Path $root '.embedded-build'
$stage = Join-Path $work 'stage'
$releases = Join-Path $root '.embedded-releases'
$cache = Join-Path $work 'downloads'
if (-not $IsWindows -or [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
  throw 'Build this payload on native Windows x64 (native addons must match the bundled Node runtime).'
}
if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { throw 'Version must be a SemVer.' }
if ($UpdateRepository -notmatch '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$') { throw 'UpdateRepository must be owner/name.' }
if ($UpdateRepository -ieq 'Viren070/AIOStreams') { throw 'The integrated app must never update from the upstream client-only feed.' }
$velopackChannel = if ($Channel -eq 'preview') { 'win-x64-preview' } else { 'win-x64' }
function Checked([scriptblock]$Command) {
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code $LASTEXITCODE" }
}
function Download-Pinned($Pin, [string]$Name) {
  $file = Join-Path $cache $Name
  if (-not (Test-Path $file)) { Invoke-WebRequest $Pin.url -OutFile $file }
  $hash = (Get-FileHash $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $Pin.sha256) { throw "$Name checksum mismatch; delete the cached download and investigate." }
  return $file
}
New-Item -ItemType Directory -Force $work, $cache, $releases | Out-Null
Push-Location $root
try {
  $nodeVersion = (& node --version).TrimStart('v')
  if ($nodeVersion -ne $pins.node.version) { throw "Build with Node $($pins.node.version), found $nodeVersion." }
  $pnpmVersion = (& pnpm --version).Trim()
  if ($pnpmVersion -ne $pins.pnpm) { throw "Build with pnpm $($pins.pnpm), found $pnpmVersion." }
  if (-not $SkipBuild) {
    Checked { pnpm install --frozen-lockfile }
    # No build-time analytics account is compiled into either frontend.
    $env:APTABASE_APP_KEY = ''
    $env:APTABASE_HOST = ''
    Checked { node scripts/desktop/generate-metadata.mjs }
    Checked { pnpm run build }
    $env:AIOSTREAMS_DESKTOP_BUILD = '1'
    Checked { pnpm -F '@aiostreams/web' build:standalone }
    Remove-Item Env:AIOSTREAMS_DESKTOP_BUILD
    # Integration unit tests: private boundary, accounts, storage migration.
    # Run from the root, whose devDependencies provide vitest to every package.
    Checked { pnpm exec vitest run packages/server/src/desktop.test.ts packages/web/tests/embedded-storage.test.ts packages/web/tests/embedded-accounts.test.ts }
    Checked { & (Join-Path $root 'packages/desktop/scripts/fetch-libs.ps1') -Arch x86_64 }
    # Shown in About/Diagnostics beside the separate upstream client/server versions.
    $env:AIOSTREAMS_INTEGRATED_VERSION = $Version
    $env:AIOSTREAMS_INTEGRATED_UPDATE_REPOSITORY = $UpdateRepository
    Push-Location (Join-Path $root 'packages/desktop')
    try { Checked { cargo test --locked }; Checked { cargo build --release --locked } } finally { Pop-Location }
  }
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
  New-Item -ItemType Directory -Force $stage | Out-Null
  Checked { node scripts/desktop/stage-runtime.mjs prepare $stage }
  $runtime = Join-Path $stage 'backend/app'
  # The hoisted linker avoids a huge virtual store. Finalize removes workspace
  # junctions too, so an extracted portable zip needs neither symlink privileges
  # nor any path on the build machine.
  Checked { pnpm --dir $runtime install --prod --frozen-lockfile --node-linker=hoisted }
  Checked { node scripts/desktop/stage-runtime.mjs finalize $stage }
  Copy-Item packages/desktop/target/release/aiostreams-desktop.exe $stage
  Copy-Item packages/desktop/vendor/x86_64/*.dll $stage
  Copy-Item packages/desktop/vendor/x86_64/licenses "$stage/licenses/mpv" -Recurse
  Copy-Item packages/desktop/vendor/x86_64/vulkan "$stage/vulkan" -Recurse
  Copy-Item LICENSE "$stage/LICENSE"
  Copy-Item packages/desktop/THIRD-PARTY.md "$stage/THIRD-PARTY-UPSTREAM.md"
  Copy-Item docs/embedded-windows-build.md "$stage/BUILD-AND-SOURCE.md"
  Copy-Item scripts/desktop/runtime-pins.json "$stage/runtime-pins.json"
  Copy-Item docs/embedded-third-party.md "$stage/THIRD-PARTY.md"

  $nodeZip = Download-Pinned $pins.node "node-$($pins.node.version)-x64.zip"
  $nodeOut = Join-Path $work 'node'
  if (Test-Path $nodeOut) { Remove-Item $nodeOut -Recurse -Force }
  Expand-Archive $nodeZip $nodeOut
  $nodeDir = Join-Path $nodeOut "node-v$($pins.node.version)-win-x64"
  Copy-Item "$nodeDir/node.exe" "$stage/backend/node.exe"
  Copy-Item "$nodeDir/LICENSE" "$stage/licenses/NODE-LICENSE"
  # Visual C++ app-local deployment avoids installing a system-wide runtime or
  # asking the end user for administrator access.
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
  $vs = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
  $crt = Get-ChildItem "$vs/VC/Redist/MSVC/*/x64/Microsoft.VC*.CRT" -Directory | Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $crt) { throw 'Visual C++ redistributable app-local DLL directory not found.' }
  Copy-Item "$($crt.FullName)/*.dll" $stage
  Copy-Item "$($crt.FullName)/*.dll" "$stage/backend"

  $ffprobe = Join-Path $work 'ffmpeg/ffprobe.exe'
  if (-not (Test-Path $ffprobe)) { throw 'Run scripts/desktop/build-ffprobe.sh in MSYS2 MINGW64 first.' }
  New-Item -ItemType Directory -Force "$stage/backend/bin", "$stage/licenses/ffmpeg", "$stage/source" | Out-Null
  Copy-Item $ffprobe "$stage/backend/bin/ffprobe.exe"
  Copy-Item "$work/ffmpeg/COPYING.LGPLv2.1", "$work/ffmpeg/LICENSE.md" "$stage/licenses/ffmpeg"
  Copy-Item "$work/ffmpeg-8.1.3.tar.xz" "$stage/source/ffmpeg-8.1.3.tar.xz"

  if ($BundleWebView2) {
  $webviewCab = Download-Pinned $pins.webview2 "webview2-$($pins.webview2.version)-x64.cab"
  $webviewOut = Join-Path $work 'webview-unpacked'
  if (Test-Path $webviewOut) { Remove-Item $webviewOut -Recurse -Force }
  New-Item -ItemType Directory -Force $webviewOut | Out-Null
  Checked { & "$env:SystemRoot/System32/expand.exe" '-F:*' $webviewCab $webviewOut }
  $webviewExe = Get-ChildItem $webviewOut -Filter msedgewebview2.exe -Recurse | Select-Object -First 1
  if (-not $webviewExe) { throw 'Fixed WebView2 runtime did not contain msedgewebview2.exe.' }
  Copy-Item $webviewExe.Directory.FullName "$stage/webview2" -Recurse
  }

  $tools = Join-Path $work 'tools'
  if (-not (Test-Path "$tools/bin/cargo-about.exe")) {
    Checked { cargo install cargo-about --version $pins.cargoAbout --features cli --locked --root $tools }
  }
  Push-Location packages/desktop
  try {
    Checked { & "$tools/bin/cargo-about.exe" generate --config about.toml --target x86_64-pc-windows-msvc about.hbs -o "$stage/third-party-licenses.html" }
    Checked { & "$tools/bin/cargo-about.exe" generate --config about.toml --target x86_64-pc-windows-msvc --format json -o "$stage/third-party-licenses.json" }
  } finally { Pop-Location }
  Checked { node scripts/desktop/archive-source.mjs "$stage/source/aiostreams-integrated-source.tar.gz" }
  Copy-Item "$stage/source/aiostreams-integrated-source.tar.gz" $releases
  if (-not $SkipSmoke) {
    Checked { & "$stage/backend/node.exe" scripts/desktop/smoke.mjs --app-root "$stage/backend/app" --node "$stage/backend/node.exe" --ffprobe "$stage/backend/bin/ffprobe.exe" }
    $env:AIOSTREAMS_TEST_NODE = Join-Path $stage 'backend/node.exe'
    Push-Location packages/desktop
    try {
      Checked { cargo test --locked -p aiostreams-desktop backend::tests::subprocess_lifecycle -- --ignored --test-threads=1 }
    } finally {
      Pop-Location
      Remove-Item Env:AIOSTREAMS_TEST_NODE
    }
  }
  if (-not (Test-Path "$tools/vpk/vpk.exe")) {
    Checked { dotnet tool install vpk --version $pins.velopack --tool-path "$tools/vpk" }
  }
  if ($FeedUrl) {
    # The previous release of this channel, for a delta. A channel's first release has none.
    & "$tools/vpk/vpk.exe" download http --url $FeedUrl --channel $velopackChannel -o $releases
    if ($LASTEXITCODE -ne 0) { Write-Host "No earlier $velopackChannel release to build a delta from." }
  }
  Checked {
    & "$tools/vpk/vpk.exe" pack --packId aiostreams-integrated --packVersion $Version `
      --packDir $stage --mainExe aiostreams-desktop.exe --packTitle 'AIOStreams' `
      --packAuthors 'AIOStreams contributors; integrated desktop contributors' `
      --icon packages/desktop/app/icons/aiostreams.ico --channel $velopackChannel `
      --runtime win-x64 --shortcuts StartMenuRoot --instLocation PerUser --outputDir $releases `
      @(if (-not $BundleWebView2) { '--framework', 'webview2' })
  }
  # Only this version's packages ship; the downloaded previous full package was input for the delta.
  Get-ChildItem $releases -Filter '*.nupkg' | Where-Object { $_.Name -notmatch "-$([regex]::Escape($Version))-" } | Remove-Item
  Set-Content "$releases/BUILD-INFO.json" (@{
    version = $Version; channel = $Channel; velopackChannel = $velopackChannel; packageId = 'aiostreams-integrated'
    updateRepository = $UpdateRepository; commit = (git rev-parse HEAD).Trim()
    upstream = (Get-Content .github/upstream-sync.json -Raw | ConvertFrom-Json).baseline
  } | ConvertTo-Json -Depth 5)
  Get-ChildItem $releases -File | Where-Object Name -ne 'SHA256SUMS.txt' | ForEach-Object {
    $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $($_.Name)"
  } | Set-Content "$releases/SHA256SUMS.txt"
  Write-Host "Installer, portable zip and source are in $releases. No release was published."
} finally { Pop-Location }
