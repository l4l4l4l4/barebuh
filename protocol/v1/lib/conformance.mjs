// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash, createPublicKey, verify } from "node:crypto";

function compareUtf16(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; ++index) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function assertUnicodeScalarString(value) {
  for (let index = 0; index < value.length; ++index) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("lone high surrogate is not I-JSON");
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError("lone low surrogate is not I-JSON");
    }
  }
}

export function canonicalize(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number is not I-JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort(compareUtf16).map(key => {
      assertUnicodeScalarString(key);
      const member = value[key];
      if (member === undefined || typeof member === "function" || typeof member === "symbol" || typeof member === "bigint") {
        throw new TypeError("value cannot be represented as canonical JSON");
      }
      return `${JSON.stringify(key)}:${canonicalize(member)}`;
    }).join(",")}}`;
  }
  throw new TypeError("value cannot be represented as canonical JSON");
}

export const BOUNDED_JSON_LIMITS = Object.freeze({
  max_document_bytes: 65536,
  max_depth: 16,
  max_object_members: 64,
  max_array_items: 64,
  max_string_bytes: 4096,
});

// Station tags are pinned to the desktop client's parser bounds
// (src/radios/barebuhsearchparser.cpp: at most 32 tags, each at most 64 UTF-8 bytes). The client
// refuses the whole page when a single tag breaks a bound, so a node must never admit a tag it
// cannot serve, and the bound counts bytes, not characters (which a JSON Schema maxLength can only
// approximate).
export const STATION_TAG_MAX_ITEMS = 32;
export const STATION_TAG_MAX_BYTES = 64;

export function parseJsonStrict(input, limits = BOUNDED_JSON_LIMITS) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  if (bytes.length > limits.max_document_bytes) throw new SyntaxError("JSON document exceeds byte limit");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let cursor = 0;

  const fail = message => { throw new SyntaxError(`${message} at byte ${Buffer.byteLength(text.slice(0, cursor), "utf8")}`); };
  const whitespace = () => { while (cursor < text.length && /[\x20\x09\x0a\x0d]/u.test(text[cursor])) ++cursor; };
  const parseString = () => {
    if (text[cursor] !== '"') fail("expected string");
    const start = cursor++;
    let escaped = false;
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (!escaped && code === 0x22) {
        ++cursor;
        const value = JSON.parse(text.slice(start, cursor));
        try { assertUnicodeScalarString(value); } catch { fail("string must contain Unicode scalar values"); }
        if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) fail("string must not contain a C0 or C1 control");
        if (Buffer.byteLength(value, "utf8") > limits.max_string_bytes) fail("string exceeds byte limit");
        return value;
      }
      if (!escaped && code < 0x20) fail("unescaped control in string");
      if (!escaped && code === 0x5c) escaped = true;
      else escaped = false;
      ++cursor;
    }
    fail("unterminated string");
  };
  const parseNumber = () => {
    const match = text.slice(cursor).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (!match) fail("invalid number");
    cursor += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail("number must be finite");
    if (Number.isInteger(value)) {
      if (value < 0) fail("integer must be a non-negative integer");
      if (!Number.isSafeInteger(value)) fail("integer must be a safe integer");
    }
    return value;
  };
  const parseValue = depth => {
    if (depth > limits.max_depth) fail("JSON nesting exceeds depth limit");
    whitespace();
    if (text[cursor] === '"') return parseString();
    if (text[cursor] === "{") {
      ++cursor;
      whitespace();
      const object = {};
      const names = new Set();
      if (text[cursor] === "}") { ++cursor; return object; }
      for (let members = 0; ; ++members) {
        if (members >= limits.max_object_members) fail("object exceeds member limit");
        const name = parseString();
        if (names.has(name)) fail(`duplicate member name ${JSON.stringify(name)}`);
        names.add(name);
        whitespace();
        if (text[cursor++] !== ":") fail("expected colon");
        Object.defineProperty(object, name, {
          value: parseValue(depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
        whitespace();
        const delimiter = text[cursor++];
        if (delimiter === "}") return object;
        if (delimiter !== ",") fail("expected comma or closing brace");
        whitespace();
      }
    }
    if (text[cursor] === "[") {
      ++cursor;
      whitespace();
      const array = [];
      if (text[cursor] === "]") { ++cursor; return array; }
      for (;;) {
        if (array.length >= limits.max_array_items) fail("array exceeds item limit");
        array.push(parseValue(depth + 1));
        whitespace();
        const delimiter = text[cursor++];
        if (delimiter === "]") return array;
        if (delimiter !== ",") fail("expected comma or closing bracket");
      }
    }
    for (const [token, value] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(token, cursor)) { cursor += token.length; return value; }
    }
    return parseNumber();
  };

  const value = parseValue(1);
  whitespace();
  if (cursor !== text.length) fail("trailing data");
  return value;
}

function decodeBase64Url(value, expectedBytes, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError(`${field} must be unpadded base64url`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== expectedBytes || decoded.toString("base64url") !== value) throw new TypeError(`${field} has invalid length or encoding`);
  return decoded;
}

function sha256Base64Url(bytes) {
  return createHash("sha256").update(bytes).digest("base64url");
}

function validateRootKey(rootKey) {
  if (!rootKey || rootKey.kty !== "OKP" || rootKey.crv !== "Ed25519") throw new TypeError("root_key must be an Ed25519 OKP key");
  return decodeBase64Url(rootKey.x, 32, "root_key.x");
}

function verifyEd25519(publicKey, signature, message) {
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const key = createPublicKey({ key: Buffer.concat([spkiPrefix, publicKey]), format: "der", type: "spki" });
  return verify(null, Buffer.from(message, "utf8"), key, signature);
}

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

function requireString(value, field, maximum = 4096) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maximum) {
    throw new TypeError(`${field} must be a non-empty bounded string`);
  }
  return value;
}

function requireStringArray(value, field, maximumItems = 32, maximumItemBytes = 256) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumItems) throw new TypeError(`${field} must be a non-empty bounded array`);
  const strings = value.map((item, index) => requireString(item, `${field}[${index}]`, maximumItemBytes));
  if (new Set(strings).size !== strings.length) throw new TypeError(`${field} must not contain duplicates`);
  return strings;
}

function requireIntegerRange(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${field} is out of range`);
  return value;
}

function parseInstant(value, field) {
  requireString(value, field, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)) throw new TypeError(`${field} must be an RFC 3339 UTC second instant`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value.replace("Z", ".000Z")) {
    throw new TypeError(`${field} must be a valid RFC 3339 UTC instant`);
  }
  return milliseconds;
}

function parseAbsoluteUrl(value, field, schemes, httpsOnly = false) {
  requireString(value, field, 2048);
  let url;
  try { url = new URL(value); } catch { throw new TypeError(`${field} must be an absolute URL`); }
  if (!schemes.includes(url.protocol)) throw new TypeError(`${field} must use ${httpsOnly ? "HTTPS" : schemes.join(" or ")}`);
  if (httpsOnly && url.protocol !== "https:") throw new TypeError(`${field} must use HTTPS`);
  if (url.username || url.password) throw new TypeError(`${field} must not contain userinfo`);
  if (url.hash) throw new TypeError(`${field} must not contain a fragment`);
  if (!url.hostname || /[\\\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${field} contains an unsafe authority`);
  return url;
}

function validateStationPayload(payload) {
  if (!Number.isSafeInteger(payload.sequence) || payload.sequence < 0) throw new TypeError("sequence must be a non-negative safe integer");
  if (!Array.isArray(payload.parents) || payload.parents.length > 8) throw new TypeError("parents must be a bounded array");
  for (const parent of payload.parents) {
    if (typeof parent !== "string" || !/^sha256:[A-Za-z0-9_-]{43}$/u.test(parent)) throw new TypeError("parent must be a SHA-256 record ID");
  }
  if (new Set(payload.parents).size !== payload.parents.length) throw new TypeError("parents must not contain duplicates");
  if (payload.sequence === 0 && payload.parents.length !== 0) throw new TypeError("genesis record must have no parents");
  if (payload.sequence > 0 && payload.parents.length === 0) throw new TypeError("update record must name at least one parent");
  parseInstant(payload.issued_at, "issued_at");
  const station = requireObject(payload.station, "station");
  if (station.deleted === true) {
    if (Object.keys(station).some(key => key !== "deleted")) throw new TypeError("tombstone station must contain only deleted=true");
    return;
  }
  if (station.deleted !== undefined) throw new TypeError("station.deleted is reserved for tombstones");
  requireString(station.name, "station.name", 200);
  if (station.short_name !== undefined) requireString(station.short_name, "station.short_name", 32);
  if (!Array.isArray(station.streams) || station.streams.length === 0 || station.streams.length > 16) {
    throw new TypeError("station.streams must be a non-empty bounded array");
  }
  for (const [index, stream] of station.streams.entries()) {
    requireObject(stream, `station.streams[${index}]`);
    const url = parseAbsoluteUrl(stream.url, `station.streams[${index}].url`, ["http:", "https:"]);
    if (stream.transport !== url.protocol.slice(0, -1)) throw new TypeError("stream transport must match its URL scheme");
    requireString(stream.container, `station.streams[${index}].container`, 127);
    requireString(stream.codec, `station.streams[${index}].codec`, 64);
    if (stream.bitrate_kbps !== undefined) requireIntegerRange(stream.bitrate_kbps, "stream bitrate_kbps", 1, 100000);
  }
  if (station.homepage !== undefined) parseAbsoluteUrl(station.homepage, "station.homepage", ["http:", "https:"]);
  if (station.country !== undefined && !/^[A-Z]{2}$/u.test(station.country)) throw new TypeError("station.country must be ISO 3166-1 alpha-2");
  if (station.languages !== undefined) {
    for (const language of requireStringArray(station.languages, "station.languages", 16)) {
      if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(language)) throw new TypeError("station language must be a BCP 47 tag");
    }
  }
  if (station.tags !== undefined) requireStringArray(station.tags, "station.tags", STATION_TAG_MAX_ITEMS, STATION_TAG_MAX_BYTES);
}

function validateNodePayload(payload) {
  parseAbsoluteUrl(payload.operator_url, "operator_url", ["https:"], true);
  for (const [index, apiBase] of requireStringArray(payload.api_bases, "api_bases", 8).entries()) {
    parseAbsoluteUrl(apiBase, `api_bases[${index}]`, ["https:"], true);
  }
  if (!Array.isArray(payload.supported_majors) || payload.supported_majors.length === 0 || payload.supported_majors.length > 8 ||
      payload.supported_majors.some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new TypeError("supported_majors must contain at most eight positive integers");
  }
  if (new Set(payload.supported_majors).size !== payload.supported_majors.length) throw new TypeError("supported_majors must not contain duplicates");
  requireStringArray(payload.capabilities, "capabilities", 32);
  const issuedAt = parseInstant(payload.issued_at, "issued_at");
  const expiresAt = parseInstant(payload.expires_at, "expires_at");
  if (expiresAt <= issuedAt) throw new TypeError("expires_at must be later than issued_at");
}

function validateObservationPayload(payload) {
  const endpoint = requireObject(payload.endpoint, "endpoint");
  const endpointFields = ["endpoint_index", "stream_url_digest"].filter(field => endpoint[field] !== undefined);
  if (endpointFields.length !== 1) throw new TypeError("endpoint must contain exactly one endpoint reference");
  if (endpoint.endpoint_index !== undefined && (!Number.isSafeInteger(endpoint.endpoint_index) || endpoint.endpoint_index < 0)) {
    throw new TypeError("endpoint_index must be a non-negative safe integer");
  }
  if (endpoint.stream_url_digest !== undefined && !/^sha256:[A-Za-z0-9_-]{43}$/u.test(endpoint.stream_url_digest)) {
    throw new TypeError("stream_url_digest must be a SHA-256 digest");
  }
  const observedAt = parseInstant(payload.observed_at, "observed_at");
  const expiresAt = parseInstant(payload.expires_at, "expires_at");
  if (expiresAt <= observedAt) throw new TypeError("expires_at must be later than observed_at");
  if (expiresAt - observedAt > 60 * 60 * 1000) throw new TypeError("observation lifetime must not exceed one hour");
  const outcomes = new Set(["ok", "timeout", "dns_error", "tls_error", "http_error", "invalid_audio", "blocked"]);
  if (!outcomes.has(payload.outcome)) throw new TypeError("unsupported observation outcome");
  if (payload.latency_ms !== undefined) requireIntegerRange(payload.latency_ms, "latency_ms", 0, 3600000);
  if (payload.http_status !== undefined) requireIntegerRange(payload.http_status, "http_status", 100, 599);
  if (payload.final_url !== undefined) parseAbsoluteUrl(payload.final_url, "final_url", ["http:", "https:"]);
  if (payload.content_type !== undefined) requireString(payload.content_type, "content_type", 127);
  if (payload.codec !== undefined) requireString(payload.codec, "codec", 64);
  if (payload.bitrate_kbps !== undefined) requireIntegerRange(payload.bitrate_kbps, "bitrate_kbps", 1, 100000);
  if (payload.diagnostic_code !== undefined) requireString(payload.diagnostic_code, "diagnostic_code", 64);
}

function unsupportedCriticalMembers(payload, supportedCritical) {
  if (payload.critical === undefined) return [];
  const names = requireStringArray(payload.critical, "critical", 16);
  for (const name of names) {
    if (!Object.hasOwn(payload, name)) throw new TypeError(`critical member ${JSON.stringify(name)} is not present`);
  }
  const supported = new Set(supportedCritical);
  return names.filter(name => !supported.has(name));
}

function validateFreshness(payload, validationTime) {
  if (validationTime === undefined || payload.kind === "station") return;
  const now = parseInstant(validationTime, "validationTime");
  const sourceField = payload.kind === "observation" ? "observed_at" : "issued_at";
  const sourceTime = parseInstant(payload[sourceField], sourceField);
  const expiresAt = parseInstant(payload.expires_at, "expires_at");
  if (sourceTime > now + 300 * 1000) throw new TypeError(`${sourceField} exceeds allowed future clock skew`);
  if (expiresAt <= now) throw new TypeError(`${payload.kind} envelope is expired`);
}

export function validateEnvelope(envelope, { supportedCritical = [], validationTime } = {}) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new TypeError("envelope must be an object");
  const { payload, proof } = envelope;
  if (!payload || payload.protocol !== "oradio/1") throw new TypeError("unsupported protocol");
  if (!["station", "node", "observation"].includes(payload.kind)) throw new TypeError("unsupported payload kind");
  if (!proof || proof.alg !== "Ed25519" || proof.key_id !== "root") throw new TypeError("proof must use the root Ed25519 key");
  let publicKey;
  if (payload.kind === "station") {
    publicKey = validateRootKey(payload.root_key);
    const expectedId = `oradio:station:ed25519:${sha256Base64Url(publicKey)}`;
    if (payload.station_id !== expectedId) throw new TypeError("station_id does not match root_key");
    validateStationPayload(payload);
  } else if (payload.kind === "node") {
    publicKey = validateRootKey(payload.root_key);
    const expectedId = `oradio:node:ed25519:${sha256Base64Url(publicKey)}`;
    if (payload.node_id !== expectedId) throw new TypeError("node_id does not match root_key");
    validateNodePayload(payload);
  } else {
    const observer = requireObject(payload.observer, "observer");
    publicKey = validateRootKey(observer.root_key);
    const expectedId = `oradio:node:ed25519:${sha256Base64Url(publicKey)}`;
    if (observer.node_id !== expectedId) throw new TypeError("observer.node_id does not match observer.root_key");
    if (typeof payload.station_id !== "string" || !/^oradio:station:ed25519:[A-Za-z0-9_-]{43}$/u.test(payload.station_id)) {
      throw new TypeError("station_id must be a station identity");
    }
    validateObservationPayload(payload);
  }
  const canonicalPayload = canonicalize(payload);
  const signature = decodeBase64Url(proof.signature, 64, "proof.signature");
  if (!verifyEd25519(publicKey, signature, canonicalPayload)) throw new TypeError("invalid Ed25519 signature");
  validateFreshness(payload, validationTime);
  const unsupportedCritical = unsupportedCriticalMembers(payload, supportedCritical);
  return {
    kind: payload.kind,
    canonicalPayload,
    recordId: `sha256:${sha256Base64Url(Buffer.from(canonicalPayload, "utf8"))}`,
    materializable: unsupportedCritical.length === 0,
    unsupportedCritical,
  };
}
