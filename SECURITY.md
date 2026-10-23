# Security policy

## Supported versions

Barebuh has no public release or supported stable version yet. The current tree
is a development candidate. Security fixes target the latest reviewed local
commit; no compatibility or embargo promise is made for unpublished builds.

## Reporting a vulnerability

A private disclosure address and public issue tracker have not been selected.
Do not report an unpatched vulnerability to Strawberry, Clementine, or any
unrelated project, and do not put secrets or exploit details into a public
issue.

Until the human security-contact gate is resolved, private disclosure is
unavailable and publication must remain blocked. A public launch must add and
verify a monitored private contact before distributing binaries.

Reports should eventually include affected version/commit, platform, impact,
reproduction steps, and whether exploitation requires a malicious registry
node, station record, playlist, media file, or network position.

## Response and release requirements

Before a supported release, maintainers must define:

- a monitored private disclosure route and acknowledgement target;
- severity, embargo, coordination, and CVE policies;
- supported release branches and backport expectations;
- dependency, update-key, signing-key, and credential compromise procedures;
- a revocation and rollback path for update metadata and published artifacts.

Security releases must preserve GPL source availability, identify the exact
commit, regenerate the SPDX SBOM and checksums, pass independent review and
verification, and use only an explicitly approved signing identity. Barebuh
must not reuse Strawberry's signing, update, OAuth, or publication credentials.

See [`docs/threat-model.md`](docs/threat-model.md) for the protocol and client
security baseline.
