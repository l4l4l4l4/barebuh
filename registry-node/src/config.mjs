// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

const ALLOWED_ENVIRONMENT = new Set([
  "BAREBUH_DATABASE_PATH",
  "BAREBUH_FEDERATION_ENABLED",
  "BAREBUH_HOST",
  "BAREBUH_MODE",
  "BAREBUH_NETWORK_PROBES_ENABLED",
  "BAREBUH_NODE_ID",
  "BAREBUH_PORT",
  "BAREBUH_PUBLIC_BASE_URL",
  "BAREBUH_WRITES_ENABLED",
]);

// The node identity is public data, not key material: this process serves a card that was signed
// elsewhere, and it holds no signing key (docs/registry-node-security-contract.md KEY-01).
const NODE_ID_PATTERN = /^oradio:node:ed25519:([A-Za-z0-9_-]{43})$/u;

function parseBoolean(value, name) {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be true or false`);
}

function parsePort(value) {
  const port = Number(value ?? "8787");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("BAREBUH_PORT must be an integer from 0 through 65535");
  return port;
}

// An empty value means "no node identity configured", which is the default: /v1/node then fails
// closed with `node_card_unavailable` instead of serving somebody else's card.
function parseNodeId(value) {
  if (value === undefined || value === "") return null;
  const match = NODE_ID_PATTERN.exec(value);
  if (!match || Buffer.from(match[1], "base64url").toString("base64url") !== match[1]) {
    throw new Error("BAREBUH_NODE_ID must be a node identity (oradio:node:ed25519:<digest>)");
  }
  return value;
}

export function assertSupportedRuntime(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  if (major !== 24 || minor < 15) throw new Error(`Node.js >=24.15 <25 is required; found ${version}`);
}

export function loadConfig(environment = process.env) {
  assertSupportedRuntime();
  for (const name of Object.keys(environment)) {
    if (name.startsWith("BAREBUH_") && !ALLOWED_ENVIRONMENT.has(name)) throw new Error(`unknown Barebuh setting: ${name}`);
  }

  const mode = environment.BAREBUH_MODE ?? "MVP_LOCAL_READ_ONLY";
  if (mode !== "MVP_LOCAL_READ_ONLY" && mode !== "PRIVATE_PINNED_FEDERATION") {
    throw new Error("only MVP_LOCAL_READ_ONLY and PRIVATE_PINNED_FEDERATION modes are implemented");
  }

  const writesEnabled = parseBoolean(environment.BAREBUH_WRITES_ENABLED, "BAREBUH_WRITES_ENABLED");
  const networkProbesEnabled = parseBoolean(environment.BAREBUH_NETWORK_PROBES_ENABLED, "BAREBUH_NETWORK_PROBES_ENABLED");
  const federationEnabled = parseBoolean(environment.BAREBUH_FEDERATION_ENABLED, "BAREBUH_FEDERATION_ENABLED");
  if (writesEnabled) throw new Error("writes are not implemented and cannot be enabled");
  if (networkProbesEnabled) throw new Error("network probes are not implemented and cannot be enabled");
  // Federation is never promoted by a flag alone: the pull replicator, the records feed, and the
  // snapshot view exist only as the pinned-federation mode, and that mode is inert without an
  // explicit operator pin (docs/registry-node-security-contract.md, mode 3).
  if (federationEnabled && mode !== "PRIVATE_PINNED_FEDERATION") {
    throw new Error("federation requires the PRIVATE_PINNED_FEDERATION mode");
  }
  if (mode === "PRIVATE_PINNED_FEDERATION" && !federationEnabled) {
    throw new Error("PRIVATE_PINNED_FEDERATION requires BAREBUH_FEDERATION_ENABLED=true");
  }

  const host = environment.BAREBUH_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") throw new Error("MVP listener must use a loopback host");

  const publicBaseUrl = new URL(environment.BAREBUH_PUBLIC_BASE_URL ?? "https://registry.invalid/");
  if (publicBaseUrl.protocol !== "https:") throw new Error("BAREBUH_PUBLIC_BASE_URL must use HTTPS");
  if (publicBaseUrl.username || publicBaseUrl.password || publicBaseUrl.search || publicBaseUrl.hash) {
    throw new Error("BAREBUH_PUBLIC_BASE_URL must not contain credentials, query, or fragment");
  }
  if (!publicBaseUrl.pathname.endsWith("/")) publicBaseUrl.pathname += "/";

  return Object.freeze({
    mode,
    databasePath: environment.BAREBUH_DATABASE_PATH ?? "var/registry.sqlite3",
    host,
    port: parsePort(environment.BAREBUH_PORT),
    publicBaseUrl: publicBaseUrl.href,
    nodeId: parseNodeId(environment.BAREBUH_NODE_ID),
    writesEnabled,
    networkProbesEnabled,
    federationEnabled,
    // The pull replicator is one synchronous, strictly sequential worker: peers are a bulkhead and
    // never run concurrently (`replicate` in cli.mjs). There are no background threads and no
    // station checker in either mode.
    peerWorkers: federationEnabled ? 1 : 0,
    stationCheckerWorkers: 0,
  });
}
