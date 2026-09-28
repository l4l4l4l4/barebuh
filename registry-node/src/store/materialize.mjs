// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Deterministic station materializer and rebuildable projection for the private registry node.
//
// The projection is derived state: it is always recomputable from the immutable records without
// any network access, and it is never repaired with unsigned data. Writing is a local
// administrator operation; the HTTP listener keeps serving discovery and health only, because the
// station and search routes are later work.
//
// Guarantees:
//   * materialization is a pure function of the stored record set (dag.mjs) plus local policy.
//     Receipt time, insert order, and `issued_at` never choose a winner;
//   * a station row is only rewritten when the derived content actually changes, so restarts,
//     queue drains, and duplicate ingests do not churn generations. Provenance is reduced to a
//     deterministic summary (record count and distinct source count per source) so receipt
//     timestamps cannot cause churn either;
//   * every write happens inside one BEGIN IMMEDIATE transaction that also clears the station's
//     queue entry: a crash either commits the whole station update or none of it;
//   * `verifyProjection` recomputes everything and reports mismatches;
//     `rebuildProjection` reconciles stored rows with the derived truth, including stray rows for
//     stations whose records are gone and a materializer version change.
//
// Nothing in this module performs network I/O.

import { createHash } from "node:crypto";

import { canonicalize } from "../../../protocol/v1/lib/conformance.mjs";
import { computeStationMaterialization } from "./dag.mjs";
import { withTransaction } from "./db.mjs";
import { foreignParentRecordIds, loadStationRecordViews, readRecordPayload } from "./records.mjs";

// Bumped whenever the derived content of the projection changes shape: a stored projection with a
// different version is force-rebuilt.
export const MATERIALIZER_VERSION = 2;

// A single drain call processes at most this many stations; the rest stays queued and visible.
export const MATERIALIZE_BATCH_LIMIT = 64;

const SNAPSHOT_SECTIONS = ["state", "tips", "projection", "streams", "tags", "languages", "fts"];

export function digestOfUrl(url) {
  return `sha256:${createHash("sha256").update(Buffer.from(url, "utf8")).digest("base64url")}`;
}

// Search normalization is deliberately simple and total: NFKD, drop combining marks, lowercase,
// collapse whitespace. It is applied to station names, tags, and language tags for ordering and
// matching; signed bytes are never normalized.
export function normalizeText(value) {
  return value.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/\s+/gu, " ").trim();
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Interoperability search order (docs/protocol-mvp.md): text score descending, normalized station
// name ascending, then station ID ascending. `score` is the projection's relevance score (the
// FTS5 rank for a text query). The search route itself is later work; the ordering lives here so
// the projection and the future API cannot diverge.
export function compareSearchRows(left, right) {
  return right.score - left.score || compareStrings(left.normalizedName, right.normalizedName) || compareStrings(left.stationId, right.stationId);
}

// The station-local record view the materializer classifies. A parent stored under another subject
// is treated as invalid rather than missing: it can never become valid, so the record must not be
// materialized even though the station-local view cannot see the foreign parent.
function stationView(db, stationId) {
  const records = loadStationRecordViews(db, stationId);
  const foreign = foreignParentRecordIds(db, records);
  if (foreign.size === 0) return records;
  return records.map(record => (record.parents.some(parentId => foreign.has(parentId)) ? { ...record, policy: "quarantined" } : record));
}

// Deterministic provenance summary: how many records this node holds for the station and which
// sources they were received from. Timestamps and receipt counts are intentionally excluded so an
// idempotent duplicate cannot mark the projection stale.
function provenanceSummary(db, stationId) {
  const sources = db.prepare(`
    SELECT s.source_kind AS kind, s.source_id AS id, COUNT(DISTINCT s.record_id) AS records
      FROM record_sources s
      JOIN records r ON r.record_id = s.record_id
     WHERE r.kind = 'station' AND r.subject_id = ?
     GROUP BY s.source_kind, s.source_id
     ORDER BY s.source_kind, s.source_id`).all(stationId)
    .map(row => ({ kind: row.kind, id: row.id, records: row.records }));
  const records = db.prepare("SELECT COUNT(*) AS count FROM records WHERE kind = 'station' AND subject_id = ?").get(stationId).count;
  return canonicalize({ records, sources });
}

function emptySnapshot() {
  return { state: null, tips: [], projection: null, streams: [], tags: [], languages: [], fts: null };
}

// Computes exactly what the projection for this station must contain, without writing anything.
export function desiredStationSnapshot(db, stationId) {
  const records = stationView(db, stationId);
  const computed = computeStationMaterialization(records);
  if (computed.state === null) return emptySnapshot();
  const winner = computed.visibleWinner === null ? null : records.find(record => record.recordId === computed.visibleWinner) ?? null;
  let projection = null;
  if (winner && !winner.isTombstone) {
    const { station } = readRecordPayload(db, winner.recordId);
    projection = {
      visibleRecordId: winner.recordId,
      winningSequence: winner.sequence,
      name: station.name,
      normalizedName: normalizeText(station.name),
      shortName: station.short_name ?? null,
      homepage: station.homepage ?? null,
      country: station.country ?? null,
      stationJson: canonicalize(station),
      streams: (station.streams ?? []).map((stream, ordinal) => ({
        ordinal,
        url: stream.url,
        urlDigest: digestOfUrl(stream.url),
        transport: stream.transport ?? null,
        container: stream.container ?? null,
        codec: stream.codec ?? null,
        bitrateKbps: stream.bitrate_kbps ?? null,
      })),
      tags: (station.tags ?? []).map(tag => ({ tag, normalized: normalizeText(tag) })),
      languages: (station.languages ?? []).map(language => ({ language, normalized: normalizeText(language) })),
      provenanceJson: provenanceSummary(db, stationId),
    };
  }
  return {
    state: {
      state: computed.state,
      protocolWinner: computed.protocolWinner,
      visibleWinner: computed.visibleWinner,
      forked: computed.forked ? 1 : 0,
    },
    tips: computed.tips,
    projection,
    streams: projection?.streams ?? [],
    tags: projection?.tags ?? [],
    languages: projection?.languages ?? [],
    fts: projection === null ? null : { name: projection.name, shortName: projection.shortName ?? "", tags: projection.tags.map(tag => tag.tag).join(" ") },
  };
}

// Reads the stored projection exactly as `desiredStationSnapshot` would produce it, so the two can
// be compared section by section.
export function storedStationSnapshot(db, stationId) {
  const stateRow = db.prepare("SELECT state, protocol_winning_record_id, visible_record_id, forked FROM station_state WHERE station_id = ?").get(stationId);
  const projectionRow = db.prepare(`
    SELECT visible_record_id, winning_sequence, name, normalized_name, short_name, homepage, country, station_json, provenance_json
      FROM station_projection WHERE station_id = ?`).get(stationId);
  const streams = db.prepare("SELECT ordinal, url, url_digest, transport, container, codec, bitrate_kbps FROM station_streams WHERE station_id = ? ORDER BY ordinal").all(stationId)
    .map(row => ({ ordinal: row.ordinal, url: row.url, urlDigest: row.url_digest, transport: row.transport, container: row.container, codec: row.codec, bitrateKbps: row.bitrate_kbps }));
  const tags = db.prepare("SELECT tag, normalized_tag FROM station_tags WHERE station_id = ? ORDER BY normalized_tag").all(stationId)
    .map(row => ({ tag: row.tag, normalized: row.normalized_tag }));
  const languages = db.prepare("SELECT language, normalized_language FROM station_languages WHERE station_id = ? ORDER BY normalized_language").all(stationId)
    .map(row => ({ language: row.language, normalized: row.normalized_language }));
  const ftsRows = db.prepare("SELECT name, short_name, tags FROM station_fts WHERE station_id = ? ORDER BY rowid").all(stationId);
  return {
    state: stateRow ? { state: stateRow.state, protocolWinner: stateRow.protocol_winning_record_id, visibleWinner: stateRow.visible_record_id, forked: stateRow.forked } : null,
    tips: db.prepare("SELECT record_id FROM station_tips WHERE station_id = ? ORDER BY record_id").all(stationId).map(row => row.record_id),
    projection: projectionRow ? {
      visibleRecordId: projectionRow.visible_record_id,
      winningSequence: projectionRow.winning_sequence,
      name: projectionRow.name,
      normalizedName: projectionRow.normalized_name,
      shortName: projectionRow.short_name,
      homepage: projectionRow.homepage,
      country: projectionRow.country,
      stationJson: projectionRow.station_json,
      provenanceJson: projectionRow.provenance_json,
    } : null,
    streams,
    tags,
    languages,
    fts: ftsRows.length === 0 ? null : (ftsRows.length === 1 ? { name: ftsRows[0].name, shortName: ftsRows[0].short_name, tags: ftsRows[0].tags } : { duplicatedRows: ftsRows.length }),
  };
}

function normalizedSnapshot(snapshot) {
  return {
    state: snapshot.state === null ? null : { state: snapshot.state.state, protocolWinner: snapshot.state.protocolWinner, visibleWinner: snapshot.state.visibleWinner, forked: Number(snapshot.state.forked) },
    tips: [...snapshot.tips].sort(compareStrings),
    // timestamps and generations are history, not content: they are compared separately.
    projection: snapshot.projection === null ? null : {
      visibleRecordId: snapshot.projection.visibleRecordId,
      winningSequence: snapshot.projection.winningSequence,
      name: snapshot.projection.name,
      normalizedName: snapshot.projection.normalizedName,
      shortName: snapshot.projection.shortName,
      homepage: snapshot.projection.homepage,
      country: snapshot.projection.country,
      stationJson: snapshot.projection.stationJson,
      provenanceJson: snapshot.projection.provenanceJson,
    },
    streams: [...snapshot.streams].sort((left, right) => left.ordinal - right.ordinal),
    tags: [...snapshot.tags].sort((left, right) => compareStrings(left.normalized, right.normalized) || compareStrings(left.tag, right.tag)),
    languages: [...snapshot.languages].sort((left, right) => compareStrings(left.normalized, right.normalized) || compareStrings(left.language, right.language)),
    fts: snapshot.fts,
  };
}

// Section names whose stored content differs from the derived content, in a fixed order.
export function snapshotDifferences(desired, stored) {
  const left = normalizedSnapshot(desired);
  const right = normalizedSnapshot(stored);
  return SNAPSHOT_SECTIONS.filter(section => canonicalize(left[section]) !== canonicalize(right[section]));
}

function writeStationSnapshot(db, stationId, desired, now) {
  if (desired.state === null) {
    db.prepare("DELETE FROM station_state WHERE station_id = ?").run(stationId);
    db.prepare("DELETE FROM station_tips WHERE station_id = ?").run(stationId);
    db.prepare("DELETE FROM station_projection WHERE station_id = ?").run(stationId);
    db.prepare("DELETE FROM station_fts WHERE station_id = ?").run(stationId);
    return;
  }
  const generation = (db.prepare("SELECT generation FROM station_state WHERE station_id = ?").get(stationId)?.generation ?? 0) + 1;
  db.prepare(`
    INSERT INTO station_state(station_id, protocol_winning_record_id, visible_record_id, state, forked, generation, materialized_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(station_id) DO UPDATE SET
      protocol_winning_record_id = excluded.protocol_winning_record_id,
      visible_record_id = excluded.visible_record_id,
      state = excluded.state,
      forked = excluded.forked,
      generation = excluded.generation,
      materialized_at = excluded.materialized_at`)
    .run(stationId, desired.state.protocolWinner, desired.state.visibleWinner, desired.state.state, desired.state.forked, generation, now);

  db.prepare("DELETE FROM station_tips WHERE station_id = ?").run(stationId);
  for (const tip of desired.tips) db.prepare("INSERT INTO station_tips(station_id, record_id) VALUES (?, ?)").run(stationId, tip);

  db.prepare("DELETE FROM station_fts WHERE station_id = ?").run(stationId);
  if (desired.projection === null) {
    db.prepare("DELETE FROM station_projection WHERE station_id = ?").run(stationId);
  } else {
    const { projection } = desired;
    db.prepare(`
      INSERT INTO station_projection(station_id, visible_record_id, winning_sequence, name, normalized_name, short_name, homepage, country, station_json, provenance_json, indexed_at, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(station_id) DO UPDATE SET
        visible_record_id = excluded.visible_record_id,
        winning_sequence = excluded.winning_sequence,
        name = excluded.name,
        normalized_name = excluded.normalized_name,
        short_name = excluded.short_name,
        homepage = excluded.homepage,
        country = excluded.country,
        station_json = excluded.station_json,
        provenance_json = excluded.provenance_json,
        indexed_at = excluded.indexed_at,
        generation = excluded.generation`)
      .run(stationId, projection.visibleRecordId, projection.winningSequence, projection.name, projection.normalizedName, projection.shortName,
           projection.homepage, projection.country, projection.stationJson, projection.provenanceJson, now, generation);

    db.prepare("DELETE FROM station_streams WHERE station_id = ?").run(stationId);
    for (const stream of projection.streams) {
      db.prepare("INSERT INTO station_streams(station_id, ordinal, url, url_digest, transport, container, codec, bitrate_kbps) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(stationId, stream.ordinal, stream.url, stream.urlDigest, stream.transport, stream.container, stream.codec, stream.bitrateKbps);
    }
    db.prepare("DELETE FROM station_tags WHERE station_id = ?").run(stationId);
    for (const tag of projection.tags) {
      db.prepare("INSERT INTO station_tags(station_id, tag, normalized_tag) VALUES (?, ?, ?)").run(stationId, tag.tag, tag.normalized);
    }
    db.prepare("DELETE FROM station_languages WHERE station_id = ?").run(stationId);
    for (const language of projection.languages) {
      db.prepare("INSERT INTO station_languages(station_id, language, normalized_language) VALUES (?, ?, ?)").run(stationId, language.language, language.normalized);
    }
    db.prepare("INSERT INTO station_fts(station_id, name, short_name, tags) VALUES (?, ?, ?, ?)")
      .run(stationId, desired.fts.name, desired.fts.shortName, desired.fts.tags);
  }
  db.prepare("UPDATE projection_meta SET generation = generation + 1, materializer_version = ?, rebuilt_at = ? WHERE singleton = 1")
    .run(MATERIALIZER_VERSION, now);
}

// Materializes one station. Returns the derived state whether or not anything was written.
// `force` rewrites the rows even when the content already matches (used when the materializer
// version changed).
export function materializeStation(db, stationId, options = {}) {
  const { now = new Date().toISOString(), force = false } = options;
  return withTransaction(db, () => {
    const desired = desiredStationSnapshot(db, stationId);
    const differences = snapshotDifferences(desired, storedStationSnapshot(db, stationId));
    const changed = force || differences.length > 0;
    if (changed) writeStationSnapshot(db, stationId, desired, now);
    db.prepare("DELETE FROM materialize_queue WHERE station_id = ?").run(stationId);
    return {
      stationId,
      changed,
      differences: changed ? differences : [],
      state: desired.state?.state ?? null,
      forked: desired.state?.forked === 1,
      protocolWinner: desired.state?.protocolWinner ?? null,
      visibleWinner: desired.state?.visibleWinner ?? null,
      tips: desired.tips,
    };
  });
}

// Processes at most `limit` queued stations. A station that fails is left queued with an attempt
// counter and a bounded error so a single bad station cannot starve or block the others.
export function drainMaterializeQueue(db, options = {}) {
  const { limit = MATERIALIZE_BATCH_LIMIT, now = new Date().toISOString() } = options;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("limit must be a positive safe integer");
  const pending = db.prepare("SELECT station_id FROM materialize_queue ORDER BY enqueued_at, station_id LIMIT ?").all(limit).map(row => row.station_id);
  const outcomes = [];
  for (const stationId of pending) {
    try {
      const result = materializeStation(db, stationId, { now });
      outcomes.push({ stationId, status: "materialized", changed: result.changed, state: result.state });
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 512);
      withTransaction(db, () => {
        db.prepare("UPDATE materialize_queue SET attempts = attempts + 1, last_error = ? WHERE station_id = ?").run(message, stationId);
      });
      outcomes.push({ stationId, status: "failed", error: message });
    }
  }
  return {
    processed: pending.length,
    failed: outcomes.filter(outcome => outcome.status === "failed").length,
    remaining: db.prepare("SELECT COUNT(*) AS count FROM materialize_queue").get().count,
    outcomes,
  };
}

export function projectionMaterializerVersion(db) {
  return db.prepare("SELECT materializer_version FROM projection_meta WHERE singleton = 1").get().materializer_version;
}

// Every station the projection tables or the record store knows about. Includes stray projection
// rows for stations whose records are gone: rebuild must reconcile those too.
export function listProjectedStationIds(db) {
  const ids = new Set();
  const collect = statement => {
    for (const row of statement.all()) ids.add(row.id);
  };
  collect(db.prepare("SELECT DISTINCT subject_id AS id FROM records WHERE kind = 'station'"));
  collect(db.prepare("SELECT station_id AS id FROM station_state"));
  collect(db.prepare("SELECT station_id AS id FROM station_projection"));
  return [...ids].sort(compareStrings);
}

// Recomputes every station from the immutable records and reports the sections that do not match
// the stored projection. Read-only: never repairs anything.
export function verifyProjection(db) {
  const mismatches = [];
  const version = projectionMaterializerVersion(db);
  if (version !== MATERIALIZER_VERSION) mismatches.push({ stationId: null, kind: "materializer_version", expected: MATERIALIZER_VERSION, actual: version });
  const stationIds = listProjectedStationIds(db);
  for (const stationId of stationIds) {
    const differences = snapshotDifferences(desiredStationSnapshot(db, stationId), storedStationSnapshot(db, stationId));
    if (differences.length > 0) mismatches.push({ stationId, kind: "station", differences });
  }
  return { checked: stationIds.length, materializerVersion: version, mismatches };
}

// Rebuilds the projection for every station from the immutable records. A station is only
// rewritten when its derived content differs (or when the materializer version changed), so a
// clean rebuild is a no-op.
export function rebuildProjection(db, options = {}) {
  const { now = new Date().toISOString() } = options;
  const forced = projectionMaterializerVersion(db) !== MATERIALIZER_VERSION;
  const stationIds = listProjectedStationIds(db);
  const changed = [];
  for (const stationId of stationIds) {
    const result = materializeStation(db, stationId, { now, force: forced });
    if (result.changed) changed.push(stationId);
  }
  withTransaction(db, () => {
    db.prepare("UPDATE projection_meta SET materializer_version = ?, rebuilt_at = ? WHERE singleton = 1").run(MATERIALIZER_VERSION, now);
  });
  return { stations: stationIds.length, changed, materializerVersion: MATERIALIZER_VERSION, forced };
}

// Operator (and test) view of one station: the stored projection plus whether it still matches the
// derived state.
export function stationReport(db, stationId) {
  const stored = storedStationSnapshot(db, stationId);
  const differences = snapshotDifferences(desiredStationSnapshot(db, stationId), stored);
  return { stationId, ...stored, consistent: differences.length === 0, differences };
}
