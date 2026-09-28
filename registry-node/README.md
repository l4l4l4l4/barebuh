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
- the bounded read API: the signed node card relayed under its signed lifetime, station and health views with provenance, policy, and freshness, and a deterministic paged search over the projection, all with strong ETags, `304` handling, and one closed error envelope;
- a disabled-by-default authenticated submission boundary that refuses every request before reading a body byte;
- offline database checks and SQLite online backup/restore validation;
- zero npm dependencies and a Node test harness.

Not implemented and therefore not advertised: the read-only record feed, snapshots, import, public writes, federation, station probing or any health fetcher, public listeners, credentials, deployment, or a NixOS service module.

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
BAREBUH_NODE_ID=oradio:node:ed25519:... \
node registry-node/src/cli.mjs serve
```

`BAREBUH_NODE_ID` is optional: without it the node serves its read APIs but no node card.

The public base is descriptor data and must be HTTPS even though the development listener itself is loopback HTTP. The placeholder `.invalid` origin prevents accidental publication. Unknown `BAREBUH_*` settings and attempts to enable writes, network probes, federation, non-local modes, or non-loopback binding stop startup.

Backup and validate without copying a live database file:

```sh
make registry-backup REGISTRY_DB="$PWD/var/registry.sqlite3" BACKUP="$PWD/var/registry.backup.sqlite3"
make registry-restore-check RESTORE="$PWD/var/registry.backup.sqlite3"
```

## Read API

The listener is read-only, loopback-only, and serves exactly the routes below. Every response is a JSON object or the shared bounded error envelope `{"error": {"code", "message", "details"?}, "request_id"}`; every route bounds and validates its own input before the store is touched. `{key}` is either the station key digest or the full `oradio:station:ed25519:...` identity.

| Route | Purpose |
| --- | --- |
| `GET /.well-known/open-radio-registry` | this node's descriptor (`max-age=300`, ETag/304) |
| `GET /health/live`, `GET /health/ready` | local liveness and readiness |
| `GET /v1/node` | the configured node's signed card, byte-for-byte, until its signed expiry |
| `GET /v1/search?...` | deterministic paged search over the materialized projection |
| `GET /v1/stations/{key}` | the signed station snapshot with provenance, policy, and freshness |
| `GET /v1/health/{key}` | the local health badge plus the observations this node stores |
| `POST /v1/records` | the submission boundary: always `403 submission_disabled` |

`/v1/node` requires `BAREBUH_NODE_ID` to match an admitted, unexpired node card; without one it answers `503 node_card_unavailable`, and past the signed expiry `503 node_card_expired`. Nothing is signed or refreshed on the fly.

Search parameters: `q` (up to 8 terms of 64 bytes over name and tags; a query with no searchable terms behaves like no text filter), the bounded repeated filters `tag`, `language`, `codec`, and `country` (ANDed across classes, ORed within one class), `healthy=true|false` over the local health badge, `limit` (1-1000, default 64), and the opaque `cursor`. Anything else, including duplicates, is rejected with `400 invalid_parameter`.

```sh
curl -s "http://127.0.0.1:8787/v1/search?tag=jazz&healthy=true&limit=64"
curl -s "http://127.0.0.1:8787/v1/stations/<station-key-digest>"
curl -sD- -o /dev/null "http://127.0.0.1:8787/v1/search?limit=64"   # ETag; resend it as If-None-Match for a 304
```

Paging is stateless: `next_cursor` and `has_more` come back with every page, and `query_snapshot` identifies the result view the page was cut from. The order is score descending, normalized name ascending, then station ID ascending, compared as UTF-8 bytes, so pages never reorder and a replica reproduces them exactly. A cursor is opaque (clients must not parse or compare it), bound to the feed and the exact filter that minted it, and expires; a foreign filter is answered `400 cursor_binding_mismatch` and an unreadable, stale, or expired cursor `400 cursor_invalid`, after which clients restart from the first page. Only active stations are listed: tombstones, suppression, quarantine holds, orphans, and records this node cannot interpret stay out of the listing and are reported by state on the station view instead.

Health is reported, never probed: without a live observation the badge is `unknown` with `expires_at: null`, and an expired observation decays back to `unknown` rather than to a failure. `healthy=true` matches only a live `ok` badge; `healthy=false` matches everything else, including unknown. The badge is always the newest admitted observation by this node; observations from other nodes are listed for transparency and never rank stations here.

```sh
# Page three through a filter, then repeat it to confirm nothing moved.
curl -s "http://127.0.0.1:8787/v1/search?country=US&limit=64"
curl -s "http://127.0.0.1:8787/v1/search?country=US&limit=64&cursor=<next_cursor>"
```

## Ingest and materialize

Ingesting a signed envelope is a local administrator operation on the store, not an HTTP route: the listener serves discovery, health, and the read APIs only, and never accepts records. Every write command refuses to run when the database schema is not current, so a stale database fails closed instead of drifting.

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
