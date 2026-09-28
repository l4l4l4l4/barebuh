# Barebuh registry-node scaffold

This directory contains the private, local, read-only registry scaffold described by [`docs/adr/0002-private-registry-node.md`](../docs/adr/0002-private-registry-node.md) and [`docs/registry-node-security-contract.md`](../docs/registry-node-security-contract.md).

Implemented now:

- fail-closed `MVP_LOCAL_READ_ONLY` configuration;
- loopback-only HTTP listener;
- deterministic `/.well-known/open-radio-registry` with ETag/304;
- local-only `/health/live` and `/health/ready`;
- a forward-only, hash-verified SQLite/FTS5 migration chain (schema 2);
- bounded signed-envelope ingest for station, node, and observation records: protocol validation, deterministic provenance, append-only record storage, orphan admission, quarantine for invalid or unadmitted documents, and local admission/suppression policy;
- a deterministic station materializer with a bounded queue, an FTS5 projection that is rebuildable from the immutable records, and `verify`/`rebuild` commands that never repair derived state from unsigned data;
- offline database checks and SQLite online backup/restore validation;
- zero npm dependencies and a Node test harness.

Not implemented and therefore not advertised: the record and search HTTP APIs, snapshots, import, public writes, federation, station probing, public listeners, credentials, deployment, or a NixOS service module.

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

## Ingest and materialize

Ingesting a signed envelope is a local administrator operation on the store, not an HTTP route: the listener still serves discovery and health only. Every write command refuses to run when the database schema is not current, so a stale database fails closed instead of drifting.

```sh
# An envelope file, or `-` to read it from stdin.
make registry-ingest ENVELOPE=/path/to/envelope.json SOURCE=admin
make registry-ingest ENVELOPE=- SOURCE=peer-a < envelope.json

# Projection inspection and maintenance (derived state only; records are never rewritten).
make registry-drain LIMIT=16
make registry-station STATION=oradio:station:ed25519:...
make registry-check-projection
make registry-rebuild

# Local policy: admitted records materialize, suppressed records stay stored but invisible.
make registry-set-policy RECORD=sha256:... STATE=suppressed REASON=admin_suppressed
```

`check-projection` recomputes every station from the immutable records and exits non-zero when a stored row does not match, listing the differing sections. `rebuild` reconciles those rows, including stray rows for stations whose records are gone, and is a no-op when the projection is already correct. A record that this node cannot interpret (unknown critical member) is stored, relayed, and reported, but never materialized; tombstones remove a station from the projection without deleting any record.
