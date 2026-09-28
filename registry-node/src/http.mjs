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

// Request targets are bounded before parsing: discovery routes are short, so a hostile target
// must not cost unbounded work. Targets beyond Node's own header limit never reach the handler.
const MAX_REQUEST_TARGET_BYTES = 4096;
const PERCENT_ESCAPE = /%([0-9a-fA-F]{2})?/gu;

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

function hasMalformedPercentEscape(rawTarget) {
  for (const match of rawTarget.matchAll(PERCENT_ESCAPE)) {
    const hex = match[1];
    // A "%" that is not followed by two hex digits, or one that decodes to a control octet
    // (0x00-0x1f, 0x7f), is never a valid request target.
    if (hex === undefined) return true;
    const octet = Number.parseInt(hex, 16);
    if (octet < 0x20 || octet === 0x7f) return true;
  }
  return false;
}

// Accepts only the request-target forms an HTTP server may legitimately receive: origin-form,
// absolute-form with an HTTP scheme, and asterisk-form. Everything else - including the
// `GET http://[::1` repro of review t_bf762a64 (B1) - fails closed with a 400 instead of
// letting a parsing exception escape the request handler.
function parseRequestTarget(rawTarget) {
  if (typeof rawTarget !== "string" || rawTarget.length === 0) return null;
  if (Buffer.byteLength(rawTarget, "utf8") > MAX_REQUEST_TARGET_BYTES) return null;
  if (hasMalformedPercentEscape(rawTarget)) return null;
  let url;
  try {
    if (rawTarget === "*") {
      url = new URL("/", "http://localhost");
    } else if (rawTarget.startsWith("/")) {
      url = new URL(rawTarget, "http://localhost");
    } else {
      url = new URL(rawTarget);
    }
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url;
}

function handleRequest(request, response, { config, db }) {
  const url = parseRequestTarget(request.url);
  if (url === null) {
    sendError(request, response, 400, "bad_request", "Malformed request target.");
    return;
  }
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
}

export function createRegistryServer({ config, db }) {
  return createServer((request, response) => {
    // No exception may escape the request handler: an unexpected failure becomes a bounded
    // 500 and the process keeps serving subsequent requests.
    try {
      handleRequest(request, response, { config, db });
    } catch {
      try {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        sendError(request, response, 500, "internal_error", "Request could not be served.");
      } catch {
        response.destroy();
      }
    }
  });
}
