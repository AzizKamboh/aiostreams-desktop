# Security policy

This policy covers **AIOStreams Integrated**, the unofficial Windows
distribution in this repository: the bundled local server's private access
boundary, the native bridge, secret storage (DPAPI), the update feed and
release packages.

## Reporting

Report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/AzizKamboh/aiostreams-desktop/security/advisories/new).
Do not open a public issue. Include the integrated version, steps to
reproduce and the impact. Do not include real credentials.

If the vulnerability is in AIOStreams itself (the server, providers, addons
or the official apps) and not specific to this build, report it to the
upstream project, [Viren070/AIOStreams](https://github.com/Viren070/AIOStreams).

## Supported versions

Only the latest stable release and the latest preview release receive fixes.
The app updates itself, so staying current is the fix path.

## Release authenticity

Releases are built by this repository's GitHub Actions workflow and carry a
build provenance attestation and `SHA256SUMS.txt`. Checksums alone only
detect corruption; verify origin with
`gh attestation verify <file> -R AzizKamboh/aiostreams-desktop`.
Packages are not Authenticode-signed yet.
