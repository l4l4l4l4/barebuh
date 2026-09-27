# Barebuh registry-node scaffold

This directory contains the private, local, read-only registry scaffold described by [`docs/adr/0002-private-registry-node.md`](../docs/adr/0002-private-registry-node.md) and [`docs/registry-node-security-contract.md`](../docs/registry-node-security-contract.md).

Implemented now:

- fail-closed `MVP_LOCAL_READ_ONLY` configuration;
- loopback-only HTTP listener;
- deterministic `/.well-known/open-radio-registry` with ETag/304;
- local-only `/health/live` and `/health/ready`;
- a forward-only, hash-verified SQLite/FTS5 migration;
- offline database checks and SQLite online backup/restore validation;
- zero npm dependencies and a Node test harness.

Not implemented and therefore not advertised: node cards, feeds, snapshots, station/search APIs, import, public writes, federation, station probing, public listeners, credentials, deployment, or a NixOS service module.

Use the root Makefile:

```sh
make registry-config
make registry-migrate REGISTRY_DB="$PWD/var/registry.sqlite3"
make registry-check-db REGISTRY_DB="$PWD/var/registry.sqlite3"
make test-registry
make check
nix flake check --offline
```

To serve locally after migration:

```sh
BAREBUH_DATABASE_PATH="$PWD/var/registry.sqlite3" \
BAREBUH_PUBLIC_BASE_URL=https://registry.invalid/ \
node registry-node/src/cli.mjs serve
```

The public base is descriptor data and must be HTTPS even though the development listener itself is loopback HTTP. The placeholder `.invalid` origin prevents accidental publication. Unknown `BAREBUH_*` settings and attempts to enable writes, network probes, federation, non-local modes, or non-loopback binding stop startup.

Backup and validate without copying a live database file:

```sh
make registry-backup REGISTRY_DB="$PWD/var/registry.sqlite3" BACKUP="$PWD/var/registry.backup.sqlite3"
make registry-restore-check RESTORE="$PWD/var/registry.backup.sqlite3"
```
