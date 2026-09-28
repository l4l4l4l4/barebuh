// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Read model for the private registry node: bounded, deterministic, read-only queries over the
// immutable records plus the rebuildable projection, and the opaque pagination cursor.
//
// Boundary (docs/adr/0002-private-registry-node.md): this module owns SQL, the search ordering,
// the cursor codec, and response *content*. It never writes, never performs network I/O, and never
// re-derives protocol semantics - parsing, canonicalization, and identity rules stay in
// protocol/v1/lib/conformance.mjs, and DAG semantics stay in ./dag.mjs. The HTTP layer
// (../http.mjs) owns request targets, query extraction, cache validators, and error envelopes.
//
// The response vocabulary is pinned to the desktop client's response parser
// (src/radios/barebuhsearchparser.cpp, tests/src/barebuhservice_test.cpp): a search item carries
// `station_id`, a valid `winning_record_id`, a non-empty `tips` array, `forked`, the signed
// `station` snapshot, `provenance` (array or object), `policy_state` in
// {admitted, suppressed, tombstoned, unsupported_critical}, second-precision `indexed_at` and
// `last_replication_at` instants, and a `health` object whose `state` is one of
// {unknown, ok, degraded, unreachable, blocked} with `expires_at` present. The client pins
// `limit=64` and rejects a page with `has_more=true`, so this node's whole listing must fit in one
// page for that client.

import { createHash } from "node:crypto";

import { canonicalize, parseJsonStrict } from "../../../protocol/v1/lib/conformance.mjs";
import { CURSOR_LIMITS, cursorExpiry, cursorFilterMatches, cursorInvalid, decodeCursorToken, encodeCursorToken, ReadRequestError, secondInstant } from "./cursor.mjs";
import { normalizeText } from "./materialize.mjs";

// The request-time error class and the opaque-token codec are defined once in ./cursor.mjs and
// re-exported here because the HTTP layer and the station/search tests import them from the read
// model. `secondInstant` is likewise shared with the records feed.
export { ReadRequestError, secondInstant };

export const READ_LIMITS = Object.freeze({
  defaultSearchLimit: 100,
  maximumSearchLimit: 1000,
  maxSearchFilterValues: 16,
  maxSearchFilterValueBytes: 64,
  maxSearchQueryBytes: 256,
  maxSearchQueryTerms: 8,
  maxSearchQueryTermBytes: 64,
  maxHealthObservations: 64,
  maxProvenanceSources: 32,
  maxProvenanceBytes: 4096,
  maxCursorBytes: CURSOR_LIMITS.maxCursorBytes,
  maxCursorOffset: CURSOR_LIMITS.maxCursorOffset,
  cursorLifetimeSeconds: CURSOR_LIMITS.cursorLifetimeSeconds,
});

export const HEALTH_STATES = Object.freeze(["unknown", "ok", "degraded", "unreachable", "blocked"]);

// Protocol observation outcomes mapped into the client's coarser health vocabulary. The mapping is
// total and conservative: an unexpired `ok` is the only way to report `ok`, and anything the node
// cannot classify becomes `unknown`, never a fabricated failure.
const HEALTH_STATE_BY_OUTCOME = Object.freeze({
  ok: "ok",
  timeout: "unreachable",
  dns_error: "unreachable",
  tls_error: "unreachable",
  http_error: "degraded",
  invalid_audio: "degraded",
  blocked: "blocked",
});

export function healthStateOfOutcome(outcome) {
  return HEALTH_STATE_BY_OUTCOME[outcome] ?? "unknown";
}

// Local policy state in the client vocabulary. A station without a materialized view
// (orphan_only, quarantined) has no state in that vocabulary and is reported as not materialized.
const POLICY_STATE_BY_MATERIALIZATION_STATE = Object.freeze({
  active: "admitted",
  tombstoned: "tombstoned",
  suppressed: "suppressed",
  unsupported_critical: "unsupported_critical",
});

export function policyStateOf(materializationState) {
  return POLICY_STATE_BY_MATERIALIZATION_STATE[materializationState] ?? null;
}

const STATION_DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const STATION_ID_PATTERN = /^oradio:station:ed25519:[A-Za-z0-9_-]{43}$/u;
const SNAPSHOT_PATTERN = /^s1\.[A-Za-z0-9_-]{43}$/u;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u;

function canonicalBase64UrlDigest(value) {
  return Buffer.from(value, "base64url").toString("base64url") === value;
}

// Accepts the station-key digest alone (`/v1/stations/<digest>`) or the full station identity.
// Everything else is a bounded parameter error; a percent-encoded segment never reaches here
// because request targets are validated before routing (../http.mjs).
export function stationIdFromKey(key) {
  const invalid = () => new ReadRequestError(400, "invalid_parameter", "The station key is not a station identity.", { parameter: "station_key_digest", reason: "malformed" });
  if (typeof key !== "string" || key.length === 0) throw invalid();
  if (STATION_ID_PATTERN.test(key)) {
    if (!canonicalBase64UrlDigest(key.slice("oradio:station:ed25519:".length))) throw invalid();
    return key;
  }
  if (STATION_DIGEST_PATTERN.test(key) && canonicalBase64UrlDigest(key)) return `oradio:station:ed25519:${key}`;
  throw invalid();
}

// ---------------------------------------------------------------------------------------------
// Search query parsing (bounded). Filter classes are ANDed; values inside a class are ORed.
// ---------------------------------------------------------------------------------------------

const SEARCH_PARAMETERS = Object.freeze(["q", "tag", "country", "language", "codec", "healthy", "cursor", "limit"]);
const SCALAR_PARAMETERS = Object.freeze(["q", "healthy", "cursor", "limit"]);
const VALUE_PARAMETERS = Object.freeze(["tag", "country", "language", "codec"]);

function invalidParameter(parameter, reason) {
  const name = typeof parameter === "string" && SAFE_NAME_PATTERN.test(parameter) ? parameter : "unknown";
  return new ReadRequestError(400, "invalid_parameter", "A query parameter is invalid.", { parameter: name, reason });
}

function boundedValues(values, parameter, normalize) {
  if (values === undefined) return undefined;
  if (values.length > READ_LIMITS.maxSearchFilterValues) throw invalidParameter(parameter, "too_many_values");
  const normalized = [];
  for (const value of values) {
    if (value.length === 0 || Buffer.byteLength(value, "utf8") > READ_LIMITS.maxSearchFilterValueBytes) throw invalidParameter(parameter, "value_out_of_bounds");
    if (!normalized.includes(normalize(value))) normalized.push(normalize(value));
  }
  return normalized.sort();
}

// Search terms are NFKD-folded, diacritic-stripped, lowercased, and reduced to letter/number runs.
// The same folding is what the ICU-free FTS5 tokenizer approximates, and it makes the FTS5 MATCH
// string safe by construction: a term can never contain quote or operator characters.
function searchTerms(text) {
  return text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length > 0);
}

function boundedQuery(value) {
  if (value === undefined) return undefined;
  if (Buffer.byteLength(value, "utf8") > READ_LIMITS.maxSearchQueryBytes) throw invalidParameter("q", "query_out_of_bounds");
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return undefined;
  const terms = searchTerms(collapsed);
  // A query with no searchable terms is treated as absent instead of matching everything by
  // accident through an empty MATCH expression.
  if (terms.length === 0) return undefined;
  if (terms.length > READ_LIMITS.maxSearchQueryTerms) throw invalidParameter("q", "too_many_terms");
  if (terms.some(term => Buffer.byteLength(term, "utf8") > READ_LIMITS.maxSearchQueryTermBytes)) throw invalidParameter("q", "term_out_of_bounds");
  return collapsed;
}

export function parseSearchQuery(searchParams) {
  const seen = new Map();
  for (const [name, value] of searchParams) {
    if (!SEARCH_PARAMETERS.includes(name)) throw invalidParameter(name, "unknown_parameter");
    seen.set(name, [...(seen.get(name) ?? []), value]);
  }
  for (const name of [...SCALAR_PARAMETERS, ...VALUE_PARAMETERS]) {
    if (seen.get(name)?.length > (SCALAR_PARAMETERS.includes(name) ? 1 : READ_LIMITS.maxSearchFilterValues)) {
      throw invalidParameter(name, SCALAR_PARAMETERS.includes(name) ? "duplicate_parameter" : "too_many_values");
    }
  }

  const filter = {};
  const q = boundedQuery(seen.get("q")?.[0]);
  if (q !== undefined) filter.q = q;
  const tag = boundedValues(seen.get("tag"), "tag", normalizeText);
  if (tag !== undefined) filter.tag = tag;
  const language = boundedValues(seen.get("language"), "language", normalizeText);
  if (language !== undefined) filter.language = language;
  const codec = boundedValues(seen.get("codec"), "codec", value => normalizeText(value));
  if (codec !== undefined) filter.codec = codec;
  if (seen.has("country")) {
    // Country codes are ASCII alpha-2 exactly as given; the stored comparison value is upper-cased.
    const values = seen.get("country");
    for (const value of values) if (!/^[A-Za-z]{2}$/u.test(value)) throw invalidParameter("country", "invalid_value");
    filter.country = boundedValues(values, "country", value => value.toUpperCase());
  }
  const healthy = seen.get("healthy")?.[0];
  if (healthy !== undefined) {
    if (healthy !== "true" && healthy !== "false") throw invalidParameter("healthy", "invalid_value");
    filter.healthy = healthy === "true";
  }

  let limit = READ_LIMITS.defaultSearchLimit;
  const rawLimit = seen.get("limit")?.[0];
  if (rawLimit !== undefined) {
    if (!/^[0-9]{1,6}$/u.test(rawLimit)) throw invalidParameter("limit", "invalid_value");
    limit = Number(rawLimit);
    if (limit < 1 || limit > READ_LIMITS.maximumSearchLimit) throw invalidParameter("limit", "out_of_bounds");
  }

  const cursor = seen.get("cursor")?.[0] ?? null;
  return { filter, limit, cursor };
}

// ---------------------------------------------------------------------------------------------
// SQL fragments. The local health badge is the newest admitted observation signed by this node;
// the `healthy` filter uses the same expression so filter and badge can never disagree.
// ---------------------------------------------------------------------------------------------

function placeholders(count) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function localObservationExpr(expression) {
  return `(SELECT ${expression}
             FROM records r JOIN record_policy rp ON rp.record_id = r.record_id
            WHERE r.kind = 'observation' AND r.subject_id = p.station_id AND rp.state = 'admitted'
              AND json_extract(r.canonical_payload, '$.observer.node_id') = ?
            ORDER BY r.issued_at DESC, r.record_id ASC
            LIMIT 1)`;
}

// Candidates are the locally materialized stations only: the projection row exists exactly when a
// visible winner does, and the station_state join keeps a corrupted row without state out of the
// listing instead of serving half a station.
function searchKeyRows(db, filter, { nowInstant, observerId }) {
  const whereParams = [];
  const where = [];
  let from = "station_projection p JOIN station_state s ON s.station_id = p.station_id AND s.state = 'active'";
  let score = "0";
  if (filter.q !== undefined) {
    from = `station_fts JOIN station_projection p ON p.station_id = station_fts.station_id JOIN station_state s ON s.station_id = p.station_id AND s.state = 'active'`;
    where.push("station_fts MATCH ?");
    whereParams.push(searchTerms(filter.q).map(term => `"${term}"`).join(" AND "));
    score = "-bm25(station_fts)";
  }
  if (filter.country !== undefined) {
    where.push(`p.country IN (${placeholders(filter.country.length)})`);
    whereParams.push(...filter.country);
  }
  if (filter.tag !== undefined) {
    where.push(`EXISTS (SELECT 1 FROM station_tags t WHERE t.station_id = p.station_id AND t.normalized_tag IN (${placeholders(filter.tag.length)}))`);
    whereParams.push(...filter.tag);
  }
  if (filter.language !== undefined) {
    where.push(`EXISTS (SELECT 1 FROM station_languages l WHERE l.station_id = p.station_id AND l.normalized_language IN (${placeholders(filter.language.length)}))`);
    whereParams.push(...filter.language);
  }
  if (filter.codec !== undefined) {
    where.push(`EXISTS (SELECT 1 FROM station_streams st WHERE st.station_id = p.station_id AND lower(st.codec) IN (${placeholders(filter.codec.length)}))`);
    whereParams.push(...filter.codec);
  }
  if (filter.healthy !== undefined) {
    const healthy = `(COALESCE(${localObservationExpr("json_extract(r.canonical_payload, '$.outcome')")}, '') = 'ok' AND COALESCE(${localObservationExpr("json_extract(r.canonical_payload, '$.expires_at')")}, '') > ?)`;
    where.push(filter.healthy ? healthy : `NOT ${healthy}`);
    whereParams.push(observerId, observerId, nowInstant);
  }
  const sql = `SELECT p.station_id AS station_id, p.visible_record_id AS winning_record_id, p.normalized_name AS normalized_name, ${score} AS score
                 FROM ${from}${where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`}`;
  return db.prepare(sql).all(...whereParams);
}

// The interoperability ordering (docs/protocol-mvp.md): text score descending, normalized station
// name ascending, then station ID ascending. Names and IDs are compared as UTF-8 bytes so this
// ordering matches both the shared fixture runner (protocol/v1/tests/conformance.test.mjs uses
// Buffer.compare) and SQLite's BINARY collation.
function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareSearchKeys(left, right) {
  return right.score - left.score || compareUtf8(left.normalizedName, right.normalizedName) || compareUtf8(left.stationId, right.stationId);
}

// Opaque token that binds pagination to one stable local search view: a digest over the complete
// ordered key list of the query. A cursor minted against a different view fails closed.
function snapshotToken(keys) {
  const digest = createHash("sha256").update(canonicalize(keys.map(key => [key.stationId, key.winningRecordId, key.score])), "utf8").digest("base64url");
  return `s1.${digest}`;
}

export function encodeSearchCursor({ filter, offset, snapshot, expiresAt }) {
  return encodeCursorToken({ expires_at: expiresAt, feed: "search", filter, offset, snapshot, v: 1 });
}

function decodeSearchCursor(token, { filter, snapshot, nowInstant }) {
  const payload = decodeCursorToken(token, { nowInstant });
  if (typeof payload.snapshot !== "string" || !SNAPSHOT_PATTERN.test(payload.snapshot)) throw cursorInvalid();
  if (!Number.isSafeInteger(payload.offset) || payload.offset < 0 || payload.offset > READ_LIMITS.maxCursorOffset) throw cursorInvalid();
  if (payload.feed !== "search") throw new ReadRequestError(400, "cursor_binding_mismatch", "The cursor belongs to a different feed.");
  if (!cursorFilterMatches(payload.filter, filter)) throw new ReadRequestError(400, "cursor_binding_mismatch", "The cursor belongs to a different query.");
  if (payload.snapshot !== snapshot) throw cursorInvalid();
  return { offset: payload.offset };
}

// ---------------------------------------------------------------------------------------------
// Station content
// ---------------------------------------------------------------------------------------------

function stateRowOf(db, stationId) {
  return db.prepare("SELECT station_id, visible_record_id, state, forked, generation, materialized_at, last_replication_at FROM station_state WHERE station_id = ?").get(stationId) ?? null;
}

function projectionRowOf(db, stationId) {
  return db.prepare("SELECT visible_record_id, winning_sequence, name, normalized_name, short_name, homepage, country, station_json, provenance_json, indexed_at FROM station_projection WHERE station_id = ?").get(stationId) ?? null;
}

function tipsOf(db, stationId) {
  return db.prepare("SELECT record_id FROM station_tips WHERE station_id = ? ORDER BY record_id").all(stationId).map(row => row.record_id);
}

// Deterministic provenance summary: how many station records this node holds and which sources
// they were received from. The list is bounded and, in the pathological case of oversized source
// identifiers, the whole list is dropped rather than letting a response exceed its byte budget.
function provenanceOf(db, stationId) {
  const records = db.prepare("SELECT COUNT(*) AS count FROM records WHERE kind = 'station' AND subject_id = ?").get(stationId).count;
  const rows = db.prepare(`
    SELECT s.source_kind AS kind, s.source_id AS id, COUNT(DISTINCT s.record_id) AS records
      FROM record_sources s JOIN records r ON r.record_id = s.record_id
     WHERE r.kind = 'station' AND r.subject_id = ?
     GROUP BY s.source_kind, s.source_id
     ORDER BY s.source_kind, s.source_id`).all(stationId);
  const sources = rows.slice(0, READ_LIMITS.maxProvenanceSources).map(row => ({ kind: row.kind, id: row.id, records: row.records }));
  const provenance = { records, sources, sources_total: rows.length };
  if (Buffer.byteLength(JSON.stringify(provenance), "utf8") > READ_LIMITS.maxProvenanceBytes) {
    return { records, sources: [], sources_total: rows.length, truncated: true };
  }
  return provenance;
}

// When this node last received data for the station: the replicator's committed cursor time when
// one exists, otherwise the newest receipt timestamp this node holds. Both are local timestamps,
// never `issued_at`, so a station's wire freshness reflects local receipt rather than publisher
// claims.
function lastReplicationAt(db, stationId, stateRow) {
  const explicit = secondInstant(stateRow?.last_replication_at ?? null);
  if (explicit !== null) return explicit;
  const row = db.prepare("SELECT MAX(inserted_at) AS latest FROM records WHERE kind = 'station' AND subject_id = ?").get(stationId);
  return secondInstant(row?.latest ?? null);
}

const UNKNOWN_HEALTH = Object.freeze({ state: "unknown", expires_at: null, observed_at: null, outcome: null, observer: null, endpoint: null });

// The public badge: this node's newest admitted observation for the station, mapped into the
// client vocabulary. The signed expiry is always reported; an expired observation reports `state:
// unknown` and never `down` (docs/protocol-mvp.md, "Health observation").
export function healthOf(db, stationId, { observerId, nowInstant }) {
  if (typeof observerId !== "string" || observerId.length === 0) return UNKNOWN_HEALTH;
  const row = db.prepare(`
    SELECT r.record_id, r.canonical_payload
      FROM records r JOIN record_policy rp ON rp.record_id = r.record_id
     WHERE r.kind = 'observation' AND r.subject_id = ? AND rp.state = 'admitted'
       AND json_extract(r.canonical_payload, '$.observer.node_id') = ?
     ORDER BY r.issued_at DESC, r.record_id ASC
     LIMIT 1`).get(stationId, observerId);
  if (!row) return UNKNOWN_HEALTH;
  const payload = parseJsonStrict(Buffer.from(row.canonical_payload));
  const expiresAt = secondInstant(payload.expires_at);
  const expired = expiresAt === null || expiresAt <= nowInstant;
  return {
    state: expired ? "unknown" : healthStateOfOutcome(payload.outcome),
    expires_at: expiresAt,
    observed_at: secondInstant(payload.observed_at),
    outcome: payload.outcome,
    observer: { node_id: observerId, scope: "local" },
    endpoint: payload.endpoint,
  };
}

function baseItem(db, stationId, { observerId, nowInstant }) {
  const stateRow = stateRowOf(db, stationId);
  const projection = projectionRowOf(db, stationId);
  return {
    station_id: stationId,
    state: stateRow?.state ?? null,
    policy_state: policyStateOf(stateRow?.state),
    winning_record_id: stateRow?.visible_record_id ?? null,
    tips: tipsOf(db, stationId),
    forked: stateRow?.forked === 1,
    station: projection === null ? null : parseJsonStrict(Buffer.from(projection.station_json, "utf8")),
    provenance: provenanceOf(db, stationId),
    indexed_at: secondInstant(projection?.indexed_at ?? stateRow?.materialized_at ?? null),
    last_replication_at: lastReplicationAt(db, stationId, stateRow),
    // A health badge describes the station this node currently serves; observations are only ever
    // admitted for an active station (records.mjs applyObservationScope), so any other state
    // reports `unknown` instead of a stale badge for a station that is no longer served.
    health: stateRow?.state === "active" ? healthOf(db, stationId, { observerId, nowInstant }) : UNKNOWN_HEALTH,
  };
}

export function searchPage(db, { filter, limit, cursor, observerId, nowIso }) {
  const nowInstant = secondInstant(nowIso);
  if (nowInstant === null) throw new TypeError("nowIso must be an ISO instant");
  const keys = searchKeyRows(db, filter, { nowInstant, observerId })
    .map(row => ({ stationId: row.station_id, winningRecordId: row.winning_record_id, normalizedName: row.normalized_name, score: row.score }))
    .sort(compareSearchKeys);
  const snapshot = snapshotToken(keys);
  const offset = cursor === null ? 0 : decodeSearchCursor(cursor, { filter, snapshot, nowInstant }).offset;
  const items = keys.slice(offset, offset + limit).map(key => ({ ...baseItem(db, key.stationId, { observerId, nowInstant }), score: key.score }));
  const hasMore = offset + items.length < keys.length;
  const expiresAt = cursorExpiry(nowIso);
  return {
    items,
    next_cursor: hasMore ? encodeSearchCursor({ filter, offset: offset + items.length, snapshot, expiresAt }) : null,
    has_more: hasMore,
    query_snapshot: snapshot,
  };
}

export function stationResource(db, stationId, { observerId, nowIso }) {
  const nowInstant = secondInstant(nowIso);
  if (nowInstant === null) throw new TypeError("nowIso must be an ISO instant");
  const exists = Boolean(db.prepare("SELECT 1 FROM records WHERE kind = 'station' AND subject_id = ?").get(stationId));
  if (!exists) throw new ReadRequestError(404, "station_not_found", "This node holds no records for that station.");
  const stateRow = stateRowOf(db, stationId);
  const policyState = policyStateOf(stateRow?.state);
  if (stateRow === null || policyState === null) {
    throw new ReadRequestError(404, "station_not_materialized", "That station has no materialized view on this node.", { state: stateRow?.state ?? "unmaterialized" });
  }
  const body = baseItem(db, stationId, { observerId, nowInstant });
  return { ...body, materialized_at: secondInstant(stateRow.materialized_at) };
}

// The health view distinguishes what the node holds: the local badge (`aggregate`), the admitted
// observations (newest first, bounded), and how much input is held back by quarantine. An
// observation that has expired reports its signed expiry together with `state: unknown`.
export function healthResource(db, stationId, { observerId, nowIso }) {
  const nowInstant = secondInstant(nowIso);
  if (nowInstant === null) throw new TypeError("nowIso must be an ISO instant");
  const exists = Boolean(db.prepare("SELECT 1 FROM records WHERE kind = 'station' AND subject_id = ?").get(stationId));
  if (!exists) throw new ReadRequestError(404, "station_not_found", "This node holds no records for that station.");
  const stateRow = stateRowOf(db, stationId);
  const counts = db.prepare(`
    SELECT SUM(CASE WHEN rp.state = 'admitted' THEN 1 ELSE 0 END) AS admitted,
           SUM(CASE WHEN rp.state <> 'admitted' THEN 1 ELSE 0 END) AS quarantined
      FROM records r JOIN record_policy rp ON rp.record_id = r.record_id
     WHERE r.kind = 'observation' AND r.subject_id = ?`).get(stationId);
  const rows = db.prepare(`
    SELECT r.record_id, r.canonical_payload
      FROM records r JOIN record_policy rp ON rp.record_id = r.record_id
     WHERE r.kind = 'observation' AND r.subject_id = ? AND rp.state = 'admitted'
     ORDER BY r.issued_at DESC, r.record_id ASC
     LIMIT ?`).all(stationId, READ_LIMITS.maxHealthObservations);
  const observations = rows.map(row => {
    const payload = parseJsonStrict(Buffer.from(row.canonical_payload));
    const expiresAt = secondInstant(payload.expires_at);
    const expired = expiresAt === null || expiresAt <= nowInstant;
    const observerIdOfRecord = payload.observer.node_id;
    return {
      record_id: row.record_id,
      policy_state: "admitted",
      observer: { node_id: observerIdOfRecord, scope: observerIdOfRecord === observerId ? "local" : "remote" },
      endpoint: payload.endpoint,
      outcome: payload.outcome,
      state: expired ? "unknown" : healthStateOfOutcome(payload.outcome),
      observed_at: secondInstant(payload.observed_at),
      expires_at: expiresAt,
      latency_ms: payload.latency_ms ?? null,
      http_status: payload.http_status ?? null,
      diagnostic_code: payload.diagnostic_code ?? null,
    };
  });
  return {
    station_id: stationId,
    state: stateRow?.state ?? null,
    policy_state: policyStateOf(stateRow?.state),
    aggregate: stateRow?.state === "active" ? healthOf(db, stationId, { observerId, nowInstant }) : UNKNOWN_HEALTH,
    observations,
    counts: {
      admitted: counts.admitted ?? 0,
      quarantined: counts.quarantined ?? 0,
      expired: observations.filter(observation => observation.state === "unknown").length,
      listed: observations.length,
    },
  };
}

// The signed node card this node serves at /v1/node. Cards are ingested as ordinary signed
// envelopes (kind `node`) and this process holds no signing key (docs/registry-node-security-
// contract.md KEY-01); the newest admitted, unexpired card for the configured node identity is
// served verbatim from the immutable store. Nothing here fabricates a card.
export function nodeCardResource(db, nodeId, { nowIso }) {
  if (typeof nodeId !== "string" || nodeId.length === 0) return { kind: "unavailable" };
  const nowInstant = secondInstant(nowIso);
  if (nowInstant === null) throw new TypeError("nowIso must be an ISO instant");
  const row = db.prepare(`
    SELECT r.relay_envelope, json_extract(r.canonical_payload, '$.expires_at') AS expires_at
      FROM records r JOIN record_policy rp ON rp.record_id = r.record_id
     WHERE r.kind = 'node' AND r.subject_id = ? AND rp.state = 'admitted'
     ORDER BY expires_at DESC, r.record_id ASC
     LIMIT 1`).get(nodeId);
  if (!row || typeof row.expires_at !== "string") return { kind: "unavailable" };
  const expiresAt = secondInstant(row.expires_at);
  if (expiresAt === null || expiresAt <= nowInstant) return { kind: "expired", expiresAt };
  return { kind: "ok", bytes: Buffer.from(row.relay_envelope), expiresAt };
}
