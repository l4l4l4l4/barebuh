#!/usr/bin/env python3
# Copyright 2026 Barebuh contributors
# SPDX-License-Identifier: GPL-3.0-or-later

"""Independent Python verifier for the shared oradio/1 conformance corpus."""

import base64
import copy
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


def execute_interoperability(cases):
    failures = []
    definitions = {record["id"]: record for record in cases["dag"]["records"]}
    records = {}
    orphans = {}

    def receive(record_id):
        if record_id in records or record_id in orphans:
            return
        record = definitions[record_id]
        target = orphans if any(parent not in records for parent in record["parents"]) else records
        target[record_id] = record
        promoted = True
        while promoted:
            promoted = False
            for orphan_id, orphan in list(orphans.items()):
                if all(parent in records for parent in orphan["parents"]):
                    records[orphan_id] = orphans.pop(orphan_id)
                    promoted = True

    def record_tips(values):
        parents = {parent for record in values.values() for parent in record["parents"]}
        return sorted((record for record_id, record in values.items() if record_id not in parents), key=lambda record: record["id"])

    def record_winner(values):
        return sorted(record_tips(values), key=lambda record: (-record["sequence"], record["id"]))[0]

    arrival = cases["dag"]["arrival_order"]
    receive(arrival[0])
    if sorted(orphans) != cases["dag"]["expected"]["orphan_after_first"]:
        failures.append("orphan acceptance mismatch")
    for record_id in arrival[1:3]:
        receive(record_id)
    if [record["id"] for record in record_tips(records)] != cases["dag"]["expected"]["fork_tips"] or record_winner(records)["id"] != cases["dag"]["expected"]["fork_winner"]:
        failures.append("fork convergence mismatch")
    receive("M")
    if record_winner(records)["id"] != cases["dag"]["expected"]["merge_winner"]:
        failures.append("merge mismatch")
    for record_id in arrival[4:]:
        receive(record_id)
    winner = record_winner(records)
    if ([record["id"] for record in record_tips(records)] != cases["dag"]["expected"]["final_tips"] or
            winner["id"] != cases["dag"]["expected"]["final_winner"] or not winner["deleted"] or
            sorted(records) != cases["dag"]["expected"]["stored"]):
        failures.append("tombstone non-resurrection mismatch")

    replay = cases["replication"]["crash_replay"]
    committed = {"cursor": replay["initial_cursor"], "records": set()}

    def apply_page(target, crash_after=None):
        transaction = {"cursor": target["cursor"], "records": set(target["records"])}
        for index, item in enumerate(replay["page"]["items"]):
            transaction["records"].add(item)
            if index == crash_after:
                raise RuntimeError("injected crash")
        transaction["cursor"] = replay["page"]["next_cursor"]
        return transaction

    try:
        apply_page(committed, replay["crash_after_item"])
        failures.append("crash was not injected")
    except RuntimeError:
        pass
    if committed["cursor"] != replay["expected_cursor_after_crash"] or sorted(committed["records"]) != replay["expected_records_after_crash"]:
        failures.append("crash page escaped transaction")
    replayed = apply_page(committed)
    if replayed["cursor"] != replay["expected_cursor_after_replay"] or sorted(replayed["records"]) != replay["expected_records_after_replay"]:
        failures.append("page replay mismatch")

    logs = {node: set() for node in ("A", "B", "C")}
    for delivery in cases["replication"]["loop_deliveries"]:
        logs[delivery["to"]].update(delivery["items"])
    for node, expected in cases["replication"]["expected_loop_logs"].items():
        if sorted(logs[node]) != expected:
            failures.append(f"loop deduplication mismatch for {node}")

    recovery = cases["replication"]["snapshot_recovery"]
    snapshot = set()
    snapshot_id = recovery["snapshot_pages"][0]["snapshot"]
    checkpoint = None
    for page in recovery["snapshot_pages"]:
        if page["snapshot"] != snapshot_id:
            failures.append("snapshot changed between pages")
        snapshot.update(page["items"])
        if not page["has_more"]:
            checkpoint = page["checkpoint"]
    recovered = set(recovery["local_records"]) | snapshot
    recovered_records = {record_id: definitions[record_id] for record_id in recovered}
    if sorted(recovered) != recovery["expected_records"] or checkpoint != recovery["expected_cursor"] or record_winner(recovered_records)["id"] != recovery["expected_winner"]:
        failures.append("snapshot recovery mismatch")

    ordered = sorted(cases["search"]["candidates"], key=lambda item: (-item["score"], item["name"].encode(), item["id"].encode()))
    if [item["id"] for item in ordered] != cases["search"]["expected_order"]:
        failures.append("stable search order mismatch")
    for request in cases["search"]["requests"]:
        binding = cases["search"]["cursor_store"].get(request["cursor"])
        error = None
        ids = None
        if binding is None:
            error = "cursor_invalid"
        elif binding["feed"] != request["feed"] or canonical(binding["filter"]) != canonical(request["filter"]):
            error = "cursor_binding_mismatch"
        else:
            ids = [item["id"] for item in ordered[binding["offset"]:binding["offset"] + 2]]
        if request.get("expected_error", error) != error or request.get("expected_ids", ids) != ids:
            failures.append("opaque cursor binding mismatch")

    cache = copy.deepcopy(cases["http_cache"]["initial"])
    for event in cases["http_cache"]["events"]:
        matching = event["url"] == cache["url"] and event.get("request_etag") == cache["etag"]
        if event["status"] == 304:
            outcome = "not_modified" if matching else "failure"
        else:
            cache = {"url": event["url"], "etag": event["response_etag"], "rows": list(event["rows"])}
            outcome = "replaced"
        if outcome != event["expected"]:
            failures.append("ETag transition mismatch")
    if cache != cases["http_cache"]["expected_final"]:
        failures.append("HTTP cache final state mismatch")

    streams = cases["endpoint_scope"]["stream_urls"]
    stream_digests = {"sha256:" + base64.urlsafe_b64encode(hashlib.sha256(value.encode()).digest()).rstrip(b"=").decode() for value in streams}
    for observation in cases["endpoint_scope"]["observations"]:
        endpoint = observation["endpoint"]
        fields = [field for field in ("endpoint_index", "stream_url_digest") if field in endpoint]
        accepted = len(fields) == 1 and ((fields[0] == "endpoint_index" and 0 <= endpoint[fields[0]] < len(streams)) or (fields[0] == "stream_url_digest" and endpoint[fields[0]] in stream_digests))
        if ("accepted" if accepted else "quarantined") != observation["expected"]:
            failures.append("endpoint scope mismatch")

    for extension in cases["extensions"]["cases"]:
        payload = extension["payload"]
        critical = payload.get("critical", [])
        missing = next((member for member in critical if member not in payload), None)
        if extension.get("expected_error"):
            if missing is None:
                failures.append("missing critical member accepted")
        elif (not critical) != extension["expected_materializable"] or payload.get("future") != extension["expected_preserved"]:
            failures.append("unknown member handling mismatch")

    offline_case = cases["offline_cache"]
    offline = copy.deepcopy(offline_case["initial"])
    for row in offline["rows"]:
        if any(field not in row for field in offline_case["required_fields"]):
            failures.append("incomplete cached row")
    actual = {
        "mode": "offline_stale",
        "data_age": offline_case["now_epoch"] - offline["refreshed_at"],
        "row_ids": sorted(row["station_id"] for row in offline["rows"]),
        "health": {row["station_id"]: "unknown" if 0 < row["health_expires_at"] <= offline_case["now_epoch"] else row["health"] for row in offline["rows"]},
        "tombstones": [row["station_id"] for row in offline["rows"] if row.get("tombstone")],
    }
    if actual != offline_case["expected"]:
        failures.append("offline cache age/health/tombstone mismatch")
    return failures


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
    failures.extend(execute_interoperability(cases))
    if failures:
        print("\n".join(f"FAIL {failure}" for failure in failures), file=sys.stderr)
        return 1
    print(f"{len(manifest['fixtures'])} signed fixtures and interoperability cases passed (independent Python + Draft 2020-12)")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
