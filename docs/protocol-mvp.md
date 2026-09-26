# Barebuh Federation Protocol MVP

Status: implementation draft, not an Internet standard

This document specifies the MVP wire contract for the Barebuh federated radio
registry. Barebuh is a GPL-3.0-or-later fork of Strawberry Music Player.
Existing Strawberry notices remain in force; see [`COPYING`](../COPYING).

Normative terms such as MUST, MUST NOT, SHOULD, and MAY are used in the sense of
RFC 2119 and RFC 8174.

## Protocol profile

- Protocol identifier: `oradio/1` (provisional).
- API prefix: `/v1`.
- Media type: `application/vnd.openradio.registry+json;version=1`
  (provisional and unregistered).
- JSON profile: bounded I-JSON, canonicalized with RFC 8785 JCS.
- Signature: Ed25519 only; the algorithm label is `Ed25519`.
- Digest: SHA-256 only.
- Binary fields: unpadded base64url.
- Time: RFC 3339 UTC instants with `Z`.
- Transport: HTTPS for registry APIs. Stream policy is described separately.

Implementations MUST reject duplicate JSON member names, invalid UTF-8,
non-finite numbers, integers outside `[0, 2^53-1]`, invalid base64url, unknown
algorithms, oversized values, and excessive nesting before cryptographic
verification. Implementations MUST publish concrete resource limits.

## Identifiers

A station root key is an Ed25519 public key represented as raw 32 bytes.

```text
station_id = "oradio:station:ed25519:" +
             base64url(SHA-256(raw_root_public_key))

node_id    = "oradio:node:ed25519:" +
             base64url(SHA-256(raw_node_public_key))
```

These URI forms are provisional. An implementation MUST recompute the digest
and compare it to the claimed identity. Two identities are distinct even when
their names, domains, or stream URLs match; nodes MUST NOT auto-merge them.

A record ID is computed from the payload only:

```text
canonical_payload = JCS(payload)
record_id = "sha256:" + base64url(SHA-256(canonical_payload))
signature = Ed25519-Sign(private_key, canonical_payload)
```

The `proof` object is excluded from the signed bytes. Nodes MUST recompute the
record ID and MUST NOT trust one supplied by a peer.

## Signed envelope

```json
{
  "payload": {
    "protocol": "oradio/1",
    "kind": "station",
    "station_id": "oradio:station:ed25519:<digest>",
    "sequence": 7,
    "parents": ["sha256:<record-id>"],
    "issued_at": "2026-09-26T12:00:00Z",
    "root_key": {
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "<base64url-raw-public-key>"
    },
    "station": {
      "name": "Example FM",
      "short_name": "EXFM",
      "homepage": "https://example.invalid/",
      "languages": ["en"],
      "country": "US",
      "tags": ["jazz"],
      "streams": [
        {
          "url": "https://stream.example.invalid/live",
          "transport": "https",
          "container": "audio/mpeg",
          "codec": "mp3",
          "bitrate_kbps": 128
        }
      ]
    }
  },
  "proof": {
    "alg": "Ed25519",
    "key_id": "root",
    "signature": "<base64url-signature>"
  }
}
```

The normative JSON Schemas and byte-level fixtures must be versioned alongside
an implementation before interoperability is claimed. JSON Schema validation
is necessary but not sufficient; identity, DAG, URL, size, and signature rules
are semantic checks.

### Station payload

Required fields are `protocol`, `kind`, `station_id`, `sequence`, `parents`,
`issued_at`, `root_key`, and `station`.

- `kind` MUST be `station`.
- Genesis uses sequence `0` and an empty `parents` array.
- An ordinary update names one parent and has sequence `parent.sequence + 1`.
- A merge names two or more tips and has sequence
  `1 + max(parent.sequence)`.
- Every parent MUST be a valid record for the same station identity.
- Each update is a complete snapshot, not a patch.
- A tombstone uses `station: {"deleted": true}` and follows the same DAG rules.
- `name` and at least one stream are required unless the record is a tombstone.
- `languages` use BCP 47 tags. `country`, when present, uses ISO 3166-1 alpha-2.
- Tags are free text in v1. Schedules and programs are outside the MVP.
- Stream URLs MUST be absolute `http` or `https` URLs without userinfo or
  fragments. Clients and nodes SHOULD prefer HTTPS and MUST visibly label
  retained HTTP streams as insecure.

Station records do not expire. Their sequence and DAG define ordering, and this
allows offline use. `issued_at` is informational and audit-relevant, not a
winner tie-break. Node cards and health observations do expire.

Unknown non-critical members MUST be ignored for interpretation and preserved
byte-for-byte or semantically equivalently when relayed. A payload MAY contain
`critical`, an array of member names whose semantics are required. If any named
semantics are unsupported, the record MAY be stored and relayed but MUST NOT be
materialized.

### Validation order

1. Enforce transport and decoded-body budgets.
2. Parse bounded I-JSON and validate the versioned schema.
3. Canonicalize the payload and recompute `record_id`.
4. Verify the root key shape and self-certifying station identity.
5. Verify the Ed25519 signature using the station root key.
6. Verify all parents, sequence rules, and station identity continuity.
7. Quarantine an otherwise valid orphan until all parents arrive.
8. Apply local admission and moderation policy.
9. Materialize and index only an admitted record.

Local policy MUST NOT convert an invalid record into a valid one.

## Conflict resolution

For each station, retain the valid record DAG. A tip is a valid record with no
known valid child. Select the materialized winner by:

1. greatest sequence; then
2. lexicographically smallest record ID.

Set `forked=true` whenever more than one tip exists, even if one wins. A later
valid record can merge all known tips. Nodes MUST NOT use receipt time or
`issued_at` to select a winner. Given the same valid record set and protocol
version, nodes therefore select the same state.

A duplicate record ID is idempotent. A lower-sequence record may extend known
history but does not replace a higher winning tip. A same-sequence record with
a different ID creates or extends a fork; it is not silently overwritten.

## Node card and discovery

A registry origin serves:

```json
{
  "protocol": "oradio/1",
  "api_versions": [1],
  "node": "https://registry.example/v1/node",
  "api_base": "https://registry.example/v1/",
  "records": "https://registry.example/v1/records",
  "snapshot": "https://registry.example/v1/snapshot",
  "peers": "https://registry.example/v1/peers"
}
```

at `GET /.well-known/open-radio-registry`. The document is
HTTPS-authenticated, bounded, and cacheable.

`GET /v1/node` returns a signed node card containing the node ID, root public
key, operator URL, API bases, supported major versions, capabilities,
`issued_at`, and `expires_at`. A node-card signature authenticates continuity
of that node ID, not its honesty.

Distributions SHOULD ship at least two independently operated seed origins.
Users and distributors MUST be able to replace or remove them. The MVP crawls
only explicitly allowed seeds and a bounded set of peer cards. It does not
transitively trust peers or their records.

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/.well-known/open-radio-registry` | Discover versioned API URLs |
| GET | `/v1/node` | Fetch signed node card and capabilities |
| GET | `/v1/peers?cursor=&limit=` | Fetch bounded node cards |
| GET | `/v1/records?cursor=&limit=&kinds=` | Pull append-only record feed |
| GET | `/v1/snapshot?cursor=&limit=&kinds=` | Recover a complete retained set |
| GET | `/v1/stations/{station-key-digest}` | Read local materialized station |
| GET | `/v1/search?...` | Search this node's local projection |
| GET | `/v1/health/{station-key-digest}` | Read observations and local aggregate |
| POST | `/v1/records` | Optional rate-limited submission convenience |

### Resource schema summary

All objects are closed for required v1 semantics but permit unknown
non-critical extension members under the preservation rules above.

| Resource | Required members |
| --- | --- |
| Well-known descriptor | `protocol`, `api_versions[]`, `node`, `api_base`, `records`, `snapshot`, `peers` |
| Node card payload | `protocol`, `kind=node`, `node_id`, `root_key`, `operator_url`, `api_bases[]`, `supported_majors[]`, `capabilities[]`, `issued_at`, `expires_at` |
| Signed envelope | `payload`, `proof.alg`, `proof.key_id`, `proof.signature` |
| Feed/snapshot page | `items[]`, `next_cursor`, `has_more`, `checkpoint` |
| Feed item | `record_id`, `envelope` |
| Materialized station | `station_id`, `winning_record_id`, `tips[]`, `forked`, `station`, `provenance`, `indexed_at`, `last_replication_at`, `policy_state`, `health` |
| Search page | `items[]`, `next_cursor`, `has_more`, `query_snapshot` |
| Search item | materialized station summary plus provenance and freshness fields |
| Observation payload | `protocol`, `kind=observation`, `observer`, `station_id`, endpoint reference, `observed_at`, `expires_at`, `outcome` |
| Error | `error.code`, `error.message`, optional bounded `error.details`, `request_id` |

Endpoint URL members MUST be absolute HTTPS URLs. `next_cursor` is nullable on
the final page. `query_snapshot` is an opaque token that binds pagination to a
stable local search view. Error messages are safe for display but are not a
substitute for stable `error.code` handling.

All successful GET responses SHOULD include a strong ETag where practical,
`Cache-Control`, and support `If-None-Match` with `304 Not Modified`. APIs MUST
return a consistent JSON error envelope with a stable machine-readable code and
no raw upstream response data, secrets, or internal stack traces.

Default page size is 100 and the hard maximum is 1000. The maximum decoded
record size is 64 KiB. Deployments MUST also cap response bytes, nesting,
fields, strings, signatures, keys, DNS answers, and concurrent work.

`429 Too Many Requests` SHOULD include `Retry-After`. Nodes MAY drop abusive
connections. Cursors are opaque, origin-specific, feed/filter-bound, and may
expire. Clients MUST NOT parse them or compare cursors from different feeds.

### Record feed

```json
{
  "items": [
    {
      "record_id": "sha256:<digest>",
      "envelope": {"payload": {}, "proof": {}}
    }
  ],
  "next_cursor": "<opaque>",
  "has_more": false,
  "checkpoint": "<opaque>"
}
```

A consumer verifies every item independently. It stores the entire page and
commits its peer cursor atomically. After a crash, replay is safe because record
IDs are idempotent. Invalid siblings are quarantined without making valid
siblings disappear; the implementation's atomic-page rule must guarantee that
a committed cursor never skips an unprocessed item.

An expired feed cursor returns `410 Gone` with a snapshot URL. The consumer
imports bounded snapshot pages, keeps any newer valid local records omitted by
the peer, materializes the union, then resumes from the snapshot checkpoint.

### Materialized station

A station response includes the winning station snapshot plus:

- `station_id` and `winning_record_id`;
- all current tip IDs and `forked`;
- source peer provenance or source count;
- index and last-replication timestamps;
- local policy state;
- health state with observer scope and expiry.

A node MUST distinguish absence, local suppression, verified tombstone, and
unsupported critical semantics.

### Search

`GET /v1/search` supports `q`, `tag`, `country`, `language`, `codec`, `healthy`,
`cursor`, and `limit`. Values are ANDed across filter classes and ORed within a
class. Search is local; a request MUST NOT fan out to peers.

Each result includes the station summary, station ID, winning record ID, fork
state, provenance, indexed time, station update time, and health freshness.
Ranking is implementation-defined and documented. Interoperability fixtures
use text score descending, normalized station name ascending, then station ID
ascending. Opaque pagination MUST preserve a stable ordering for the query.

## Health observation

A health observation is an immutable envelope signed by the observing node. Its
payload contains:

- `protocol: "oradio/1"` and `kind: "observation"`;
- observer node ID and public key;
- station ID and stream URL digest or endpoint index;
- `observed_at` and `expires_at`;
- outcome: `ok`, `timeout`, `dns_error`, `tls_error`, `http_error`,
  `invalid_audio`, or `blocked`;
- bounded latency, HTTP status, final URL, content type, codec/bitrate, and
  diagnostic code where available.

The expiry MUST be later than observation time and no more than one hour later.
A suggested UI freshness interval is 15 minutes. Observations for unknown
stations, unlisted endpoints, invalid node identities, excessive lifetimes, or
unacceptable future clock skew are quarantined.

By default, the public badge reflects the local node's latest probe. Remote
observations are separate and affect ranking only when the operator explicitly
trusts their observers. Expired observations become `unknown`, never `down`.

## Replication algorithm

For each admitted peer:

1. Load that peer and filter's last committed cursor.
2. Fetch a bounded records page using conditional HTTP requests where useful.
3. Independently verify, deduplicate, store, and provenance-tag every item.
4. Commit the page and next cursor atomically.
5. Stop when `has_more=false` or the local work budget is exhausted.
6. Back off with jitter on failure or `429`.
7. Periodically compare a snapshot to recover from missed feed history.

Accepted records enter the local append log without changing their payload or
proof. Content-hash deduplication causes relay loops to reach quiescence.
Station records and tombstones are retained indefinitely in the MVP unless
local law requires otherwise. Short-lived observations may be pruned.

## Offline client behavior

Clients keep materialized station rows, provenance, ETags, and the last
successful refresh time. Browsing and search continue from local state with an
explicit offline/stale state and `data_age`. A verified tombstone already in
the cache remains effective. An expired health observation becomes unknown.
Playback MAY attempt a cached stream URL, but local playback failure does not
create a federated observation.

A failed refresh MUST NOT delete last-known-good rows. The client replaces a
source only after a complete, semantically valid response commits.

## Versioning and key policy

The API path and payload carry the major version. Unknown optional members are
preserved and ignored; unsupported critical semantics prevent materialization.
A change to canonicalization, identity, signature verification, or conflict
resolution requires a new major version. Discovery may advertise several
majors, and nodes may dual-serve them.

The MVP station root key signs every station record. If the key is lost, a new
identity is required. If it remains available after compromise, the publisher
may issue a tombstone and migrate to a new identity. Nodes document local
emergency suppression independently. Delegated update keys, dual-signed
rotation, and threshold recovery are planned compatible record kinds, but an
implementation MUST NOT invent automatic recovery from DNS, email, node votes,
or a new unanchored key.

## Required conformance cases

Before claiming v1 interoperability, two independent implementations must pass
shared fixtures covering:

- self-certifying station and node IDs;
- RFC 8785 bytes, SHA-256 IDs, and Ed25519 signatures;
- duplicate keys, number bounds, Unicode, base64url, size, and mutation errors;
- orphan acceptance, fork convergence, and merge records;
- page replay after crash, loop deduplication, and snapshot recovery;
- stable search ordering, opaque cursor binding, ETag, and `304` behavior;
- observation identity, endpoint scope, expiry, and clock skew;
- unknown optional and critical members;
- tombstone persistence and non-resurrection;
- offline cache age and health transition to unknown.

Security and abuse cases are specified in [`threat-model.md`](threat-model.md).

## Standards references

- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and
  [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) define requirement terms.
- [RFC 8615](https://www.rfc-editor.org/rfc/rfc8615) defines well-known URIs.
- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) defines JSON
  canonicalization.
- [RFC 9864](https://www.rfc-editor.org/rfc/rfc9864) specifies the Ed25519
  algorithm identifier used by this profile.
- [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111) defines HTTP caching and
  conditional requests.
