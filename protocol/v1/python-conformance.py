#!/usr/bin/env python3
# Copyright 2026 Barebuh contributors
# SPDX-License-Identifier: GPL-3.0-or-later

"""Independent Python verifier for the shared oradio/1 conformance corpus."""

import base64
import hashlib
import json
import math
import pathlib
import sys
from datetime import datetime, timezone
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from jsonschema import Draft202012Validator, RefResolver

ROOT = pathlib.Path(__file__).resolve().parent
LIMITS = json.loads((ROOT / "limits.json").read_text()) ["bounded_json"]


def pairs(pairs_value):
    result = {}
    for key, value in pairs_value:
        if key in result:
            raise ValueError("duplicate member name")
        result[key] = value
    return result


def parse_integer(value):
    number = int(value)
    if number < 0:
        raise ValueError("negative integer")
    if number > 2**53 - 1:
        raise ValueError("unsafe integer")
    return number


def strict_load(path):
    raw = path.read_bytes()
    if len(raw) > LIMITS["max_document_bytes"]:
        raise ValueError("document byte limit")
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_int=parse_integer,
                       parse_constant=lambda value: (_ for _ in ()).throw(ValueError("non-finite number")))

    def bounded(item, depth=1):
        if depth > LIMITS["max_depth"]:
            raise ValueError("depth limit")
        if isinstance(item, str):
            if len(item.encode()) > LIMITS["max_string_bytes"]:
                raise ValueError("string byte limit")
            if any(0xD800 <= ord(char) <= 0xDFFF for char in item):
                raise ValueError("Unicode scalar")
            if any(ord(char) <= 0x1F or 0x7F <= ord(char) <= 0x9F for char in item):
                raise ValueError("control character")
        elif isinstance(item, dict):
            if len(item) > LIMITS["max_object_members"]:
                raise ValueError("member limit")
            for key, child in item.items():
                bounded(key, depth + 1)
                bounded(child, depth + 1)
        elif isinstance(item, list):
            if len(item) > LIMITS["max_array_items"]:
                raise ValueError("array limit")
            for child in item:
                bounded(child, depth + 1)
        elif isinstance(item, float) and not math.isfinite(item):
            raise ValueError("non-finite number")
    bounded(value)
    return value


def b64url(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def canonical(value):
    # The fixture property names are ASCII; separators/UTF-8 produce the same RFC 8785 bytes.
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def instant(value):
    if not isinstance(value, str) or len(value) != 20 or not value.endswith("Z"):
        raise ValueError("invalid instant")
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def absolute_url(value, https=False):
    parts = urlsplit(value)
    if parts.scheme not in (("https",) if https else ("http", "https")) or not parts.hostname:
        raise ValueError("unsafe URL")
    if parts.username or parts.password or parts.fragment:
        raise ValueError("unsafe URL")


def validate_semantics(envelope, validation_time):
    payload = envelope["payload"]
    proof = envelope["proof"]
    if payload["protocol"] != "oradio/1" or proof["alg"] != "Ed25519" or proof["key_id"] != "root":
        raise ValueError("protocol or proof")
    kind = payload["kind"]
    root = payload["observer"]["root_key"] if kind == "observation" else payload["root_key"]
    public = b64url(root["x"])
    identity = base64.urlsafe_b64encode(hashlib.sha256(public).digest()).rstrip(b"=").decode()
    identity_field = payload["observer"]["node_id"] if kind == "observation" else payload[f"{kind}_id"]
    prefix = "node" if kind in ("node", "observation") else "station"
    if identity_field != f"oradio:{prefix}:ed25519:{identity}":
        raise ValueError("identity mismatch")
    if kind == "station":
        if payload["sequence"] == 0 and payload["parents"]:
            raise ValueError("genesis parents")
        station = payload["station"]
        if station.get("deleted") is True and set(station) != {"deleted"}:
            raise ValueError("tombstone shape")
        if station.get("deleted") is not True:
            for stream in station["streams"]:
                absolute_url(stream["url"])
    elif kind == "node":
        for value in payload["api_bases"]:
            absolute_url(value, https=True)
        if instant(payload["expires_at"]) <= instant(payload["issued_at"]):
            raise ValueError("node lifetime")
    else:
        endpoint = payload["endpoint"]
        if len(set(endpoint) & {"endpoint_index", "stream_url_digest"}) != 1:
            raise ValueError("endpoint scope")
        observed = instant(payload["observed_at"])
        expires = instant(payload["expires_at"])
        if not observed < expires or (expires - observed).total_seconds() > 3600:
            raise ValueError("observation lifetime")
        now = instant(validation_time)
        if (observed - now).total_seconds() > 300:
            raise ValueError("future skew")
    canonical_payload = canonical(payload)
    Ed25519PublicKey.from_public_bytes(public).verify(b64url(proof["signature"]), canonical_payload.encode())
    record_id = "sha256:" + base64.urlsafe_b64encode(hashlib.sha256(canonical_payload.encode()).digest()).rstrip(b"=").decode()
    return kind, canonical_payload, record_id


def schema_validator(kind):
    common = json.loads((ROOT / "schemas/common.schema.json").read_text())
    schema = json.loads((ROOT / f"schemas/{kind}-envelope.schema.json").read_text())
    Draft202012Validator.check_schema(common)
    Draft202012Validator.check_schema(schema)
    resolver = RefResolver.from_schema(schema, store={common["$id"]: common})
    return Draft202012Validator(schema, resolver=resolver)


def run():
    manifest = strict_load(ROOT / "fixtures/manifest.json")
    failures = []
    validators = {kind: schema_validator(kind) for kind in ("station", "node", "observation")}
    for fixture in manifest["fixtures"]:
        try:
            envelope = strict_load(ROOT / "fixtures" / fixture["file"])
            kind = envelope.get("payload", {}).get("kind")
            if kind in validators:
                validators[kind].validate(envelope)
            result_kind, canonical_payload, record_id = validate_semantics(envelope, manifest["validation_time"])
            if not fixture["valid"]:
                failures.append(f"{fixture['name']}: unexpectedly accepted")
            elif result_kind != fixture["kind"] or record_id != fixture["record_id"]:
                failures.append(f"{fixture['name']}: result mismatch")
            elif canonical_payload != (ROOT / "fixtures" / fixture["canonical_payload_file"]).read_text():
                failures.append(f"{fixture['name']}: canonical payload mismatch")
        except Exception as error:
            if fixture["valid"]:
                failures.append(f"{fixture['name']}: {error}")
    cases = strict_load(ROOT / "fixtures/interoperability-cases.json")
    records = {record["id"]: record for record in cases["dag"]["records"]}
    first = cases["dag"]["records"][:3]
    parents = {parent for record in first for parent in record["parents"]}
    tips = sorted(record["id"] for record in first if record["id"] not in parents)
    winner = sorted((records[item] for item in tips), key=lambda record: (-record["sequence"], record["id"]))[0]
    if tips != cases["dag"]["fork_tips_before_merge"] or winner["id"] != cases["dag"]["winner_before_merge"]:
        failures.append("interoperability DAG fork winner mismatch")
    if cases["pagination"]["conditional_status"] != 304 or cases["pagination"]["replacement_on_304"]:
        failures.append("conditional refresh contract mismatch")
    if any(item["endpoint_index"] >= cases["endpoint_scope"]["stream_count"] for item in cases["endpoint_scope"]["accepted"]):
        failures.append("endpoint scope mismatch")
    if not cases["offline_cache"]["failed_refresh_preserves_rows"] or not cases["offline_cache"]["offline"]:
        failures.append("offline cache contract mismatch")
    if failures:
        print("\n".join(f"FAIL {failure}" for failure in failures), file=sys.stderr)
        return 1
    print(f"{len(manifest['fixtures'])} signed fixtures and interoperability cases passed (independent Python + Draft 2020-12)")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
