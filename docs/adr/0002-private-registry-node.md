# ADR-002: private registry-node runtime and persistence

Status: Accepted for the `MVP_LOCAL_READ_ONLY` scaffold.

## Context

The registry must preserve bounded `oradio/1` envelopes and provenance, materialize a deterministic station DAG, rebuild local search without network access, and keep public writes, federation, and station checking outside the first private node. The existing protocol verifier is dependency-free Node ESM. The repository's pinned Node must provide SQLite and FTS5.

## Decision

Use one Node.js 24 process with zero npm runtime dependencies and exactly one `node:sqlite` `DatabaseSync` connection to one local SQLite database. Pin Node `>=24.15 <25` through the repository flake. Keep extension loading disabled, defensive mode enabled, foreign keys enabled, `trusted_schema=OFF`, `synchronous=FULL`, and `journal_mode=DELETE`.

The architecture evaluation used host Node 24.15 with SQLite 3.51.2, inside the affected range of the SQLite WAL-reset corruption defect. The repository flake now locks Node 24.20 with SQLite 3.53.3, but the scaffold still forbids WAL and multiple database connections until checkpoint/concurrency tests are added. A safe library version is necessary but not sufficient to widen the persistence model.

The service boundaries are:

- `protocol`: reuse `protocol/v1/lib/conformance.mjs`; API handlers must not duplicate parsing, canonicalization, identity, or signature rules;
- `store`: immutable canonical payload/envelope bytes, provenance, local policy, migrations, backup, and integrity checks;
- `materializer/search`: durable queue plus rebuildable DAG/projection/FTS tables;
- `http`: bounded read-only resources, cache validators, operational liveness/readiness, and no SQL or cryptography.

The scaffold serves only discovery and operational health. Protocol feeds, node card, station lookup, and search remain absent until their storage/materialization behavior is implemented and tested. This is preferable to placeholder responses that overstate capabilities.

## Storage contract

`registry-node/migrations/` contains numbered immutable SQL migrations. Applied filename and SHA-256 are recorded in `schema_migrations`; startup tooling rejects changed hashes, gaps, ledger/version disagreement, or a database newer than the binary. Every migration runs in its own `BEGIN IMMEDIATE` transaction, updates `user_version`, and is followed by `quick_check` and `foreign_key_check`. There are no automatic down migrations.

The initial schema separates:

- immutable `records` and `record_parents`;
- mutable provenance and local policy in `record_sources` and `record_policy`;
- invalid bounded input in `quarantine`, never in records/search;
- durable materialization work in `materialize_queue`;
- explicit tips/state in `station_tips` and `station_state`;
- rebuildable projection/filter/FTS data in `station_projection`, `station_streams`, `station_tags`, `station_languages`, `projection_meta`, and `station_fts`.

Parent IDs intentionally have no foreign key so valid orphans can persist. Canonical payload and accepted relay envelope are BLOBs. Projection and FTS data are derived and must remain rebuildable offline.

Backups use Node's SQLite online backup API, never a live-file copy. A backup is accepted only after an offline read-only integrity/foreign-key check and a SHA-256 digest. Restore validation opens only the candidate copy and performs no network access.

## HTTP and configuration contract

The only implemented mode is `MVP_LOCAL_READ_ONLY`. Its listener accepts loopback hostnames/addresses only. The public descriptor base must be HTTPS. Effective configuration has `writesEnabled=false`, `networkProbesEnabled=false`, `federationEnabled=false`, `peerWorkers=0`, and `stationCheckerWorkers=0`. Attempts to enable an unimplemented mode fail before listening. Unknown `BAREBUH_*` variables fail closed.

`GET /.well-known/open-radio-registry` is deterministic and cacheable with a strong ETag. `GET /health/live` tests process/event-loop viability only. `GET /health/ready` checks only the local database/schema. Neither endpoint resolves DNS, opens outbound connections, checks a station, or waits for a peer. Mutation methods return 405 and there are no mutation handlers.

## Consequences

This is deliberately synchronous and low-concurrency. It minimizes semantic duplication and operational dependencies but is not a second independent protocol implementation. It does not approve a public listener, public writes, federation, health checking, node-key custody, deployment, or station probing.

Upgrade to workers, WAL, or PostgreSQL only after measurements demonstrate a need and the atomic ingest/projection contract has equivalent tests.
