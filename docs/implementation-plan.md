# Barebuh Implementation Plan

Status: proposed delivery plan

Barebuh is a fork of Strawberry Music Player. The fork and retained Strawberry
code are distributed under the GNU General Public License, version 3 or later.
Preserve all existing copyright, author, and license notices and keep
[`COPYING`](../COPYING) in distributions.

This plan covers the protocol reference assets, a registry node, and the
Strawberry desktop integration. The components may be delivered in separate
repositories, but protocol schemas and conformance vectors must have one
versioned source of truth.

## Delivery principles

- Build the verifier and fixtures before federation or public writes.
- Treat signed records as immutable; rebuild projections instead of repairing
  them with unsigned state.
- Keep node policy, station authority, and client preferences separate.
- Land last-known-good cache semantics before advertising offline resilience.
- Keep the Strawberry patch additive, feature-gated, and easy to rebase.
- Do not enable server-side health checks until the isolated egress test suite
  passes.
- Public federation is a release gate, not a default development mode.

## Work breakdown and dependency graph

```text
P0 Protocol decisions
 |
 +--> P1 Schemas + canonical fixtures --> P2 Verifier library
 |                                      |       |
 |                                      |       +--> N1 Immutable store + DAG
 |                                      |       |      |
 |                                      |       |      +--> N2 Materializer/search
 |                                      |       |      +--> N3 Feed/snapshot API
 |                                      |       |             |
 |                                      |       |             +--> N4 Pull replicator
 |                                      |       |
 |                                      |       +--> N5 Signed node cards
 |                                      |
 |                                      +--> C1 Client response parser
 |                                              |
 |                                              +--> C2 Strawberry service/UI path
 |                                                     |
 |                                                     +--> C3 LKG cache semantics
 |
 +--> S1 URL policy --> S2 Isolated checker --> S3 Signed observations
 |
 +--> O1 Local policy/moderation --> O2 Public-write controls
 |
 +--> R1 Interop + abuse harness
         ^          ^          ^          ^
         |          |          |          |
       N4/C3      S3/O2     backups    second implementation

Public federation release = R1 passes + every P0 launch gate in threat-model.md
```

No task that exposes public submissions or probes may bypass its security
predecessors. The desktop client can ship against a private fixture node after
C3, before public federation.

## Phase 0: resolve protocol-owner decisions

Record the decisions as ADRs before implementation:

1. Final public protocol namespace and naming; `oradio/1` is provisional.
2. Root-only signing for MVP versus delegated update keys at launch. The current
   baseline is root-only with tombstone-and-new-identity recovery.
3. Publisher key UX and custody. A registry must not silently become custodian.
4. Stream policy for insecure HTTP and non-80/443 playback ports. Automated
   checker policy remains stricter than client playback policy.
5. Observation replication and weighting defaults.
6. Snapshot/history retention under legal deletion requirements.
7. Seed governance, diversity, and emergency removal.
8. Search normalization and controlled vocabularies.
9. Whether unauthenticated `POST /v1/records` is omitted, invite-only, or public.
10. First-node operator entity, jurisdiction, and moderation escalation policy.

Exit criteria: approved ADRs, named owners, and no unresolved choice that changes
identity, canonical bytes, signatures, DAG ordering, or launch jurisdiction.

## Phase 1: normative protocol assets

Deliver:

- JSON Schemas for station envelopes, node cards, observations, feed pages,
  snapshots, station projections, search results, and error envelopes;
- semantic validation rules not expressible in JSON Schema;
- canonical JSON bytes, hashes, valid/invalid signatures, identity derivation,
  DAG, fork, tombstone, extension, cursor, and pagination fixtures;
- a machine-readable limits profile;
- a conformance runner consumable by at least two languages;
- a versioning and compatibility policy.

Exit criteria: two independent implementations agree on canonical bytes,
record IDs, signatures, identities, and winner selection for every fixture.

## Phase 2: verifier and local registry core

Implement in this order:

1. Bounded I-JSON parser and schema selection.
2. RFC 8785 canonicalization and SHA-256 record IDs.
3. Ed25519 identity and proof verification.
4. Immutable envelope/provenance store with idempotent insert.
5. Parent/orphan tracking and deterministic DAG materializer.
6. Tombstone and unsupported-critical semantics.
7. Rebuildable local search projection.
8. Signed node card and well-known descriptor.
9. Read-only station and search APIs with ETag support.

Keep immutable record bytes, normalized searchable fields, and local policy state
in separate tables or domains. A projection rebuild must not require a network
call.

Exit criteria: ID, signature, DAG, tombstone, extension, deterministic search,
restart, migration, and corrupted-projection rebuild tests pass.

## Phase 3: bounded feeds and pull federation

Implement:

- append-only bounded records feed;
- opaque, peer/filter-bound cursors;
- complete bounded snapshot plus checkpoint;
- atomic page-store/cursor commit;
- per-peer budgets, quotas, backoff, jitter, and circuit breakers;
- content-hash loop deduplication;
- explicit peer admission and non-transitive peer discovery;
- provenance and last-replication visibility;
- periodic snapshot comparison and `410 Gone` recovery.

Exit criteria: crash replay loses no record, A-to-B-to-C-to-A relays quiesce,
expired-cursor recovery converges, corrupt pages do not replace prior state, and
one failed peer cannot exhaust other bulkheads.

## Phase 4: Strawberry client integration

### Change set A: source and build wiring

- Add `optional_component(BAREBUH ON "Radio: Barebuh client")` near the radio
  options in `CMakeLists.txt`.
- Add `#cmakedefine HAVE_BAREBUH` to `src/config.h.in`.
- Follow the current conditional `list(APPEND SOURCES HEADERS UI ...)` pattern;
  do not restore the removed `optional_source` helper.
- Append `Barebuh = 15` to `Song::Source`, update source-count assertions and all
  exhaustive source switches, and never renumber existing values.
- Add guarded service, parser, constants, tests, icons, and resource entries.

### Change set B: service and response parser

- Implement a pure bounded parser for one deterministic `/v1/search` response.
- Require HTTPS for the configured API endpoint.
- Use `QUrl` and `QUrlQuery`, the shared `NetworkAccessManager`, finite request
  timeouts, and bounded response bytes.
- Create `BarebuhService : RadioService`, convert accepted hits to
  `RadioChannel`, and register it in `RadioServices`.
- Include stable name, selected playback URL, station ID/provenance in available
  metadata, optional thumbnail only when remote artwork policy is implemented,
  and visible stale/fork/health state when the current UI can represent it.
- Never expose secrets in errors and never send API authorization to a playback
  URL.

For the flat-list MVP, use a deterministic broad query or a dedicated bounded
listing contract supplied by the configured node. Do not simulate federation in
the desktop client and do not refactor the Radio Browser search UI.

### Change set C: settings and credentials

- Add endpoint and enabled controls to the existing Streaming > Radios page.
- Keep non-secret settings in QSettings-compatible constants.
- If private-node authentication is required, use `CredentialsManager` with
  service key `barebuh` and its asynchronous API.
- Reload through the existing `SettingsDialog::accept` to
  `RadioServices::ReloadSettings` path.

### Change set D: last-known-good cache

Refactor `RadioBackend` and refresh orchestration so that a source refresh:

1. loads cached source rows immediately;
2. fetches and parses into a temporary complete set;
3. distinguishes valid empty from transport/auth/parse failure;
4. deduplicates by `(source, url)`;
5. transactionally replaces only that source after semantic success;
6. leaves every other provider unchanged;
7. retains stale rows and exposes age on failure.

Do not cache credentials or expiring signed media URLs.

### Change set E: playlist and presentation integration

- Add Barebuh cases to both playlist-item factories.
- Include Barebuh in `Song::is_radio` and relevant icon/cover source switches.
- Verify that `RadioModel` source grouping and `RadioMimeData` produce the
  existing drag, double-click, append, replace, and new-playlist behavior.
- Add branded icons at the repository's existing sizes and include them in
  `data/icons.qrc`.

Exit criteria: builds with `ENABLE_BAREBUH` on and off, all targeted tests pass,
an offline restart displays cached stations, a failed refresh preserves them,
and playback uses the existing radio-stream playlist path without API headers.

## Phase 5: health checking

Implement application-layer URL policy first. Then provision the checker as a
separate egress-only runtime with no ambient credentials, proxy variables,
private routes, control-plane access, database socket, or signing-key access.
Add:

- DNS/IP validation and vetted-address connection pinning;
- ports 80/443 only, no redirects, no recursive playlists, no artwork;
- tiny ranged requests, strict time/byte/header/decompression limits;
- per-origin coalescing, cadence, jitter, quotas, and opt-out;
- bounded diagnostic enums without raw response bodies;
- node-signed observations with short expiry;
- local-only default health ranking.

Exit criteria: every SSRF and resource-exhaustion test in the threat model
passes at both application and egress-firewall layers.

## Phase 6: moderation and operational readiness

Deliver before public writes or federation:

- separate peer-access, record-admission, observation-trust, and block states;
- quarantine queue, local allow/suppress controls, and immutable audit events;
- authenticated, least-privilege moderation UI with inert rendering;
- exact-scope, expiring, opt-in advisory support only if required;
- abuse and security contacts plus `security.txt`;
- notice, emergency suppression, appeal, reinstatement, and protected-evidence
  procedures;
- terms, privacy/data inventory, retention schedule, and legal review;
- metrics and alerts for queues, disk, verifier failures, peers, cursors, and
  checker saturation;
- tested backup, restore, read-only mode, key compromise response, seed removal,
  and rollback runbooks.

Exit criteria: operational exercises pass and all launch blockers in
[`threat-model.md`](threat-model.md) are closed with evidence.

## Test matrix

| Layer | Required tests | Release gate |
| --- | --- | --- |
| Schema/parser | duplicate keys, UTF-8, number range, depth, size, lists, unknown/critical fields | Every build |
| Crypto | identity derivation, JCS cross-language bytes, record ID, Ed25519 valid/mutation/algorithm cases | Every build; two implementations for release |
| DAG | genesis, orphan arrival, fork order independence, merge, tombstone, restart | Every build |
| Storage | idempotency, transaction rollback, corrupt projection rebuild, migrations | Every build |
| HTTP | schema, ETag/304, limits, errors, 429/Retry-After, opaque cursor/filter binding | Every build |
| Replication | crash replay, loop quiescence, malformed sibling, 410 snapshot recovery, peer isolation | Integration/chaos gate |
| Search | fixed-corpus filters, deterministic tie-break, provenance, freshness, pagination | Every build |
| Observations | signature, expiry, skew, endpoint scope, trusted/local aggregation | Every build |
| SSRF | special IPs, DNS rebinding, mixed answers, redirects, ports, firewall denial | Security gate before checker enablement |
| Fetch limits | slowloris, huge headers/body, compression bomb, wrong MIME, endless stream | Security/load gate |
| Moderation | quarantine, exact suppression, advisory expiry, audit, appeal, permissions | Public-write gate |
| Privacy | traffic/log capture, credential isolation, no stable ID, retention deletion | Release gate |
| Resilience | dead seeds, corrupt delta, disk/queue pressure, bulkheads, backup/restore | Release/operations gate |
| Strawberry parser | valid, malformed, wrong type, missing field, non-HTTPS API, duplicate, valid empty, pagination, secret-free errors | Every client build |
| Strawberry cache | per-source atomic replace, dedupe, other providers preserved, stale retained on each failure class | Every client build |
| Strawberry model | source roles, icon, channel-to-mime, visible state | GUI test gate |
| Strawberry playlist | `ToSong`, Barebuh source identity, radio item factory, playback URL/header separation | Every client build |
| Feature flag | configure/build/test with Barebuh ON and OFF | Client release gate |
| Offline client | restart from cache, data age, stale health to unknown, failed refresh retention | Client release gate |

Keep live network tests out of default CTest. If needed, follow the existing
`lyrics_live_tests` pattern with an explicit, excluded live target.

## Repository verification

For each Strawberry change set:

1. configure and build with Barebuh enabled;
2. build the targeted tests and run them directly or through CTest;
3. configure and build with Barebuh disabled;
4. run `clang-format` on changed C++ files;
5. inspect every `Song::Source` switch and persisted-value assertion;
6. inspect the full diff for credentials, generated churn, and retained license
   headers;
7. commit one reviewable logical change with a clean worktree.

The highest rebase-risk files are `CMakeLists.txt`, `src/core/song.{h,cpp}`,
`src/core/mainwindow.cpp`, `src/radios/radioservices.cpp`,
`src/radios/radiobackend.cpp`, and `src/settings/radiosettingspage.{cpp,ui}`.
Avoid changes to `mainwindow.cpp` and provider-specific Radio Browser classes in
the MVP unless a verified integration gap requires them.

## Release milestones

### M0: protocol fixtures

Schemas, semantic rules, fixtures, limits, and two passing verifier
implementations.

### M1: local read-only node

Verified store, DAG materializer, local search, signed node card, read-only API,
and rebuildable projection.

### M2: private client preview

Feature-gated Strawberry integration against a fixture/private node, with
transactional last-known-good cache and no public writes or health checker.

### M3: private federation

Pinned pull peers, feeds, snapshots, cursor recovery, provenance, quotas,
monitoring, and chaos tests.

### M4: safe health observations

Isolated checker and application/firewall SSRF suite pass; node-signed local
observations are visible but not global truth.

### M5: controlled public pilot

Invite-only submissions, moderation and legal operations, restore/degraded-mode
exercises, privacy verification, independent security review, and every P0 gate
closed. Expansion beyond the pilot requires measured abuse and capacity data.

## Deferred upgrade path

After measured need and separate ADRs:

- root-signed delegated update keys and threshold recovery;
- Merkle set/range reconciliation instead of periodic full snapshots;
- compressed NDJSON pages retaining per-record verification;
- signed opt-in moderation advisories;
- WebSub-style hints that trigger authoritative pull;
- DNS-SD/SVCB bootstrap and ActivityPub adapters;
- remote artwork through a dedicated decode/re-encode sandbox;
- additional checker ports and playlists only with explicit policy and tests;
- a v2 only for breaking identity, canonicalization, signature, or conflict
  semantics.
