# Barebuh registry-node scaffold

This directory contains the private, local, read-only registry scaffold described by [`docs/adr/0002-private-registry-node.md`](../docs/adr/0002-private-registry-node.md) and [`docs/registry-node-security-contract.md`](../docs/registry-node-security-contract.md).

Implemented now:

- fail-closed `MVP_LOCAL_READ_ONLY` configuration plus the opt-in `PRIVATE_PINNED_FEDERATION` mode;
- loopback-only HTTP listener;
- deterministic `/.well-known/open-radio-registry` with ETag/304;
- local-only `/health/live` and `/health/ready`;
- a forward-only, hash-verified SQLite/FTS5 migration chain (schema 3);
- bounded signed-envelope ingest for station, node, and observation records: protocol validation, deterministic provenance, append-only record storage, orphan admission, quarantine for invalid or unadmitted documents, and local admission/suppression policy;
- a deterministic station materializer with a bounded queue, an FTS5 projection that is rebuildable from the immutable records, and `verify`/`rebuild` commands that never repair derived state from unsigned data;
- the bounded read API: the signed node card relayed under its signed lifetime, station and health views with provenance, policy, and freshness, and a deterministic paged search over the projection, all with strong ETags, `304` handling, and one closed error envelope;
- a disabled-by-default authenticated submission boundary that refuses every request before reading a body byte;
- pinned pull federation: the read-only records feed and snapshot recovery views, explicit operator pins, and a bounded, strictly sequential pull replicator with per-item verification, quarantine evidence, atomic page/cursor commits, provenance, deduplication, budgets, jittered backoff, and a per-peer circuit breaker;
- offline database checks and SQLite online backup/restore validation;
- zero npm dependencies and a Node test harness.

Not implemented and therefore not advertised: bulk record import (`PUT`/bulk transfer), public writes, station probing or any health fetcher, public listeners, credentials, DNS-based peer discovery and peer-of-peer admission, deployment, or a NixOS service module.

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

The public base is descriptor data and must be HTTPS even though the development listener itself is loopback HTTP. The placeholder `.invalid` origin prevents accidental publication. Unknown `BAREBUH_*` settings stop startup, and the risky switches stay fail-closed: writes and network probes cannot be enabled at all, `BAREBUH_FEDERATION_ENABLED=true` is refused unless the mode is `PRIVATE_PINNED_FEDERATION`, and that mode in turn refuses to start with federation switched off. Non-loopback binding is refused in every mode.

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
| `GET /v1/records?...` | the append-only record feed (pinned-federation mode only) |
| `GET /v1/snapshot?...` | snapshot recovery over the complete retained set (pinned-federation mode only) |
| `GET /v1/stations/{key}` | the signed station snapshot with provenance, policy, and freshness |
| `GET /v1/health/{key}` | the local health badge plus the observations this node stores |
| `POST /v1/records` | the submission boundary: always `403 submission_disabled` |

`/v1/node` requires `BAREBUH_NODE_ID` to match an admitted, unexpired node card; without one it answers `503 node_card_unavailable`, and past the signed expiry `503 node_card_expired`. Nothing is signed or refreshed on the fly.

Search parameters: `q` (up to 8 terms of 64 bytes over name and tags; a query with no searchable terms behaves like no text filter), the bounded repeated filters `tag`, `language`, `codec`, and `country` (ANDed across classes, ORed within one class), `healthy=true|false` over the local health badge, `limit` (1-1000, default 100), and the opaque `cursor`. Anything else, including duplicates, is rejected with `400 invalid_parameter`.

```sh
curl -s "http://127.0.0.1:8787/v1/search?tag=jazz&healthy=true&limit=64"
curl -s "http://127.0.0.1:8787/v1/stations/<station-key-digest>"
curl -sD- -o /dev/null "http://127.0.0.1:8787/v1/search?limit=64"   # ETag; resend it as If-None-Match for a 304
```

Paging is stateless: `next_cursor` and `has_more` come back with every page, and `query_snapshot` identifies the result view the page was cut from. The order is score descending, normalized name ascending, then station ID ascending, compared as UTF-8 bytes, so pages never reorder and a replica reproduces them exactly. A cursor is opaque (clients must not parse or compare it), bound to the feed and the exact filter that minted it, and expires; a foreign filter is answered `400 cursor_binding_mismatch` and an unreadable, stale, or expired cursor `400 cursor_invalid`, after which clients restart from the first page. Only active stations are listed: tombstones, suppression, quarantine holds, orphans, and records this node cannot interpret stay out of the listing and are reported by state on the station view instead.

The bundled desktop client refreshes this node with one pinned request (`/v1/search?limit=64`) and rejects any page it cannot fully accept, so a page served to it stays inside the client's single-page bounds: at most 64 items and 64 KiB, `has_more=false`, per item at most 32 tip IDs with the full head count in `tips_total`, and station tags bounded at 32 tags of 64 UTF-8 bytes each. The tag bound is the ingest bound (`protocol/v1/lib/conformance.mjs`, matching `src/radios/barebuhsearchparser.cpp`): a record with a larger tag is quarantined as invalid input and never served, because a single oversized tag would make the client drop the whole listing. A listing that does not fit one page - more than 64 active stations, or a page beyond 64 KiB - cannot refresh that client until it implements paging, so an operator serving it keeps the listing inside these bounds.

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

## Pinned federation

Federation is a separate mode, and every pull source is an explicit operator pin. `MVP_LOCAL_READ_ONLY` performs no outbound HTTP and serves no feed route.

```sh
BAREBUH_MODE=PRIVATE_PINNED_FEDERATION \
BAREBUH_FEDERATION_ENABLED=true \
BAREBUH_NODE_ID=oradio:node:ed25519:... \
BAREBUH_DATABASE_PATH="$PWD/var/registry.sqlite3" \
node registry-node/src/cli.mjs serve
```

In this mode the same read API additionally serves the two replication routes; in the default mode they answer `404`, exactly as if they did not exist:

| Route | Purpose |
| --- | --- |
| `GET /v1/records?kinds=&limit=&cursor=` | the append-only record feed (`station`, `node`, `observation`) |
| `GET /v1/snapshot?kinds=&limit=&cursor=` | snapshot recovery over the complete retained set |

Both routes share one query surface: `limit` (1-1000, default 100), the optional sorted `kinds` filter, and the opaque `cursor`. Pages carry `items`, `has_more`, `next_cursor`, and `checkpoint`. A cursor is opaque and bound to the feed, the filter, and the position's anchor record; it expires after 15 minutes, and an expired cursor - or one whose anchor no longer exists here - is answered `410 cursor_expired`/`410 cursor_stale` with the snapshot URL to recover from, never as a shifted page. A snapshot pins the feed head when it starts, so a multi-page import stays stable while the feed keeps appending; its final `checkpoint` is the feed position a consumer resumes from. The feed relays stored records only: quarantine evidence, local policy, and projections are local state and never leave the node.

Operator surface:

```sh
make registry-peer-add PEER=oradio:node:ed25519:... BASE=https://peer.example/v1/ LABEL=peer-b
make registry-peer-list
make registry-replicate                      # every pinned peer, strictly sequentially
make registry-replicate PEER=oradio:node:ed25519:...
make registry-peer-remove PEER=oradio:node:ed25519:...
```

`registry-replicate` prints one bounded outcome per peer (status, pages, items, stored, duplicates, quarantined, retry time, error code) and drains the materialize queue in the same run, so the projection converges without a second command. It exits non-zero when any peer's pull failed, so a scheduler notices without parsing JSON; a peer that was skipped because of its own backoff or open circuit is not a failure.

Pull behaviour, per peer and per run:

- the pinned identity must be proven before any record is pulled: the peer's signed node card is fetched from the pinned origin, verified locally, and must name the pinned node ID and support API major 1. The card is never stored, and nothing it says about other bases or peers is followed - admission is explicit and non-transitive, so a hostile peer cannot make this node contact a third party;
- every item is re-verified locally: bounded JSON, canonical payload, self-certifying station identity, Ed25519 proof, freshness rules, and a recomputed record ID that must equal the published one. An item that fails becomes bounded quarantine evidence (with the peer as its source) while its valid siblings are stored: a malformed sibling can neither hide its neighbours nor disappear;
- the page and its cursor commit in one transaction, so a crash before `COMMIT` leaves neither a stored record nor an advanced cursor, and replaying the page afterwards is safe because records are content-addressed;
- a corrupt page (unparsable, wrong shape, oversized, or a cursor that does not advance) fails the attempt and changes nothing;
- budgets: 100 records per requested page, 1 MiB per decoded response, a 10-second request timeout, at most 16 pages and 2000 items per peer per run, and at most 32 snapshot pages; a peer that never ends is stopped, not followed;
- reputation is persisted per peer: consecutive failures, an exponential backoff window with equal jitter (5-minute cap) that honors a bounded `Retry-After`, and a circuit breaker that opens after 3 consecutive failures for 15 minutes. While a peer is in backoff or open, no network I/O happens for it at all;
- peers are a bulkhead: pulls are strictly sequential, one failed peer never aborts another's pull or the run, and per-peer state is never shared. Pins are capped at 32.

Records a peer delivered keep their provenance (`peer` + node ID) and stamp the station's `last_replication_at` when a projection row exists; `GET /v1/stations/{key}` and `GET /v1/health/{key}` report both. Pulling never enables publishing: `POST /v1/records` stays `403 submission_disabled` in every mode, and no configuration, header, or document can change that.
