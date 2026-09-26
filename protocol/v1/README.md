# oradio/1 protocol assets

Status: implementation draft; two independent fixture verifiers, no public-federation readiness claim

This directory is the versioned source of truth for the signed station-record,
node-card, and health-observation wire shapes described in
[`docs/protocol-mvp.md`](../../docs/protocol-mvp.md). The `oradio/1` identifier,
identity prefixes, media type, and `barebuh.example` schema IDs remain
provisional. These files deliberately do not resolve the protocol-owner naming
or governance decisions listed in the implementation plan.

## Signed bytes and identities

All JSON input uses UTF-8 and the bounded I-JSON profile in `limits.json`.
Duplicate member names, lone Unicode surrogates, C0/C1 controls, non-finite
values, negative integers, and integers above `2^53 - 1` are rejected before
signature work.

The signed bytes are RFC 8785 JCS applied to `envelope.payload` only. The
`proof` object is never signed. Object names sort by UTF-16 code units, strings
are emitted with the JSON escaping required by ECMAScript, and numbers use the
ECMAScript shortest round-trip representation. No Unicode normalization occurs.

Raw 32-byte Ed25519 public keys and SHA-256 digests use unpadded base64url.
Station and node IDs are the protocol prefix plus the SHA-256 digest of the raw
public key. Content IDs are `sha256:` plus the SHA-256 digest of canonical
payload bytes. Ed25519 signs those canonical payload bytes directly.

A health `stream_url_digest` is `sha256:` plus the SHA-256 digest of the exact
UTF-8 stream URL string in the signed station payload. It is not a digest of a
normalized or redirected URL. `endpoint_index` is the zero-based index in that
same signed station snapshot. Receivers must additionally prove that an
observation references a listed endpoint; the offline runner cannot do that
without the referenced station record.

## Schema and semantic boundary

JSON Schema Draft 2020-12 files are in `schemas/`. Objects allow unknown members
so relays can preserve compatible extensions. The schema does not replace
semantic validation. Implementations must also check canonical bytes,
self-certifying IDs, signatures, URL structure, station DAG continuity,
observation endpoint scope, time policy, and local admission policy.

A `critical` entry names a payload member. An unsupported critical member does
not make an otherwise authentic envelope cryptographically invalid, but the
record must not be materialized. The fixture runner reports this as
`materializable: false`.

Node cards and observations are temporally accepted only when the caller checks
them against its current clock. The profile permits at most 300 seconds of
future clock skew, and observations live at most 3600 seconds. Golden fixture
verification intentionally uses signed intrinsic lifetime checks and does not
make historical vectors expire with wall-clock time.

## Offline verification

Node.js 20 or newer is sufficient; no network access or package installation is
used.

```sh
make -C protocol/v1 check
node protocol/v1/conformance-runner.mjs
node protocol/v1/conformance-runner.mjs /path/to/manifest.json
nix-shell --pure -p 'python3.withPackages (ps: [ ps.jsonschema ps.cryptography ])' --run 'make -C protocol/v1 independent'
```

The runner strictly parses every fixture, verifies Ed25519 signatures and
self-certifying identities, compares canonical payload bytes and content IDs,
and confirms that invalid vectors fail at the declared stage. The private seed
used to create the public RFC 8032-derived test key is not included. Fixtures
contain public keys and signatures only.

`python-conformance.py` is an independent implementation using Python,
`cryptography`, and the Draft 2020-12 validator from `jsonschema`. Both runners
independently execute `fixtures/interoperability-cases.json`: orphan promotion,
fork/merge/tombstone convergence, atomic page replay, loop deduplication,
snapshot recovery, stable search order, cursor/filter binding, endpoint scope,
unknown and critical members, URL-bound ETag/304 transitions, and complete
offline cache age/health behavior. The fixture supplies inputs and expected end
states; neither runner treats supplied booleans as computed outcomes. Passing
both implementations supplies local interoperability evidence, but does not by
itself satisfy operational, governance, naming, or public-federation launch
gates.
