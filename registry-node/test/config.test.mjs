// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.mjs";

test("default configuration is local and read-only with no network workers", () => {
  const config = loadConfig({});

  assert.deepEqual(config, {
    mode: "MVP_LOCAL_READ_ONLY",
    databasePath: "var/registry.sqlite3",
    host: "127.0.0.1",
    port: 8787,
    publicBaseUrl: "https://registry.invalid/",
    nodeId: null,
    writesEnabled: false,
    networkProbesEnabled: false,
    federationEnabled: false,
    peerWorkers: 0,
    stationCheckerWorkers: 0,
  });
});

test("the optional node identity is a public identifier and never a key", () => {
  const nodeId = "oradio:node:ed25519:Wzz6buDMljkddWS2frYOsSzLipZaxrhDmo5Ix8G-PK8";
  assert.equal(loadConfig({ BAREBUH_NODE_ID: nodeId }).nodeId, nodeId);
  // An empty value means "no identity configured", which fails closed at /v1/node.
  assert.equal(loadConfig({ BAREBUH_NODE_ID: "" }).nodeId, null);
  assert.throws(() => loadConfig({ BAREBUH_NODE_ID: "oradio:station:ed25519:Wzz6buDMljkddWS2frYOsSzLipZaxrhDmo5Ix8G-PK8" }), /node identity/u);
  // A non-canonical base64url digest is rejected even when it decodes to 32 bytes.
  assert.throws(() => loadConfig({ BAREBUH_NODE_ID: "oradio:node:ed25519:Wzz6buDMljkddWS2frYOsSzLipZaxrhDmo5Ix8G-PK9" }), /node identity/u);
  assert.throws(() => loadConfig({ BAREBUH_NODE_ID: "not-an-identity" }), /node identity/u);
});

test("unsupported mutation, probe, federation, and public-listener settings fail closed", () => {
  assert.throws(() => loadConfig({ BAREBUH_WRITES_ENABLED: "true" }), /writes are not implemented/u);
  assert.throws(() => loadConfig({ BAREBUH_NETWORK_PROBES_ENABLED: "true" }), /network probes are not implemented/u);
  // Federation is a mode, not a flag: the flag alone cannot promote the default read-only mode,
  // and the mode cannot run with federation switched off.
  assert.throws(() => loadConfig({ BAREBUH_FEDERATION_ENABLED: "true" }), /PRIVATE_PINNED_FEDERATION mode/u);
  assert.throws(() => loadConfig({ BAREBUH_MODE: "PRIVATE_PINNED_FEDERATION" }), /requires BAREBUH_FEDERATION_ENABLED=true/u);
  assert.throws(() => loadConfig({ BAREBUH_MODE: "PUBLIC_PILOT", BAREBUH_FEDERATION_ENABLED: "true" }), /modes are implemented/u);
  assert.throws(() => loadConfig({ BAREBUH_HOST: "0.0.0.0" }), /loopback/u);
  assert.throws(() => loadConfig({ BAREBUH_PUBLIC_BASE_URL: "http://registry.example/" }), /HTTPS/u);
  assert.throws(() => loadConfig({ BAREBUH_UNKNOWN_SETTING: "1" }), /unknown Barebuh setting/u);
});

test("the pinned-federation mode is loopback-only, keeps writes and probes disabled, and reports one pull worker", () => {
  const config = loadConfig({
    BAREBUH_FEDERATION_ENABLED: "true",
    BAREBUH_MODE: "PRIVATE_PINNED_FEDERATION",
    BAREBUH_NODE_ID: "oradio:node:ed25519:Wzz6buDMljkddWS2frYOsSzLipZaxrhDmo5Ix8G-PK8",
  });

  assert.deepEqual(config, {
    mode: "PRIVATE_PINNED_FEDERATION",
    databasePath: "var/registry.sqlite3",
    host: "127.0.0.1",
    port: 8787,
    publicBaseUrl: "https://registry.invalid/",
    nodeId: "oradio:node:ed25519:Wzz6buDMljkddWS2frYOsSzLipZaxrhDmo5Ix8G-PK8",
    writesEnabled: false,
    networkProbesEnabled: false,
    federationEnabled: true,
    peerWorkers: 1,
    stationCheckerWorkers: 0,
  });
  assert.throws(() => loadConfig({ BAREBUH_FEDERATION_ENABLED: "true", BAREBUH_MODE: "PRIVATE_PINNED_FEDERATION", BAREBUH_WRITES_ENABLED: "true" }), /writes are not implemented/u);
  assert.throws(() => loadConfig({ BAREBUH_FEDERATION_ENABLED: "true", BAREBUH_MODE: "PRIVATE_PINNED_FEDERATION", BAREBUH_HOST: "0.0.0.0" }), /loopback/u);
});
