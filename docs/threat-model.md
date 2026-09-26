# Barebuh Threat Model

Status: MVP security baseline

This threat model covers the Barebuh federated internet-radio registry and its
Strawberry-derived desktop client. Barebuh is a GPL-3.0-or-later fork of
Strawberry Music Player. Existing copyright and license notices must be
retained; see [`COPYING`](../COPYING).

This document is an engineering threat model, not legal advice.

## Security goals

- preserve the integrity and provenance of station history;
- prevent untrusted federation data from becoming implicit trust;
- prevent registry health checks from reaching private infrastructure;
- keep hostile metadata inert in every display, log, query, and export context;
- retain useful last-known-good data under attack or outage;
- minimize listener, operator, moderator, and reporter data;
- make local moderation reversible, attributable, scoped, and auditable.

A valid signature authenticates a key and payload. It does not certify station
ownership, metadata truth, stream safety, availability, legality, or quality.

## Assets

- station and node private signing keys;
- immutable station history, tombstones, and provenance;
- registry database, search projection, cursors, and backups;
- moderation decisions and protected report evidence;
- node availability, worker capacity, disk, and network egress;
- desktop credentials and cached station data;
- operator, reporter, and listener privacy.

## Trust boundaries

| Boundary | Assumption and required control |
| --- | --- |
| Client to node | TLS protects transport; search completeness and ranking remain node assertions |
| Node to station record | Ed25519 authenticates record integrity only; schema, DAG, URL, and policy checks remain mandatory |
| Node to peer | Node identity is cheap; peer access, record admission, and observation trust are separate local states |
| API to ingest workers | Every field is hostile; use bounded queues, parsing, and storage |
| Scheduler to checker | Checker is disposable, unprivileged, egress-only, and isolated from control-plane assets |
| Checker to stream | URL, DNS, TLS, headers, redirects, body, playlist, and codecs are hostile |
| Moderator UI to public API | Strong authentication, least privilege, CSRF protection, audit events, and inert rendering |
| Offline cache to current network | Signatures prove historical integrity, not freshness or non-revocation; expose age |

## Threats and MVP controls

### Sybil identities and spam

An attacker can create many station and node keys. Signatures, votes, node
counts, and quorum are therefore not reputation.

MVP controls:

- federation and submissions are closed or invitation-based;
- peers are pinned explicitly; peers-of-peers are not auto-trusted;
- imported records are quarantined until local policy accepts them;
- keep separate states for transport access, record admission, observation
  weighting, and blocking;
- enforce quotas by node key, source network/prefix, station identity, and
  destination origin;
- cap new stations, updates, records/page, bytes/batch, concurrent syncs,
  queued checks, and checks/origin;
- deduplicate by record ID before expensive work;
- low-trust sources cannot trigger immediate probes, artwork work, or ranking;
- expose provenance and stable reason codes to operators.

### Malicious URLs and SSRF

The health checker is the highest-risk boundary. It must not become a port
scanner, metadata client, reflected-load tool, or path to the control plane.

MVP URL policy:

- parse once with one well-tested URL implementation and use its structured
  output throughout;
- accept absolute `http` or `https` only;
- reject userinfo, fragments, empty hosts, controls, embedded NUL, backslash
  authorities, malformed escapes, ambiguous numeric addresses, and parser
  disagreement;
- the automated checker probes DNS hostnames on ports 80 and 443 only;
  retained IP literals or other ports remain unverified;
- resolve all A and AAAA answers before each connection; reject the destination
  if any selected address is not globally routable;
- deny loopback, unspecified, private, link-local, CGNAT, multicast,
  documentation, benchmark, reserved, IPv4-mapped IPv6, unique-local, and
  metadata-service destinations;
- pin the connection to a vetted address while preserving hostname and SNI;
- follow no redirects and resolve no M3U, PLS, or ASX playlists in the MVP;
- use a small ranged GET when HEAD is insufficient, with fixed connect, total,
  idle, header, body, decompression, DNS-answer, and concurrency limits;
- send no cookies, authorization, client certificates, ambient proxy settings,
  or raw response data to users;
- coalesce by origin, use low cadence and jitter, and identify the checker with
  an abuse contact.

The checker runs in a disposable service, container, or network namespace with
no route to LANs, loopback services, cloud/container metadata, the registry
control plane, databases, key agents, or Unix sockets. Its filesystem is
read-only and it has no ambient credentials. Egress firewall policy is a
mandatory second layer, not a substitute for URL validation.

Desktop playback uses the chosen stream URL directly through Strawberry's
existing engine. It never attaches registry credentials, silently suppresses
TLS failures, or treats a successful health check as proof of safety.

### Metadata poisoning

MVP controls:

- closed, versioned schemas plus semantic checks;
- bounded I-JSON parsing and RFC 8785 canonicalization;
- limits for decoded bytes, nesting, fields, strings, list lengths, tags,
  signatures, and keys;
- no normalization before signature verification;
- names, descriptions, tags, diagnostics, and provenance rendered as plain text
  with context-specific escaping;
- C0/C1 controls are rejected except explicitly permitted whitespace; bidi
  controls and confusables are flagged for review;
- station text is never interpreted as HTML, Markdown, SQL, log format, shell
  syntax, a filename, or search syntax;
- structured newline-safe logs and parameterized database/search operations;
- exports escape their target format and prevent spreadsheet formula execution;
- no remote artwork fetch or arbitrary-byte proxying in the MVP.

### Replay, forks, and signing keys

MVP controls:

- immutable envelopes sign all behaviorally relevant station fields;
- station IDs are self-certifying and record IDs are recomputed;
- sequence and parent rules are persisted across restarts;
- duplicate digests are idempotent, orphans are quarantined, and same-sequence
  divergent records remain visible forks;
- algorithm and protocol identifiers are explicit allowlists with no downgrade
  fallback;
- node cards and observations enforce expiry and bounded clock skew;
- station records do not expire and are ordered by their DAG, not timestamps;
- root private keys are kept offline where operationally possible.

The MVP has root-only station signing. Loss of a key means creation of a new
identity. A still-available compromised key may sign a tombstone before
migration; operators also retain local emergency suppression. DNS, email, node
votes, or a new unanchored key never recover an identity automatically.
Delegated online keys, dual-signed rotation, retained retired public keys, and
threshold recovery are post-MVP protocol work and require conformance fixtures.

### Peer trust, observations, and blocklists

A reachable or signed node is not automatically trusted. A remote health
failure cannot delete a station. By default, ranking uses the local node's
latest observation; remote observations are displayed separately unless their
observer is explicitly weighted.

Moderation advisories, when added, are signed, attributable, versioned,
expiring, opt-in, non-transitive, and exactly scoped to a station, key, node,
hostname, or URL digest. Local allow and deny policy wins. Broad suffix or IP
blocks require operator review because of collateral damage.

### Availability and resource exhaustion

Every attacker-controlled dimension has a hard ceiling. API, federation,
verification/indexing, and checker workers use separate bulkheads and bounded
queues. Overload triggers backpressure or load shedding, not unbounded memory or
disk growth. Retries use exponential backoff with jitter and circuit breakers.
An origin outage reduces probe frequency.

Snapshots and feed pages are validated before atomic commit. A corrupt update
never replaces the prior projection. Nodes and clients serve labeled
last-known-good data. Operators define disk/queue/error alerts, backups, restore
tests, read-only mode, and recovery objectives.

### Privacy and telemetry

The MVP collects no listener identity, listening history, votes, click beacons,
stable installation IDs, cross-node analytics, or client-side health reports.
Clients use a generic product/version user agent. Secrets and user data never
appear in query strings.

Search logging is disabled by default or sampled and aggregated with a short,
documented retention period. Security logs may temporarily retain source IPs
only for a defined purpose, access policy, maximum retention, and verified
deletion. Raw IPs, request logs, reporter identities, and listener telemetry are
never federated. Hashing an IP is pseudonymization, not anonymization.

Operator privacy notices explain that a registry node can see client IP and
search terms, the stream host sees listener traffic, and resolvers see DNS
lookups. Federation is not anonymity. Tor or proxy guidance is published only
if that path is actually tested.

## Moderation and legal boundary

Origin tombstone, local suppression, and third-party advisory are separate:

- a station key controls protocol-level station history;
- a receiving node controls local visibility and ranking;
- an advisory communicates another operator's attributed opinion;
- a legal order is interpreted under the receiving operator's jurisdiction.

A global erasure guarantee is impossible after records replicate. Nodes retain
only the data and evidence needed for protocol integrity and legal obligations,
subject to documented retention and deletion policy.

Before public writes or federation, the operator must establish applicable
notice-and-action, copyright, privacy, child-safety, sanctions, law-enforcement,
and record-retention duties with qualified counsel. The workflow records the
precise record/URL, jurisdiction/category, explanation, protected evidence,
timestamps, decision, reason code, reviewer, appeal, and reinstatement. Emergency
suppression is time-limited and reviewed. Reporter identity is protected.

Publish operator terms, a privacy notice, an abuse/moderation contact, and a
current `/.well-known/security.txt`. A listing is not an endorsement, safety
certification, copyright license, or broadcast authorization.

## Explicit non-goals

- preventing all Sybil identities in an open network;
- certifying stream legality, safety, content, quality, or availability;
- global consensus, deletion, moderation, or portable reputation;
- listener anonymity or traffic-analysis resistance;
- arbitrary schemes, LAN stations, arbitrary ports, recursive playlists,
  artwork proxying, votes, recommendations, or real-time push;
- automated legal adjudication or proactive audio-content monitoring.

## Abuse acceptance tests

### URL and network isolation

- Submit loopback, `0/8`, RFC 1918, CGNAT, link-local, metadata, IPv6 loopback,
  ULA, multicast, IPv4-mapped IPv6, numeric-address variants, userinfo,
  backslashes, CRLF, NUL, and forbidden schemes. No network request occurs.
- Resolve a hostname first to a public address and then a private address; mix a
  private answer into a multi-answer response; change a CNAME; redirect to a
  private host or forbidden port. The checker never connects.
- Independently verify with egress-firewall tests that LAN, metadata, control
  plane, database, and key-service destinations are unreachable.
- Exercise redirect loops, slow responses, infinite chunks, compressed bombs,
  huge headers, wrong MIME, TLS failure, endless audio, and nested playlists.
  Workers terminate within budgets and the queue remains healthy.
- Repeat one URL at high rate. Requests coalesce, origin quotas hold, and the
  submitter receives neither raw bodies nor a useful timing oracle.

### Records and metadata

- Reject or safely retain duplicate keys, deep objects, giant lists, invalid
  UTF-8, NaN/Infinity, unsafe integers, unknown critical versions, controls,
  bidi text, HTML/script, SQL/search syntax, log newlines, and spreadsheet
  formulas.
- Cross-implementation canonicalization fixtures produce identical bytes,
  digest, and signature results. Byte, number, Unicode, and property-order
  mutations fail verification.
- Replay duplicates, lower sequence, future node card, expired observation, and
  same-sequence divergent records. Duplicates are idempotent; invalid temporal
  objects are quarantined; divergence remains a visible fork.
- An unsupported critical member is relayed without materialization. A verified
  tombstone survives restart and an older record cannot resurrect it.

### Trust, moderation, and privacy

- Create 1,000 mutually endorsing node keys. They gain no automatic trust or
  ranking and cannot cause deletion, immediate probes, or peer admission.
- Supply invalid, stale, wildcard, and transitively referenced advisories. They
  are not enforced; an exact current advisory remains locally reversible.
- Exercise precise, vague, malicious, emergency, appealed, and conflicting-
  jurisdiction reports. Scope, reasons, evidence protection, audit history, and
  reinstatement remain correct.
- Capture client, peer, and checker traffic and inspect logs. There is no stable
  client ID, listening history, federated raw IP, query secret, credential
  forwarding, or unexpected third-party call. Retention expiry deletes data.

### Resilience

- Kill seeds, poison one peer's DNS, corrupt the newest page, fill one worker
  pool, exhaust one origin, expire a cursor, and restore backup. Last-known-good
  data remains available and labeled; invalid state never commits; other
  bulkheads remain responsive; snapshot recovery converges.

## P0 launch gates

Public or federated operation is blocked until all are true:

- every attacker-selected server-side fetch is protected by both isolated egress
  and application-layer URL, DNS, IP, port, and redirect policy;
- signature, canonicalization, identity, DAG, versioning, replay, and mutation
  conformance tests pass in two independent implementations;
- writes have authentication or invitation, quotas, bounded parsing/storage,
  provenance, quarantine, and moderation controls;
- root-key storage, compromise response, tombstone/migration, lost-key policy,
  and planned rotation path are documented and exercised;
- peer trust is explicit and non-transitive, and Sybil observations cannot
  delete or promote stations automatically;
- abuse/security contacts, takedown, appeal, audit, emergency, terms, privacy,
  retention, and jurisdiction-specific legal review exist;
- no default listener telemetry or stable client identifier exists;
- last-known-good behavior, ceilings, bulkheads, monitoring, backup, restore,
  and degraded mode have passing tests;
- clients render metadata inertly, isolate API credentials from streams, and do
  not suppress TLS errors.

## Security references

- [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
  covers destination validation, redirect handling, DNS rebinding, and network
  controls.
- [RFC 3986](https://www.rfc-editor.org/rfc/rfc3986) defines URI syntax and
  documents deceptive authority and userinfo risks.
- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) defines the canonical JSON
  representation used for signatures.
- [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585) defines `429 Too Many
  Requests` and `Retry-After` behavior.
- [RFC 9116](https://www.rfc-editor.org/rfc/rfc9116) defines `security.txt`.
- The [NIST Privacy Framework](https://www.nist.gov/privacy-framework) informs
  data minimization, retention, and manageability controls.
- The [EU Digital Services Act](https://eur-lex.europa.eu/legal-content/en/TXT/?uri=CELEX:32022R2065)
  is one source an EU-facing operator must assess with qualified counsel.
