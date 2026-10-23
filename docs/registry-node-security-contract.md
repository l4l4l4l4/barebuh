# Registry-node security and operations contract

Status: Accepted boundary for the private scaffold. This document records gates; it does not claim they have all been implemented.

## Release modes

1. `MVP_LOCAL_READ_ONLY` is the only default and the only mode implemented by the scaffold: loopback listener, bounded GET discovery, local immutable storage, migrations, backup/restore, and operational liveness/readiness. Mutation routes, peers, replication workers, station schedulers/checkers, DNS, and outbound HTTP are absent.
2. `PRIVATE_READ_ONLY` is additive and requires an explicit operator-controlled TLS/auth ingress and private bind policy. It does not enable writes, federation, or checking.
3. `PRIVATE_PINNED_FEDERATION` is additive only after ingest, quota, provenance, moderation, backup/restore, migration, observability, and degraded-mode evidence passes. Pull sources are explicit pins; peer-of-peer admission is forbidden.
4. `HEALTH_CHECKING` means station probing, not `/health/live` or `/health/ready`. It requires application SSRF tests and a production-equivalent firewall/sandbox test. Operational health endpoints never probe stations.
5. `PUBLIC_PILOT` is last, authenticated/invite-only, and requires every P0 gate, two independent protocol implementations, current security/abuse/legal/privacy evidence, and independent review. Anonymous writes are not a mode.

An environment variable, discovery document, Authorization header, or node card can never promote the running release mode.

## Protocol and HTTP limits

Limits come from `protocol/v1/limits.json`: document 65,536 bytes; depth 16; object members 64; array items 64; string 4,096 bytes; parents 8; streams 16; languages 16; tags 32; station name 200 bytes; URL 2,048 bytes; node API bases 8; capabilities 32; observation lifetime 3,600 seconds; future skew 300 seconds; public key/signature/digest 32/64/32 bytes. API page size defaults to 100 and is capped at 1,000.

Production quotas must be finite, documented, visible in effective non-secret configuration, and tested at N and N+1 with a fake clock. Test-profile buckets are: 60-second window; 2 writes/principal, 3/source prefix, 2/station, 1 checker job/destination origin; queue depth 2.

## Deterministic acceptance gates

- `ING-01` bounded parsing: every limit passes at N and fails at N+1 before crypto/store/index work; invalid UTF-8, duplicate keys, unsafe numbers, malformed base64url, unknown algorithms, and excessive depth leave record count, projection generation, and queues unchanged.
- `ING-02` atomic immutable ingest: duplicate IDs are idempotent; page cursor cannot skip valid siblings after a crash; orphan, fork, critical-extension, and tombstone states survive restart; signed bytes and prior provenance are never rewritten.
- `ING-03` bounded growth: page, input, response, memory, disk, queue, and log ceilings are deterministic; overload is bounded and does not starve reads.
- `AUTH-01` default-off writes: POST/PUT/PATCH/DELETE handlers are absent, effective config says writes are false, and credentials cannot enable a route.
- `AUTH-02` fail-closed write enablement: future writes require authenticator, invitation policy, quotas, audit sink, and moderation state before listening; 401/403/scope/moderator transitions are distinct.
- `QUOTA-01` layered quotas: principal, source prefix, station, and origin buckets pass exactly N and reject N+1 with correct retry time, including across restart.
- `QUOTA-02` bulkheads: ingest, replication, indexing, and checking have independent bounded pools; origin normalization, coalescing, and backoff prevent unbounded retry.
- `SSRF-00` checker absence: local/private read-only modes have zero checker/scheduler workers and zero DNS/TCP egress while loading or searching hostile station URLs.
- `SSRF-01` application policy: forbidden schemes, ports, address ranges, metadata, numeric variants, userinfo, fragments, malformed escapes, controls, and authority confusion make zero requests.
- `SSRF-02` rebinding/redirect policy: every connect revalidates DNS, forbids mixed/private changes, pins an allowed address with correct host/SNI, follows zero redirects, and ignores proxy injection.
- `SSRF-03` sandbox: a production-equivalent checker identity cannot reach loopback, LAN, metadata, control plane, database, keys, credentials, or Unix sockets at the OS/network layer.
- `SSRF-04` fetch budgets: DNS, connect, idle, total, header, body, decompression, and concurrency budgets stop slowloris, floods, bombs, recursive playlists, and TLS/MIME failures.
- `SECRET-01` canary scan: credential canaries never appear in responses, URLs, logs, telemetry, audit, process listings, effective config, database, or ordinary backups.
- `SECRET-02` authority separation: registry authorization is sent only to its configured registry authority; checker environments contain no registry/cloud/proxy/key authority.
- `KEY-01` custody: station roots remain publisher-held/offline; node signing, TLS, and backup keys are distinct and absent from the database, image, checker, and ordinary data backup.
- `KEY-02` compromise/loss: a node key cannot mutate station history; lost station root creates a new identity; containment, reissue, removal, tombstone, and local suppression stay distinct.
- `MOD-01` record states: invalid, orphan, unsupported-critical, quarantined, admitted, locally suppressed, origin-tombstoned, and forked remain distinct across restart/rebuild.
- `MOD-02` trust/audit states: transport, admission, observation weight, and blocking vary independently; authorized changes append actor/time/scope/old/new/reason/request ID and preserve reversal/appeal history.
- `BACKUP-01` completeness: online backup plus manifest covers authoritative records, provenance, cursors, policy/audit, and non-secret config; excludes caches, queues, and plaintext keys; tamper/incompleteness fails restore.
- `BACKUP-02` restore: newest and previous backups restore on an empty egress-denied host, verify signatures/DAG/tombstones/cursors/audit, and rebuild projections within declared RPO/RTO.
- `MIG-01` safety: every supported prior schema migrates idempotently; injected interruption/disk-full is atomic or documented-resumable; immutable bytes/digests/provenance remain identical.
- `MIG-02` compatibility: newer DB, old binary, unmigrated DB, and concurrent migration attempts refuse readiness/writes; no implicit downgrade occurs.
- `OBS-01` bounded telemetry: every rejection, queue, migration, backup, peer, checker, and degraded branch is observable without hostile IDs/URLs/IPs as labels or raw secrets/payloads in logs.
- `OBS-02` health/alerts: liveness has no external dependency; readiness reflects mandatory local dependencies only; synthetic alerts cover disk, queues, verifier anomalies, backups/restores, peer age, and checker saturation.
- `DEG-01` safe degradation: forced/low-disk/write/migration/queue faults stop mutation and cursor/index/checker progress while bounded GET serves the last committed projection with explicit stale/degraded age.
- `DEG-02` recovery: partial newest state is never exposed; leaving degraded mode requires operator acknowledgement plus invariant/readiness checks and revalidation of queued work.
- `PUBLIC-01` capability graph: unknown and insecure combinations are fatal; the effective mode/capabilities are non-secret and default local read-only.
- `PUBLIC-02` release manifest: public/federated launch evidence is tied to the exact artifact/config/policy and includes current contacts, terms/privacy/data review, two implementations, and independent review. Authentication, bounded ingest, SSRF isolation, key custody, backup/restore, and degraded-mode gates cannot be waived.

## Required retained evidence

Retain effective config and route/worker inventory, conformance/boundary reports, independent implementation report, fault-injection results, firewall/packet evidence, secret-canary scan, key inventory and drills, backup manifests and dated fresh-host restore timings, migration matrix, synthetic alert results, moderation/appeal drill, public legal/privacy/contact checklist, and independent review.

Before any public operation, operators must also declare resource/quota ceilings, backup frequency/retention/RPO/RTO, node signer and offline custodian, operator entity/jurisdiction/retention/escalation, writer/invitation roles, security/abuse/on-call owners, and whether a non-loopback private listener is needed.
