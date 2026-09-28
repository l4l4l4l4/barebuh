// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.mjs";
import { createRegistryServer, ROUTES } from "../src/http.mjs";
import { LATEST_SCHEMA_VERSION, migrateDatabase, openDatabase } from "../src/store/db.mjs";

const migrationsDir = new URL("../migrations/", import.meta.url);

async function startServer(t, { migrated = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "barebuh-http-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "registry.sqlite3");
  if (migrated) {
    await migrateDatabase(databasePath, { migrationsDir });
  } else {
    // The readiness path must be exercised against a real database file that is simply not
    // migrated yet, not against a missing file.
    openDatabase(databasePath).close();
  }
  const db = openDatabase(databasePath, { readOnly: true });
  t.after(() => db.close());
  const config = loadConfig({
    BAREBUH_DATABASE_PATH: databasePath,
    BAREBUH_PORT: "0",
    BAREBUH_PUBLIC_BASE_URL: "https://registry.example/",
  });
  const server = createRegistryServer({ config, db });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

// Sends a raw request-target over a plain socket so malformed targets reach the server exactly
// as a hostile client would send them (fetch and curl refuse or normalize several of these).
function rawRequest(port, requestTarget, { method = "GET" } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let received = "";
    socket.setTimeout(5_000, () => socket.destroy(new Error("raw request timed out")));
    socket.on("connect", () => {
      socket.write(`${method} ${requestTarget} HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: close\r\n\r\n`);
    });
    socket.on("data", chunk => {
      received += chunk.toString("latin1");
    });
    socket.on("end", () => resolve(received));
    socket.on("close", () => resolve(received));
    socket.on("error", reject);
  });
}

function statusLine(rawResponse) {
  return rawResponse.split("\r\n")[0];
}

function jsonBody(rawResponse) {
  const separator = rawResponse.indexOf("\r\n\r\n");
  assert.notEqual(separator, -1, `raw response has no header/body separator: ${JSON.stringify(rawResponse)}`);
  return JSON.parse(rawResponse.slice(separator + 4));
}

test("route inventory contains only bounded reads and the refused submission boundary", () => {
  assert.deepEqual(ROUTES, [
    "GET /.well-known/open-radio-registry",
    "GET /health/live",
    "GET /health/ready",
    "GET /v1/node",
    "GET /v1/records",
    "GET /v1/snapshot",
    "GET /v1/search",
    "GET /v1/stations/{station-key-digest}",
    "GET /v1/health/{station-key-digest}",
    "POST /v1/records",
  ]);
});

test("well-known descriptor is deterministic, private-read-only, and cacheable", async t => {
  const base = await startServer(t);
  const response = await fetch(`${base}/.well-known/open-radio-registry`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  const etag = response.headers.get("etag");
  assert.match(etag, /^"[0-9a-f]{64}"$/u);
  assert.deepEqual(await response.json(), {
    protocol: "oradio/1",
    api_versions: [1],
    node: "https://registry.example/v1/node",
    api_base: "https://registry.example/v1/",
    records: "https://registry.example/v1/records",
    snapshot: "https://registry.example/v1/snapshot",
    peers: "https://registry.example/v1/peers",
  });

  const cached = await fetch(`${base}/.well-known/open-radio-registry`, { headers: { "if-none-match": etag } });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), "");
});

test("liveness does no dependency work and readiness checks only the local database", async t => {
  const base = await startServer(t);
  const live = await fetch(`${base}/health/live`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: "live" });

  const ready = await fetch(`${base}/health/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: "ready", schema_version: LATEST_SCHEMA_VERSION });
});

test("readiness fails closed when the database is not migrated to the current schema", async t => {
  const base = await startServer(t, { migrated: false });
  const ready = await fetch(`${base}/health/ready`);
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), { status: "not_ready", reason: "local_database" });
});

test("mutation methods are refused, the submission boundary is closed, and the record feed is absent", async t => {
  const base = await startServer(t);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await fetch(`${base}/.well-known/open-radio-registry`, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
  }
  // The submission boundary is a real route that always refuses before reading a body.
  const submission = await fetch(`${base}/v1/records`, { method: "POST", body: '{"payload":{}}' });
  assert.equal(submission.status, 403);
  assert.deepEqual((await submission.json()).error.code, "submission_disabled");
  // The read-only record feed itself is still absent, and the search API is served.
  assert.equal((await fetch(`${base}/v1/records`)).status, 404);
  assert.equal((await fetch(`${base}/v1/search?limit=64`)).status, 200);
});

// Regression coverage for review t_bf762a64 blocker B1: a malformed request-target must be
// answered with a clean 400 over the existing socket and must never terminate the process.
test("malformed absolute-form request targets are answered 400 and the server survives", async t => {
  const base = await startServer(t);
  const port = Number(new URL(base).port);
  const malformedTargets = [
    "http://[::1", // exact raw-TCP repro from review t_bf762a64 (B1)
    "http://", // absolute-form without an authority
    "http://registry.example:99999/x", // absolute-form with an out-of-range port
    "ftp://registry.example/x", // absolute-form with a non-HTTP scheme
  ];
  for (const target of malformedTargets) {
    const raw = await rawRequest(port, target);
    assert.match(statusLine(raw), /^HTTP\/1\.1 400 /u, `target ${JSON.stringify(target)} was not rejected: ${statusLine(raw)}`);
    assert.equal(jsonBody(raw).error.code, "bad_request");
  }
  // Proof the same server instance keeps serving well-formed requests afterwards.
  const live = await fetch(`${base}/health/live`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: "live" });
});

test("invalid percent-encoding and oversized request targets are answered 400 and the server survives", async t => {
  const base = await startServer(t);
  const port = Number(new URL(base).port);
  const malformedTargets = [
    "/%zz", // "%" not followed by two hex digits
    "/health%2live", // truncated percent-escape
    "/%01", // percent-encoded control octet
    `/${"a".repeat(8192)}`, // request target beyond the accepted bound
  ];
  for (const target of malformedTargets) {
    const raw = await rawRequest(port, target);
    assert.match(statusLine(raw), /^HTTP\/1\.1 400 /u, `target ${JSON.stringify(target.slice(0, 24))} was not rejected: ${statusLine(raw)}`);
    assert.equal(jsonBody(raw).error.code, "bad_request");
  }
  // Proof the same server instance keeps serving well-formed requests afterwards.
  const descriptor = await fetch(`${base}/.well-known/open-radio-registry`);
  assert.equal(descriptor.status, 200);
  assert.equal((await descriptor.json()).protocol, "oradio/1");
});
