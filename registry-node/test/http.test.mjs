// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.mjs";
import { createRegistryServer, ROUTES } from "../src/http.mjs";
import { migrateDatabase, openDatabase } from "../src/store/db.mjs";

const migrationsDir = new URL("../migrations/", import.meta.url);

async function startServer(t, { migrated = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "barebuh-http-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "registry.sqlite3");
  if (migrated) await migrateDatabase(databasePath, { migrationsDir });
  const db = openDatabase(databasePath, { readOnly: migrated });
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

test("route inventory contains only discovery and operational health GETs", () => {
  assert.deepEqual(ROUTES, [
    "GET /.well-known/open-radio-registry",
    "GET /health/live",
    "GET /health/ready",
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
  assert.deepEqual(await ready.json(), { status: "ready", schema_version: 1 });
});

test("mutation methods and unimplemented protocol routes are absent", async t => {
  const base = await startServer(t);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await fetch(`${base}/.well-known/open-radio-registry`, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
  }
  assert.equal((await fetch(`${base}/v1/records`)).status, 404);
  assert.equal((await fetch(`${base}/v1/search`)).status, 404);
});
