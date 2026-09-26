#!/usr/bin/env node
// Copyright 2026 Barebuh contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseJsonStrict, validateEnvelope } from "./lib/conformance.mjs";

const protocolRoot = dirname(fileURLToPath(import.meta.url));

function fixturePath(root, path) {
  if (typeof path !== "string" || isAbsolute(path)) throw new TypeError("fixture path must be relative");
  const resolved = resolve(root, normalize(path));
  if (relative(root, resolved).startsWith("..")) throw new TypeError("fixture path escapes fixture directory");
  return resolved;
}

export function runManifest(manifestPath = join(protocolRoot, "fixtures", "manifest.json")) {
  const manifest = parseJsonStrict(readFileSync(manifestPath));
  if (manifest.protocol !== "oradio/1" || manifest.fixture_version !== 1 || !Array.isArray(manifest.fixtures)) {
    throw new TypeError("unsupported fixture manifest");
  }
  const fixturesRoot = dirname(manifestPath);
  const failures = [];

  for (const fixture of manifest.fixtures) {
    let stage = "parse";
    try {
      const envelope = parseJsonStrict(readFileSync(fixturePath(fixturesRoot, fixture.file)));
      stage = "validation";
      const result = validateEnvelope(envelope, { validationTime: manifest.validation_time });
      if (!fixture.valid) {
        failures.push(`${fixture.name}: unexpectedly accepted`);
        continue;
      }
      if (result.kind !== fixture.kind) failures.push(`${fixture.name}: kind ${result.kind} != ${fixture.kind}`);
      if (result.recordId !== fixture.record_id) failures.push(`${fixture.name}: record ID mismatch`);
      if (fixture.materializable !== undefined && result.materializable !== fixture.materializable) {
        failures.push(`${fixture.name}: materializable mismatch`);
      }
      if (fixture.unsupported_critical !== undefined &&
          JSON.stringify(result.unsupportedCritical) !== JSON.stringify(fixture.unsupported_critical)) {
        failures.push(`${fixture.name}: unsupported critical members mismatch`);
      }
      const expectedCanonical = readFileSync(fixturePath(fixturesRoot, fixture.canonical_payload_file), "utf8");
      if (result.canonicalPayload !== expectedCanonical) failures.push(`${fixture.name}: canonical payload mismatch`);
    } catch (error) {
      if (fixture.valid) {
        failures.push(`${fixture.name}: ${stage} failed: ${error.message}`);
      } else if (fixture.stage !== stage || !String(error.message).includes(fixture.message_contains)) {
        failures.push(`${fixture.name}: expected ${fixture.stage}/${JSON.stringify(fixture.message_contains)}, got ${stage}/${JSON.stringify(error.message)}`);
      }
    }
  }

  return { total: manifest.fixtures.length, failures };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifestPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
  try {
    const result = runManifest(manifestPath);
    if (result.failures.length > 0) {
      for (const failure of result.failures) console.error(`FAIL ${failure}`);
      console.error(`${result.failures.length}/${result.total} fixtures failed`);
      process.exitCode = 1;
    } else {
      console.log(`${result.total} fixtures passed`);
    }
  } catch (error) {
    console.error(`FAIL runner: ${error.message}`);
    process.exitCode = 1;
  }
}
