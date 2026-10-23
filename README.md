# Barebuh

Barebuh is a desktop music player and collection organizer with an open,
federated internet-radio directory. The project is a modified fork of
[Strawberry Music Player](https://www.strawberrymusicplayer.org/); Strawberry is
itself derived from Clementine.

“Dingleberry” is retained only as a historical alias. Barebuh is the product,
application, package, and release name.

## Project status

Barebuh is a local, unsigned development candidate. No public forge, owner,
homepage, support address, security address, release host, or signing identity
has been selected. Do not redistribute the generated candidates as official
releases and do not direct Barebuh users to Strawberry support channels.

The current client adds:

- signed `oradio/1` federation schemas and cross-language conformance fixtures;
- a feature-gated Barebuh radio service with bounded parsing;
- transactional last-known-good caching and offline startup behavior;
- visible station provenance, health, and stale-data state.

The protocol identifier and `barebuh.example` schema origin are provisional.
See [`protocol/v1/README.md`](protocol/v1/README.md).

## Build

Barebuh requires CMake 3.13+, a C++17 compiler, Qt 6.4+, GStreamer, TagLib,
SQLite, GLib, OpenSSL, ICU, Boost, and KDSingleApplication. Optional Strawberry
integrations retain their upstream dependency requirements.

```sh
cmake -S . -B build -DBUILD_WERROR=ON -DENABLE_BAREBUH=ON
cmake --build build --parallel
cmake --build build --target build_tests
ctest --test-dir build/tests --output-on-failure
```

A feature-disabled compatibility build is a release gate:

```sh
cmake -S . -B build-no-barebuh -DBUILD_WERROR=ON -DENABLE_BAREBUH=OFF
cmake --build build-no-barebuh --parallel
```

## Local release bundle

The release workflow is local, deterministic, unsigned, and non-publishing:

```sh
make release-check
make release
```

It writes a normalized source archive, SPDX 2.3 JSON SBOM, build metadata, and
`SHA256SUMS` under `build/release/`. `make publish` deliberately fails closed.
See [`docs/release.md`](docs/release.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Threat model](docs/threat-model.md)
- [Protocol MVP](docs/protocol-mvp.md)
- [Implementation plan](docs/implementation-plan.md)
- [Release policy](docs/release.md)
- [Kanban workstreams](docs/workstreams.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License and attribution

Barebuh is free software under the GNU General Public License, version 3 or
later. Retained files continue to carry their original Strawberry, Clementine,
and other author and license notices. The repository also contains components
under compatible licenses documented in [`debian/copyright`](debian/copyright).
See [`COPYING`](COPYING) for the GPL text and [`CONTRIBUTORS.md`](CONTRIBUTORS.md)
for attribution policy.

Barebuh is an independent modified version. It is not endorsed by the
Strawberry Music Player or Clementine projects. Upstream history remains in the
legacy [`Changelog`](Changelog); fork changes begin in [`CHANGELOG.md`](CHANGELOG.md).
