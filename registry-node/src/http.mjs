// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { checkDatabase } from "./store/db.mjs";

export const ROUTES = Object.freeze([
  "GET /.well-known/open-radio-registry",
  "GET /health/live",
  "GET /health/ready",
]);

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function sendJson(request, response, status, value, cacheControl = "no-store") {
  const bytes = jsonBytes(value);
  const etag = `"${createHash("sha256").update(bytes).digest("hex")}"`;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", cacheControl);
  response.setHeader("etag", etag);
  response.setHeader("x-content-type-options", "nosniff");
  if (request.headers["if-none-match"] === etag && status === 200) {
    response.statusCode = 304;
    response.end();
    return;
  }
  response.statusCode = status;
  response.setHeader("content-length", bytes.length);
  response.end(bytes);
}

function sendError(request, response, status, code, message, allow) {
  if (allow) response.setHeader("allow", allow);
  sendJson(request, response, status, {
    error: { code, message },
    request_id: randomUUID(),
  });
}

function descriptor(publicBaseUrl) {
  const base = new URL("v1/", publicBaseUrl);
  return {
    protocol: "oradio/1",
    api_versions: [1],
    node: new URL("node", base).href,
    api_base: base.href,
    records: new URL("records", base).href,
    snapshot: new URL("snapshot", base).href,
    peers: new URL("peers", base).href,
  };
}

export function createRegistryServer({ config, db }) {
  return createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method !== "GET") {
      sendError(request, response, 405, "method_not_allowed", "This scaffold exposes no mutation routes.", "GET");
      return;
    }
    if (url.pathname === "/.well-known/open-radio-registry") {
      sendJson(request, response, 200, descriptor(config.publicBaseUrl), "public, max-age=300");
      return;
    }
    if (url.pathname === "/health/live") {
      sendJson(request, response, 200, { status: "live" });
      return;
    }
    if (url.pathname === "/health/ready") {
      try {
        const checks = checkDatabase(db);
        if (checks.schemaVersion !== 1) throw new Error("schema mismatch");
        sendJson(request, response, 200, { status: "ready", schema_version: checks.schemaVersion });
      } catch {
        sendJson(request, response, 503, { status: "not_ready", reason: "local_database" });
      }
      return;
    }
    sendError(request, response, 404, "not_found", "Route is not implemented by this scaffold.");
  });
}
