// SPDX-License-Identifier: AGPL-3.0-only
// Release rules for AIOStreams Integrated, shared by the release workflows and
// tested by lib.test.mjs. No I/O here.

export const PACKAGE_ID = 'aiostreams-integrated';

/** Velopack channel and feed release for each integrated release channel. */
export const CHANNELS = {
  stable: { velopack: 'win-x64', feedTag: 'updates-stable', prerelease: false },
  preview: { velopack: 'win-x64-preview', feedTag: 'updates-preview', prerelease: true },
};

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseSemver(text) {
  const match = SEMVER.exec(text ?? '');
  if (!match) return null;
  return { major: +match[1], minor: +match[2], patch: +match[3], pre: match[4] ? match[4].split('.') : [] };
}

/** SemVer 2.0 precedence. */
export function compareSemver(a, b) {
  const [x, y] = [parseSemver(a), parseSemver(b)];
  if (!x || !y) throw new Error(`Not a SemVer: ${!x ? a : b}`);
  for (const key of ['major', 'minor', 'patch']) if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn && +p !== +q) return +p < +q ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    if (!pn && p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** The release channel a version belongs to, or null if it fits neither. */
export function channelOf(version) {
  const v = parseSemver(version);
  if (!v) return null;
  if (!v.pre.length) return 'stable';
  if (v.pre.length === 2 && v.pre[0] === 'preview' && /^[1-9]\d*$/.test(v.pre[1])) return 'preview';
  return null;
}

const base = (version) => version.replace(/-.*$/, '');

/**
 * Checks a requested release against the committed integrated version and the
 * releases that already exist. `existing` are tag names (`v…`), drafts included.
 */
export function validateRelease({ version, channel, committedVersion, existing }) {
  const errors = [];
  if (!CHANNELS[channel]) errors.push(`Unknown channel '${channel}'. Use stable or preview.`);
  const actual = channelOf(version);
  if (!actual) errors.push(`${version} is not a release version: use X.Y.Z (stable) or X.Y.Z-preview.N (preview).`);
  else if (actual !== channel) errors.push(`${version} is a ${actual} version but the ${channel} channel was selected.`);
  if (!parseSemver(committedVersion)) errors.push(`integrated-version.json holds an invalid version '${committedVersion}'.`);
  else if (actual && base(version) !== committedVersion) {
    errors.push(`${version} does not match integrated-version.json (${committedVersion}). Bump the file in a reviewed pull request first.`);
  }
  if (errors.length) return errors;
  const tags = existing.filter((tag) => tag.startsWith('v') && parseSemver(tag.slice(1))).map((tag) => tag.slice(1));
  if (tags.includes(version)) errors.push(`Release v${version} already exists (possibly as a draft). Choose a new version.`);
  const stable = tags.filter((t) => channelOf(t) === 'stable');
  const newestStable = stable.sort(compareSemver).at(-1);
  // A preview X.Y.Z-preview.N comes before stable X.Y.Z, so X.Y.Z itself must be unreleased.
  if (newestStable && compareSemver(base(version), newestStable) <= 0) {
    errors.push(`${version} must be newer than the latest stable release v${newestStable}.`);
  }
  if (channel === 'preview') {
    const previews = tags.filter((t) => channelOf(t) === 'preview' && base(t) === base(version)).sort(compareSemver);
    const last = previews.at(-1);
    if (last && compareSemver(version, last) <= 0) errors.push(`${version} must be newer than v${last}.`);
  }
  return errors;
}

/**
 * Verifies a Velopack `releases.<channel>.json` feed before it is published or
 * after it is downloaded. `files` maps file names to `{ size, sha256, sha1 }`
 * for the packages that should be present; omit it to check metadata only.
 */
export function verifyFeed(feedText, { packageId = PACKAGE_ID, version, files }) {
  const errors = [];
  let feed;
  try {
    feed = JSON.parse(feedText);
  } catch (error) {
    return [`The feed is not JSON: ${error.message}`];
  }
  const assets = feed?.Assets ?? feed?.assets;
  if (!Array.isArray(assets) || assets.length === 0) return ['The feed lists no assets.'];
  const field = (asset, name) => asset[name] ?? asset[name[0].toLowerCase() + name.slice(1)];
  let target = false;
  for (const asset of assets) {
    const [id, ver, type, name, sha256, size] = ['PackageId', 'Version', 'Type', 'FileName', 'SHA256', 'Size'].map((key) => field(asset, key));
    const label = name ?? '(unnamed asset)';
    if (id !== packageId) errors.push(`${label}: package '${id}' is not ${packageId}; the feed must never offer another app.`);
    if (!parseSemver(ver)) errors.push(`${label}: invalid version '${ver}'.`);
    else if (version && compareSemver(ver, version) > 0) errors.push(`${label}: version ${ver} is newer than the release being verified (${version}).`);
    if (!/^(Full|Delta)$/i.test(type ?? '')) errors.push(`${label}: unknown asset type '${type}'.`);
    if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+\.nupkg$/.test(name)) errors.push(`${label}: unsafe or unexpected file name.`);
    if (!/^[0-9a-fA-F]{64}$/.test(sha256 ?? '')) errors.push(`${label}: missing SHA256.`);
    if (!(Number.isInteger(size) && size > 0)) errors.push(`${label}: missing size.`);
    if (version && ver === version && /^full$/i.test(type ?? '')) target = true;
    if (files && version && ver === version) {
      const file = files[name];
      if (!file) errors.push(`${label}: listed in the feed but not present.`);
      else {
        if (file.size !== size) errors.push(`${label}: size ${file.size} does not match the feed (${size}).`);
        if (file.sha256.toLowerCase() !== String(sha256).toLowerCase()) errors.push(`${label}: SHA256 does not match the feed.`);
      }
    }
  }
  if (version && !target) errors.push(`The feed has no full package for ${version}.`);
  return errors;
}

/** Parses `sha256  name` lines (Windows line endings and BOM tolerated). */
export function parseChecksums(text) {
  const map = {};
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (match) map[match[2]] = match[1].toLowerCase();
  }
  return map;
}

/** The `## <version>` section of RELEASE-NOTES.md, without its heading. */
export function notesSection(markdown, version) {
  const lines = markdown.split(/\r?\n/);
  const escaped = version.replace(/[.]/g, '\\.');
  const start = lines.findIndex((line) => new RegExp(`^## ${escaped}(\\s|$)`).test(line));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/** GitHub release notes for an integrated release. */
export function renderReleaseNotes(r) {
  const preview = r.channel === 'preview';
  const upstreamChanged = r.previousUpstream && r.previousUpstream.commit !== r.upstream.commit;
  const asset = (name) => `https://github.com/${r.repository}/releases/download/v${r.version}/${name}`;
  return `**AIOStreams ${r.version}** — an unofficial integrated Windows build of [AIOStreams](https://github.com/Viren070/AIOStreams) by Viren070 and contributors, with its own private local server. Not affiliated with or endorsed by Viren070. Licensed AGPL-3.0-only.
${preview ? '\n> [!WARNING]\n> **Preview build.** Tested by the same Windows CI as stable releases, but ahead of them and more likely to have problems. Only apps that chose the Preview update channel receive it.\n' : ''}
| | Version |
| --- | --- |
| Integrated app | **${r.version}** (${r.channel}) |
| Upstream server | ${r.upstream.serverVersion} |
| Upstream desktop client | ${r.upstream.desktopVersion} |
| Upstream source | [\`${r.upstream.ref}\`](https://github.com/Viren070/AIOStreams/tree/${r.upstream.commit}) (\`${r.upstream.commit}\`) |

## Changes
${r.notes || '_No release notes were written for this version. Edit this draft before publishing._'}

## Upstream changes incorporated
${upstreamChanged
    ? `Upstream moved from \`${r.previousUpstream.ref}\` (server ${r.previousUpstream.serverVersion}, desktop ${r.previousUpstream.desktopVersion}) to \`${r.upstream.ref}\`. Upstream release notes:\n${(r.upstream.changelogs ?? []).map((url) => `- ${url}`).join('\n') || '- (none recorded)'}\n\n[Full upstream comparison](https://github.com/Viren070/AIOStreams/compare/${r.previousUpstream.commit}...${r.upstream.commit})`
    : 'None: the same upstream release as the previous integrated release.'}
${r.migrations?.length ? `\n## Compatibility warning: database changes\nThis release adds upstream database migrations (${r.migrations.map((m) => `\`${m.split('/').pop()}\``).join(', ')}). After updating, **an older integrated release cannot safely open the database**. Back up \`%LOCALAPPDATA%\\AIOStreams Integrated\` before updating if you might go back (docs/AUTO-UPDATE.md, *Rollback*).\n` : ''}
## Install or update
- **New install:** download \`${r.files.setup}\` and run it as your normal Windows user (no administrator rights). Windows 10/11 x64.
- **Portable:** extract \`${r.files.portable}\`. It needs the WebView2 runtime, present on Windows 11 and updated Windows 10.
- **Existing install:** the app checks for updates by itself (Settings → Updates). Or run the new Setup over the old install: data, accounts and settings are kept.
- Installers are **${r.signed ? 'Authenticode-signed' : 'unsigned'}**${r.signed ? '' : '; Windows SmartScreen may warn on first run'}. Verify downloads with \`SHA256SUMS.txt\` and the build provenance attestation: \`gh attestation verify ${r.files.setup} -R ${r.repository}\`.

## Known limitations
- Windows x64 only. Upstream's Linux FUSE mount and Jellyfin HLS/transcoding endpoints are unavailable.
- The bundled server's account passwords and key reach it as environment variables; DPAPI protects them from other Windows users, not from malware running as you.
- Automated tests use fixtures; real debrid, Usenet and addon accounts are not tested in CI.
- See [README](https://github.com/${r.repository}#known-limitations) and [docs/TROUBLESHOOTING.md](https://github.com/${r.repository}/blob/v${r.version}/docs/TROUBLESHOOTING.md).

## Source and attribution
Complete corresponding source: [\`${r.files.source}\`](${asset(r.files.source)}). Upstream: [Viren070/AIOStreams](https://github.com/Viren070/AIOStreams) (AGPL-3.0-only); third-party notices are in the package (\`THIRD-PARTY.md\`, \`third-party-licenses.html\`, \`licenses/\`).

Built and tested from commit \`${r.commit}\` in [workflow run ${r.runId}](https://github.com/${r.repository}/actions/runs/${r.runId}).

<details><summary>SHA256SUMS.txt</summary>

\`\`\`
${r.checksums.trim()}
\`\`\`
</details>
`;
}

/**
 * Adds a stable release's full package to another channel's feed (Preview),
 * so preview users are never stuck behind a newer stable release. Returns
 * null when that feed already offers something newer. Deltas are not copied:
 * they are built against the previous stable package, not a preview one.
 */
export function mergeFeed(baseText, addText, version) {
  const assets = (text) => (text ? JSON.parse(text).Assets ?? [] : []);
  const base = assets(baseText);
  if (base.some((a) => /^full$/i.test(a.Type) && parseSemver(a.Version) && compareSemver(a.Version, version) >= 0)) return null;
  const full = assets(addText).filter((a) => /^full$/i.test(a.Type) && a.Version === version);
  if (full.length !== 1) throw new Error(`The stable feed has ${full.length} full packages for ${version}`);
  const names = new Set(full.map((a) => a.FileName));
  return JSON.stringify({ Assets: [...base.filter((a) => !names.has(a.FileName)), ...full] }, null, 2) + '\n';
}
