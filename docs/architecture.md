# Barebuh Architecture

Status: proposed MVP architecture

Barebuh (aka Dingleberry) is a fork of
[Strawberry Music Player](https://www.strawberrymusicplayer.org/). Strawberry
and this fork are free software distributed under the GNU General Public
License, version 3 or later. Existing Strawberry copyright and license notices
remain authoritative and must be retained. See [`COPYING`](../COPYING).

## Purpose

Barebuh adds an open, federated internet-radio directory to Strawberry without
turning the desktop player into a federation server. Registry nodes exchange
signed station records over HTTPS. The desktop client queries one configured
node, stores a last-known-good projection, and sends selected stream URLs
through Strawberry's existing radio and playlist paths.

The design separates four kinds of authority:

- a station key controls that station's signed metadata history;
- a node key authenticates a registry node and its health observations;
- each node operator controls admission, ranking, peer trust, and moderation;
- each listener controls the node and streams used by their client.

A valid signature proves control of a key and integrity of a record. It does
not prove that metadata is accurate, a stream is safe, or an operator has the
legal right to publish it.

## MVP boundary

### Included

- HTTPS discovery through `/.well-known/open-radio-registry`;
- immutable, content-addressed, Ed25519-signed station records;
- pull replication between explicitly configured registry peers;
- deterministic materialization of station record DAGs;
- node-local search and node-signed health observations;
- offline, last-known-good data with visible age and provenance;
- a feature-gated Strawberry integration that renders a flat station list in
  the existing Radios view and uses existing playlist behavior;
- strict input limits, provenance, quarantine, local moderation, and a health
  checker isolated from the registry control plane.

### Excluded

- global consensus, transitive trust, votes, popularity, or recommendations;
- listener accounts, listener telemetry, or client-generated health reports;
- synchronous federated search or push federation;
- automatic lost-key recovery, global deletion, or global blocklists;
- recursive playlist resolution, remote artwork proxying, or arbitrary URL
  schemes in the checker;
- ActivityPub, DNS, DHT, or CRDT as the v1 transport;
- schedules, programs, social features, and a dedicated Barebuh client tab.

## System context

```text
Station publisher
  | signed station envelopes
  v
Registry node <---- pull replication ----> Explicitly admitted peer nodes
  |   |                                      |
  |   +--> isolated health checker --------> public stream origins
  |
  +---- HTTPS search/station responses ----> Barebuh desktop client
                                                |
                                                v
                                      Strawberry radio/playlist/player
                                                |
                                                v
                                         public stream origin
```

The node path and playback path are intentionally separate. Registry API
credentials, if a private deployment uses them, are never forwarded to a
station stream origin.

## Registry node components

### HTTPS API and discovery

The API terminates TLS, serves the well-known descriptor, bounded feeds,
snapshots, station projections, local search, and health views. Successful GET
responses use cache validators. No request handler waits for a federation peer.

### Verification and immutable store

The verifier performs bounded I-JSON parsing, RFC 8785 canonicalization,
content-hash recomputation, self-certifying identity checks, and Ed25519
verification before admission policy. The immutable store retains original
signed envelopes, local receipt metadata, and provenance. Unsupported critical
semantics are preserved for relay but are not materialized.

### DAG materializer and search index

Each station has a record DAG. Orphans remain quarantined until all parents are
available. The winning tip is selected deterministically by sequence and record
ID. The search index contains only locally admitted winning snapshots. Indexing
is asynchronous and rebuildable from verified records.

### Replicator

The replicator pulls bounded pages from pinned peers using peer-specific opaque
cursors. It stores an entire page before advancing the cursor. Record ID
deduplication makes retries and relay loops idempotent. Expired cursors recover
through a snapshot and checkpoint.

### Health scheduler and checker

The scheduler coalesces work by origin and applies quotas, jitter, backoff, and
circuit breakers. The checker is a separate, disposable, unprivileged process
or service with public-Internet-only egress and no access to signing keys,
databases, local networks, metadata services, credentials, or ambient proxies.
Health observations are signed by the observing node and never mutate
station-owned metadata.

### Policy and moderation

Admission, peer trust, suppression, ranking, legal action, and advisory-list
subscriptions are local policy. Cryptographic validity is evaluated before
policy. Origin tombstones, local suppression, and third-party advisories are
distinct states with distinct audit trails.

## Desktop client integration

The smallest maintainable Strawberry integration is a feature-gated
`BarebuhService : RadioService`.

- Add a new append-only `Song::Source::Barebuh` value; never renumber persisted
  source values.
- Register the service in `RadioServices`; let `RadioModel` group it by source.
- Parse API responses in a pure helper, then convert station summaries to
  `RadioChannel` and `Song` objects.
- Reuse `RadioMimeData`, `RadioView`, `MainWindow::AddToPlaylist`, and
  `RadioStreamPlaylistItem` for drag, double-click, append, replace, and new
  playlist behavior.
- Use the application-owned `NetworkAccessManager`. API requests use the
  configured HTTPS base URL, `AlwaysNetwork`, and no HTTP cache storage for
  authenticated responses.
- Store secrets only through `CredentialsManager` under the `barebuh` service
  key. Keep the endpoint, enabled flag, and non-secret account label in
  settings. Never attach API authorization to playback URLs.
- Load cached rows immediately, refresh in the background, and replace rows
  transactionally per source only after a semantically valid response.
  Transport, authentication, parsing, and invalid-empty failures retain stale
  rows.

Relevant Strawberry seams are:

- `src/radios/radioservice.{h,cpp}` for the service contract and JSON helpers;
- `src/radios/radioservices.cpp` for registration and refresh orchestration;
- `src/radios/radiobackend.cpp` for persistent channel replacement;
- `src/radios/radiomodel.cpp` and `src/radios/radioview.cpp` for presentation;
- `src/playlist/playlist.cpp` and `src/playlist/playlistitem.cpp` for playback;
- `src/core/song.{h,cpp}` for persisted source identity;
- `src/core/application.{h,cpp}` for network and credential dependencies;
- `src/settings/radiosettingspage.{cpp,ui}` for configuration;
- `CMakeLists.txt`, `src/config.h.in`, and `data/icons.qrc` for feature wiring.

The MVP does not generalize the provider-specific Radio Browser search classes
and does not add a top-level sidebar, collection backend, streaming-service
stack, or bespoke playlist type.

## Data ownership and failure behavior

| Data | Authority | Persistence | Failure behavior |
| --- | --- | --- | --- |
| Signed station envelope | Station root key | Immutable node store | Reject or quarantine; never repair unsigned |
| Node card | Node root key | Cached until expiry | Stop new sync; retain verified station data |
| Peer cursor | Local node | Durable per peer/filter | Replay last page after crash |
| Search projection | Local node policy | Rebuildable | Serve prior committed projection |
| Health observation | Observer node key | Short-lived | Age to unknown, never infer down |
| Client station rows | Configured node plus client cache | Per source | Show last-known-good with data age |
| Registry credential | User/keychain | Credential manager only | Fail closed; do not erase cache |

## Architecture decisions

### ADR-001: HTTPS pull federation

Decision: use ordinary HTTPS, a well-known descriptor, immutable signed JSON,
and pull feeds.

Rationale: it works behind common web servers and CDNs, supports caching and
bounded pagination, is debuggable, and preserves offline verification.
ActivityPub adds social actors, inbox delivery, retries, and JSON-LD without
solving durable record authentication. DNS is useful only for bootstrap. A DHT
would make churn, Sybil resistance, privacy, moderation, and secondary search
MVP requirements.

### ADR-002: object signatures are authoritative

Decision: sign canonical record payloads rather than relying on request
signatures.

Rationale: records must remain verifiable after replication and while offline.
TLS still authenticates the contacted origin and protects transport.

### ADR-003: full snapshots in a deterministic DAG

Decision: every station update is a full snapshot with parent record IDs.
Winner selection uses highest sequence, then lexicographically smallest record
ID; multiple tips are visibly forked.

Rationale: immutable snapshots simplify verification, replication, offline
materialization, and convergence. Wall-clock time is not an authority signal.

### ADR-004: local policy, no federated consensus

Decision: nodes independently admit peers and records and independently rank,
suppress, or retain them.

Rationale: keys are cheap, so signatures, votes, and node counts cannot prevent
Sybil control. A received record is not an endorsement.

### ADR-005: desktop client consumes projections

Decision: the Strawberry fork queries a configured node and does not implement
peer replication in the MVP.

Rationale: this preserves Strawberry's architecture and limits security and
maintenance risk. Node software owns federation, verification, search, and
moderation.

### ADR-006: safe stale data is better than destructive refresh

Decision: caches are replaced atomically per source only after complete semantic
validation.

Rationale: the current global asynchronous radio refresh can erase useful data
on failure. Barebuh must remain usable during node or network outages.

## Evolution

Compatible v1 extensions may add delegated update keys, threshold recovery,
Merkle set reconciliation, compressed transfer, signed opt-in advisories, and
pull-trigger hints. DNS-SD/SVCB and ActivityPub may be adapters. A breaking
change to canonicalization, identity, signatures, or DAG conflict rules
requires a new protocol major version. Immutable v1 records remain verifiable.
