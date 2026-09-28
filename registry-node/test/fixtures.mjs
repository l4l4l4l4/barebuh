// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Test helpers: signing key pairs, envelope builders, and a fresh migrated registry database.
// Fixtures use only locally generated keys and never touch the network.

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalize } from "../../protocol/v1/lib/conformance.mjs";
import { migrateDatabase, openDatabase } from "../src/store/db.mjs";

const migrationsDir = new URL("../migrations/", import.meta.url);
export const VALIDATION_TIME = "2026-09-26T12:20:00Z";

export function createSigner(kind) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "jwk" }).x;
  const digest = createHash("sha256").update(Buffer.from(raw, "base64url")).digest("base64url");
  return {
    kind,
    rootKey: { kty: "OKP", crv: "Ed25519", x: raw },
    identity: `oradio:${kind}:ed25519:${digest}`,
    sign(payload) {
      return {
        payload,
        proof: {
          alg: "Ed25519",
          key_id: "root",
          signature: sign(null, Buffer.from(canonicalize(payload), "utf8"), privateKey).toString("base64url"),
        },
      };
    },
    bytes(payloadOrEnvelope) {
      // Accepts either a raw payload or an already signed envelope so tests cannot accidentally
      // sign a signed envelope.
      const envelope = payloadOrEnvelope?.payload && payloadOrEnvelope?.proof ? payloadOrEnvelope : this.sign(payloadOrEnvelope);
      return Buffer.from(JSON.stringify(envelope));
    },
  };
}

export function recordIdOf(envelope) {
  return `sha256:${createHash("sha256").update(Buffer.from(canonicalize(envelope.payload), "utf8")).digest("base64url")}`;
}

export function digestOfUrl(url) {
  return `sha256:${createHash("sha256").update(Buffer.from(url, "utf8")).digest("base64url")}`;
}

export function streamUrl(index) {
  return `https://stream.example.invalid/live-${index}`;
}

export function streamFor(url) {
  return { url, transport: new URL(url).protocol.slice(0, -1), container: "audio/mpeg", codec: "mp3", bitrate_kbps: 128 };
}

export function stationBody(name = "Example FM", { streams = 1, ...rest } = {}) {
  const list = Number.isInteger(streams) ? Array.from({ length: streams }, (_, index) => streamFor(streamUrl(index))) : streams;
  return { name, ...rest, streams: list };
}

export function stationRecord(signer, { sequence, parents = [], station, issuedAt = "2026-09-26T12:00:00Z", extra = {} }) {
  return signer.sign({
    protocol: "oradio/1",
    kind: "station",
    station_id: signer.identity,
    sequence,
    parents,
    issued_at: issuedAt,
    root_key: signer.rootKey,
    station,
    ...extra,
  });
}

export function observationRecord(nodeSigner, { stationId, endpoint, observedAt = "2026-09-26T12:15:00Z", expiresAt = "2026-09-26T12:30:00Z", outcome = "ok", extra = {} }) {
  return nodeSigner.sign({
    protocol: "oradio/1",
    kind: "observation",
    observer: { node_id: nodeSigner.identity, root_key: nodeSigner.rootKey },
    station_id: stationId,
    endpoint,
    observed_at: observedAt,
    expires_at: expiresAt,
    outcome,
    ...extra,
  });
}

export function nodeCardRecord(nodeSigner, { issuedAt = "2026-09-26T11:00:00Z", expiresAt = "2026-09-26T13:00:00Z", extra = {} } = {}) {
  return nodeSigner.sign({
    protocol: "oradio/1",
    kind: "node",
    node_id: nodeSigner.identity,
    root_key: nodeSigner.rootKey,
    operator_url: "https://registry.example/operator",
    api_bases: ["https://registry.example/v1/"],
    supported_majors: [1],
    capabilities: ["records", "snapshot"],
    issued_at: issuedAt,
    expires_at: expiresAt,
    ...extra,
  });
}

export function nestedArrays(depth) {
  let value = 0;
  for (let level = 0; level < depth; ++level) value = [value];
  return value;
}

export function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

export function policyRow(db, recordId) {
  const row = db.prepare("SELECT state, reason_code FROM record_policy WHERE record_id = ?").get(recordId);
  return row ? { state: row.state, reasonCode: row.reason_code } : null;
}

export async function createRegistry(t) {
  const directory = await mkdtemp(join(tmpdir(), "barebuh-store-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "registry.sqlite3");
  await migrateDatabase(databasePath, { migrationsDir });
  const fixture = {
    directory,
    databasePath,
    db: openDatabase(databasePath),
    open(options = {}) {
      fixture.db = openDatabase(databasePath, options);
      return fixture.db;
    },
    reopen(options = {}) {
      fixture.close();
      return fixture.open(options);
    },
    close() {
      if (fixture.db) {
        fixture.db.close();
        fixture.db = null;
      }
    },
  };
  t.after(() => fixture.close());
  return fixture;
}
