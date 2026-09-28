// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// HTTP surface of the private registry node.
//
// This module owns exactly four things (docs/adr/0002-private-registry-node.md): request-target and
// method handling, query extraction, cache validators (strong ETag with If-None-Match/304), and
// bounded error envelopes. It contains no SQL and no cryptography beyond hashing response bytes;
// every response body comes from the read model in ./store/views.mjs.
//
// Route inventory (AUTH-01): read-only GET/HEAD resources plus the *refused* submission boundary.
// `POST /v1/records` exists so the boundary is explicit and testable, and it refuses before a
// single body byte is read; no configuration, header, or document can enable it in this release.

import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { checkDatabase, LATEST_SCHEMA_VERSION } from "./store/db.mjs";
import { healthResource, nodeCardResource, parseSearchQuery, ReadRequestError, searchPage, stationIdFromKey, stationResource } from "./store/views.mjs";

export const ROUTES = Object.freeze([
  "GET /.well-known/open-radio-registry",
  "GET /health/live",
  "GET /health/ready",
  "GET /v1/node",
  "GET /v1/search",
  "GET /v1/stations/{station-key-digest}",
  "GET /v1/health/{station-key-digest}",
  "POST /v1/records", // refused: the disabled-by-default submission boundary
]);

// Request targets are bounded before parsing: discovery routes are short, so a hostile target
// must not cost unbounded work. Targets beyond Node's own header limit never reach the handler.
const MAX_REQUEST_TARGET_BYTES = 4096;
const PERCENT_ESCAPE = /%([0-9a-fA-F]{2})?/gu;

const WELL_KNOWN_PATH = "/.well-known/open-radio-registry";
const READINESS_PATH = "/health/ready";
const LIVENESS_PATH = "/health/live";
const NODE_CARD_PATH = "/v1/node";
const SEARCH_PATH = "/v1/search";
const SUBMISSION_PATH = "/v1/records";
const STATIONS_PREFIX = "/v1/stations/";
const HEALTH_PREFIX = "/v1/health/";

// Cache policy: the descriptor and the node card are public and bounded by their own lifetimes;
// station and health views are revalidated against a one-minute window; search responses are
// query-specific and never stored by shared caches (clients keep their own last-known-good rows
// and ETags).
const DESCRIPTOR_CACHE_CONTROL = "public, max-age=300";
const STATION_CACHE_CONTROL = "public, max-age=60";
const SEARCH_CACHE_CONTROL = "no-store";
const NODE_CARD_MAX_AGE_SECONDS = 300;

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function etagOf(bytes) {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

// RFC 9110 If-None-Match: a comma-separated list, `*` matching any current representation, and
// weak comparison for the `W/` prefix. Only a 200 is turned into a 304.
function ifNoneMatchSatisfied(header, etag) {
  if (typeof header !== "string") return false;
  for (const candidate of header.split(",")) {
    const value = candidate.trim();
    if (value === "*" || value === etag) return true;
    if (value.startsWith("W/") && value.slice(2) === etag) return true;
  }
  return false;
}

function sendRepresentation(request, response, status, bytes, { cacheControl = "no-store", allow = null, close = false } = {}) {
  const etag = etagOf(bytes);
  if (allow !== null) response.setHeader("allow", allow);
  if (close) response.setHeader("connection", "close");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", cacheControl);
  response.setHeader("etag", etag);
  response.setHeader("x-content-type-options", "nosniff");
  if (status === 200 && ifNoneMatchSatisfied(request.headers["if-none-match"], etag)) {
    response.statusCode = 304;
    response.end();
    return;
  }
  response.statusCode = status;
  response.setHeader("content-length", bytes.length);
  response.end(bytes);
}

function sendJson(request, response, status, value, options) {
  sendRepresentation(request, response, status, jsonBytes(value), options);
}

// The shared error envelope: a stable machine-readable code, a display-safe message, optional
// bounded details, and a request ID. No upstream data, secrets, or stack traces.
function sendError(request, response, status, { code, message, details = null, allow = null, close = false }) {
  sendJson(request, response, status, {
    error: { code, message, ...(details === null ? {} : { details }) },
    request_id: randomUUID(),
  }, { cacheControl: "no-store", allow, close });
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

function routeOf(pathname) {
  if (pathname === WELL_KNOWN_PATH) return "descriptor";
  if (pathname === LIVENESS_PATH) return "liveness";
  if (pathname === READINESS_PATH) return "readiness";
  if (pathname === NODE_CARD_PATH) return "node-card";
  if (pathname === SEARCH_PATH) return "search";
  if (pathname === SUBMISSION_PATH) return "submission";
  if (pathname.startsWith(STATIONS_PREFIX) && !pathname.slice(STATIONS_PREFIX.length).includes("/")) return "station";
  if (pathname.startsWith(HEALTH_PREFIX) && !pathname.slice(HEALTH_PREFIX.length).includes("/")) return "health";
  return null;
}

// The submission boundary (docs/registry-node-security-contract.md AUTH-01/AUTH-02). Submissions
// are disabled by default, cannot be enabled by an environment variable, header, or document in
// this release, and this refusal happens before any body byte is read; the connection is closed
// afterwards so an unread body cannot be kept alive. The distinct code is deliberate: a future
// authenticated submission mode must replace this function, so a refusal can never silently
// become an acceptance.
function refuseSubmission(request, response) {
  sendError(request, response, 403, { code: "submission_disabled", message: "This node does not accept record submissions.", close: true });
}

function handleRead(request, response, { config, db, pathname, url, nowIso, route }) {
  if (route === "descriptor") {
    sendJson(request, response, 200, descriptor(config.publicBaseUrl), { cacheControl: DESCRIPTOR_CACHE_CONTROL });
    return;
  }
  if (route === "liveness") {
    sendJson(request, response, 200, { status: "live" });
    return;
  }
  if (route === "readiness") {
    try {
      const checks = checkDatabase(db);
      if (checks.schemaVersion !== LATEST_SCHEMA_VERSION) throw new Error("schema mismatch");
      sendJson(request, response, 200, { status: "ready", schema_version: checks.schemaVersion });
    } catch {
      sendJson(request, response, 503, { status: "not_ready", reason: "local_database" });
    }
    return;
  }
  if (route === "node-card") {
    const card = nodeCardResource(db, config.nodeId, { nowIso });
    if (card.kind === "unavailable") {
      sendError(request, response, 503, { code: "node_card_unavailable", message: "This node has no admitted signing card to serve." });
      return;
    }
    if (card.kind === "expired") {
      sendError(request, response, 503, { code: "node_card_expired", message: "The node signing card has expired and is not served." });
      return;
    }
    const secondsLeft = Math.floor((Date.parse(card.expiresAt) - Date.parse(nowIso)) / 1000);
    sendRepresentation(request, response, 200, card.bytes, { cacheControl: `public, max-age=${Math.max(0, Math.min(NODE_CARD_MAX_AGE_SECONDS, secondsLeft))}` });
    return;
  }
  if (route === "search") {
    const { filter, limit, cursor } = parseSearchQuery(url.searchParams);
    sendJson(request, response, 200, searchPage(db, { filter, limit, cursor, observerId: config.nodeId, nowIso }), { cacheControl: SEARCH_CACHE_CONTROL });
    return;
  }
  if (route === "station") {
    const stationId = stationIdFromKey(pathname.slice(STATIONS_PREFIX.length));
    sendJson(request, response, 200, stationResource(db, stationId, { observerId: config.nodeId, nowIso }), { cacheControl: STATION_CACHE_CONTROL });
    return;
  }
  if (route === "health") {
    const stationId = stationIdFromKey(pathname.slice(HEALTH_PREFIX.length));
    sendJson(request, response, 200, healthResource(db, stationId, { observerId: config.nodeId, nowIso }), { cacheControl: STATION_CACHE_CONTROL });
    return;
  }
  // The record feed itself is not implemented on this node; only its submission boundary exists.
  sendError(request, response, 404, { code: "not_found", message: "This node does not serve a record feed." });
}

function handleRequest(request, response, { config, db, clock }) {
  const url = parseRequestTarget(request.url);
  if (url === null) {
    sendError(request, response, 400, { code: "bad_request", message: "Malformed request target." });
    return;
  }
  const method = request.method ?? "GET";
  const isRead = method === "GET" || method === "HEAD";
  const pathname = url.pathname;
  const route = routeOf(pathname);

  if (route === null) {
    sendError(request, response, 404, { code: "not_found", message: "Route is not implemented by this node." });
    return;
  }
  if (route === "submission" && method === "POST") {
    refuseSubmission(request, response);
    return;
  }
  if (!isRead) {
    sendError(request, response, 405, { code: "method_not_allowed", message: "This node exposes no mutation routes.", allow: route === "submission" ? "GET, HEAD, POST" : "GET, HEAD" });
    return;
  }
  try {
    handleRead(request, response, { config, db, pathname, url, nowIso: clock(), route });
  } catch (error) {
    if (error instanceof ReadRequestError) {
      sendError(request, response, error.status, { code: error.code, message: error.message, details: error.details });
      return;
    }
    throw error;
  }
}

export function createRegistryServer({ config, db, clock = () => new Date().toISOString() }) {
  return createServer((request, response) => {
    // No exception may escape the request handler: an unexpected failure becomes a bounded
    // 500 and the process keeps serving subsequent requests.
    try {
      handleRequest(request, response, { config, db, clock });
    } catch {
      try {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        sendError(request, response, 500, { code: "internal_error", message: "Request could not be served." });
      } catch {
        response.destroy();
      }
    }
  });
}
