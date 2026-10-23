#!/usr/bin/env python3
# Copyright 2026 Barebuh contributors
# SPDX-License-Identifier: GPL-3.0-or-later

"""Verify release policy and deterministic local artifact generation."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "release" / "build.py"
CONFIG = ROOT / "release" / "config.json"
VERSION = (ROOT / "release" / "VERSION").read_text(encoding="utf-8").strip()


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def package_verification_code(archive: Path) -> str:
    file_digests = []
    with tarfile.open(archive, "r:xz") as source:
        for member in source.getmembers():
            if not member.isfile():
                continue
            extracted = source.extractfile(member)
            if extracted is None:
                raise SystemExit(f"unable to read archived file: {member.name}")
            file_digests.append(hashlib.sha1(extracted.read()).hexdigest())
    return hashlib.sha1("".join(sorted(file_digests)).encode()).hexdigest()


def check_forced_feature_gates() -> None:
    gate_script = ROOT / "cmake" / "BarebuhExternalIntegrations.cmake"
    cases = (
        ("Spotify", ["-DENABLE_SPOTIFY=ON"], "Spotify requires an explicitly configured OAuth registration"),
        (
            "Spotify placeholder redirect",
            [
                "-DENABLE_SPOTIFY=ON",
                "-DSPOTIFY_CLIENT_ID=test-client",
                "-DSPOTIFY_CLIENT_SECRET=test-secret",
                "-DSPOTIFY_OAUTH_REDIRECT_URL=https://barebuh.example/oauth/",
            ],
            "Spotify requires an explicitly configured OAuth registration",
        ),
        ("Discord", ["-DENABLE_DISCORD_RPC=ON"], "Discord Rich Presence requires an approved Barebuh application ID"),
        (
            "Discord upstream identity",
            ["-DENABLE_DISCORD_RPC=ON", "-DDISCORD_APPLICATION_ID=1352351827206733974"],
            "Discord Rich Presence requires an approved Barebuh application ID",
        ),
    )
    for name, definitions, expected_message in cases:
        result = subprocess.run(
            ["cmake", *definitions, "-P", str(gate_script)],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        if result.returncode == 0 or expected_message not in result.stdout:
            raise SystemExit(f"{name} forced enablement must fail without approved integration coordinates")

    configured = subprocess.run(
        [
            "cmake",
            "-DENABLE_SPOTIFY=ON",
            "-DSPOTIFY_CLIENT_ID=test-client",
            "-DSPOTIFY_CLIENT_SECRET=test-secret",
            "-DSPOTIFY_OAUTH_REDIRECT_URL=http://127.0.0.1/callback",
            "-DENABLE_DISCORD_RPC=ON",
            "-DDISCORD_APPLICATION_ID=123456789012345678",
            "-P",
            str(gate_script),
        ],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    if configured.returncode != 0:
        raise SystemExit("explicitly configured local OAuth and Barebuh Discord coordinates must pass the feature gate")


def build(output: Path) -> None:
    subprocess.run([sys.executable, str(BUILDER), "--output", str(output)], cwd=ROOT, check=True)


def check_policy() -> None:
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    if config["product"]["name"] != "Barebuh":
        raise SystemExit("canonical product name must be Barebuh")
    if config["product"]["alias"] != "Dingleberry":
        raise SystemExit("Dingleberry must be recorded only as the legacy alias")
    if config["release"]["signed"] or config["release"]["publishable"]:
        raise SystemExit("local release configuration must remain unsigned and non-publishable")
    unresolved = config["publication"]
    if any(value is not None for value in unresolved.values()):
        raise SystemExit("publication coordinates require an explicit, separately reviewed configuration change")

    required = [
        ROOT / "COPYING",
        ROOT / "README.md",
        ROOT / "CHANGELOG.md",
        ROOT / "CONTRIBUTING.md",
        ROOT / "CONTRIBUTORS.md",
        ROOT / "SECURITY.md",
        ROOT / "docs" / "release.md",
        ROOT / "docs" / "workstreams.md",
    ]
    missing = [str(path.relative_to(ROOT)) for path in required if not path.is_file()]
    if missing:
        raise SystemExit("missing release files: " + ", ".join(missing))

    check_forced_feature_gates()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--policy-only", action="store_true")
    args = parser.parse_args()

    check_policy()
    if args.policy_only:
        print("PASS: local release policy is complete and publication remains disabled")
        return 0

    with tempfile.TemporaryDirectory(prefix="barebuh-repro-a-") as first_dir, tempfile.TemporaryDirectory(
        prefix="barebuh-repro-b-"
    ) as second_dir:
        first = Path(first_dir)
        second = Path(second_dir)
        build(first)
        build(second)
        first_files = sorted(path.name for path in first.iterdir())
        second_files = sorted(path.name for path in second.iterdir())
        if first_files != second_files:
            raise SystemExit("release builds emitted different file sets")
        mismatches = [name for name in first_files if digest(first / name) != digest(second / name)]
        if mismatches:
            raise SystemExit("release artifacts are not reproducible: " + ", ".join(mismatches))

        archive = first / f"barebuh-{VERSION}.tar.xz"
        with tarfile.open(archive, "r:xz") as source:
            names = set(source.getnames())
        prefix = f"barebuh-{VERSION}/"
        for required_name in ("COPYING", "README.md", "release/config.json"):
            if prefix + required_name not in names:
                raise SystemExit(f"source archive is missing {required_name}")

        checksums = (first / "SHA256SUMS").read_text(encoding="utf-8").splitlines()
        if len(checksums) != 3:
            raise SystemExit("SHA256SUMS must cover source, SBOM, and build metadata")
        for line in checksums:
            expected, name = line.split("  ", 1)
            if digest(first / name) != expected:
                raise SystemExit(f"checksum mismatch for {name}")

        sbom = json.loads((first / f"barebuh-{VERSION}.spdx.json").read_text(encoding="utf-8"))
        if sbom["spdxVersion"] != "SPDX-2.3" or not sbom["files"]:
            raise SystemExit("SPDX SBOM is incomplete")
        actual_verification_code = sbom["packages"][0]["packageVerificationCode"]["packageVerificationCodeValue"]
        expected_verification_code = package_verification_code(archive)
        if actual_verification_code != expected_verification_code:
            raise SystemExit(
                "SPDX packageVerificationCode mismatch: "
                f"expected {expected_verification_code}, got {actual_verification_code}"
            )

    print("PASS: local release artifacts are deterministic, unsigned, and non-publishable")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
