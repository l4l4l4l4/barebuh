// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

const ALLOWED_ENVIRONMENT = new Set([
  "BAREBUH_DATABASE_PATH",
  "BAREBUH_FEDERATION_ENABLED",
  "BAREBUH_HOST",
  "BAREBUH_MODE",
  "BAREBUH_NETWORK_PROBES_ENABLED",
  "BAREBUH_PORT",
  "BAREBUH_PUBLIC_BASE_URL",
  "BAREBUH_WRITES_ENABLED",
]);

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
  if (mode !== "MVP_LOCAL_READ_ONLY") throw new Error("only MVP_LOCAL_READ_ONLY mode is implemented");

  const writesEnabled = parseBoolean(environment.BAREBUH_WRITES_ENABLED, "BAREBUH_WRITES_ENABLED");
  const networkProbesEnabled = parseBoolean(environment.BAREBUH_NETWORK_PROBES_ENABLED, "BAREBUH_NETWORK_PROBES_ENABLED");
  const federationEnabled = parseBoolean(environment.BAREBUH_FEDERATION_ENABLED, "BAREBUH_FEDERATION_ENABLED");
  if (writesEnabled) throw new Error("writes are not implemented and cannot be enabled");
  if (networkProbesEnabled) throw new Error("network probes are not implemented and cannot be enabled");
  if (federationEnabled) throw new Error("federation is not implemented and cannot be enabled");

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
    writesEnabled,
    networkProbesEnabled,
    federationEnabled,
    peerWorkers: 0,
    stationCheckerWorkers: 0,
  });
}
