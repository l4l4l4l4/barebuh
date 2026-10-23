# Barebuh changelog

This changelog records Barebuh-specific changes. The inherited Strawberry and
Clementine release history remains unchanged in [`Changelog`](Changelog).

## 0.1.0-dev1 — unreleased

Development baseline derived from Strawberry Music Player 1.2.30 at upstream
commit `4aa767fed7dd968192e24ef3e7f54d9b46badd52`.

### Added

- `oradio/1` signed federation schemas, canonical fixtures, and independent
  Node.js/Python conformance implementations.
- Feature-gated Barebuh radio discovery with bounded response parsing,
  provenance, health state, and last-known-good caching.
- Barebuh runtime and Linux desktop branding while retaining explicit
  Strawberry/Clementine attribution.
- Deterministic local source archives, SPDX 2.3 JSON SBOMs, build metadata, and
  SHA-256 manifests.
- Contributor, security, release, upstream-sync, and workstream documentation.

### Security and release posture

- Update feeds, signing, and publication are disabled or fail closed.
- Forge, owner, repository, public URLs, private security contact, release
  endpoint, and signing identity remain human decision gates.
- This version is an unsigned local development candidate, not a public stable
  release.
