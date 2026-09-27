# Local release policy

Barebuh's tracked release tooling produces evidence, not publication. The only
currently approved candidate is an unsigned local source bundle.

## Version and identity

`release/VERSION` is the fork version source. `release/config.json` records the
canonical Barebuh product/package identity, the exact Strawberry base, and the
unresolved external coordinates. “Dingleberry” is metadata for the historical
alias only.

The development version is `0.1.0-dev1`. Stable versioning, tag syntax, release
channels, upgrade/downgrade guarantees, and the first public release base remain
human gates.

## Reproducible artifacts

```sh
make release-check
make release
```

`release/build.py` archives the exact Git `HEAD` with `git archive`, uses the
commit timestamp as `SOURCE_DATE_EPOCH`, compresses with deterministic XZ
settings, and emits under `build/release/`:

- `barebuh-<version>.tar.xz` — complete tracked corresponding source;
- `barebuh-<version>.spdx.json` — SPDX 2.3 file-level SBOM;
- `barebuh-<version>.build-metadata.json` — commit, timestamp, upstream base,
  identity, and reproduction command;
- `SHA256SUMS` — hashes of the three artifacts above.

The builder rejects a dirty tracked tree. `make release-check` builds twice in
independent temporary directories and compares every output byte, verifies the
checksums/SBOM, and proves the source archive contains `COPYING` and release
metadata. Generated artifacts stay ignored under `build/`.

These tools do not claim bit-reproducible C++ binaries. Binary reproducibility
requires pinned compiler, linker, Qt/GStreamer/dependency closures and clean
cross-environment rebuild evidence; no such package target is approved yet.

## Signing and publication

All generated metadata says `signed: false` and `publishable: false`.
`make publish` executes a guard that fails while any forge, owner, repository,
release endpoint, or signing identity is unresolved. It also fails after those
fields are populated because this repository intentionally has no uploader.
Adding one requires a separate reviewed change and explicit external-action
authorization.

Do not create or alter remotes, tags, releases, package repositories, update
feeds, OAuth clients, DNS, signing keys, notarization, Authenticode, or store
submissions through this local workflow. Never reuse Strawberry credentials or
keys.

## Release checklist

A future public release additionally requires:

1. approved ownership, application namespace, URLs, supported platforms, and
   source-offer policy;
2. final trademark/license review and refreshed mixed-license inventory;
3. independent feature-on/feature-off builds and protocol/client tests;
4. install, launch, coexistence, upgrade, uninstall, and rollback testing for
   every advertised package;
5. verified private security contact and support route;
6. protected publication environment, immutable tag-to-commit check, approved
   signing identity, key rotation/revocation plan, and read-back verification;
7. release notes naming the upstream base, changes, migration behavior, known
   limitations, hashes, source, and SBOM.

For the current Linux metadata, `make metadata-check` validates the desktop and
AppStream files. The command downgrades only the expected missing-homepage and
missing-developer findings: publishing unresolved coordinates would be less
safe than omitting them.

The legacy upstream CI remains historical build infrastructure and is not a
Barebuh publication path. Its upstream-only secrets and destinations must not be
repurposed.
