#!/usr/bin/env python3
# Copyright 2026 Barebuh contributors
# SPDX-License-Identifier: GPL-3.0-or-later

"""Build a deterministic, unsigned local Barebuh source release bundle."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import lzma
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "release" / "config.json"
VERSION_PATH = ROOT / "release" / "VERSION"


def run_git(*args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(ROOT), *args],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    return result.stdout


def run_git_bytes(*args: str) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(ROOT), *args],
        check=True,
        stdout=subprocess.PIPE,
    )
    return result.stdout


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def iso8601(epoch: int) -> str:
    return dt.datetime.fromtimestamp(epoch, tz=dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ensure_release_tree(allow_dirty: bool) -> tuple[str, int]:
    if not allow_dirty:
        dirty = run_git("status", "--porcelain", "--untracked-files=no").strip()
        if dirty:
            raise SystemExit("release build requires a clean tracked worktree")
    commit = run_git("rev-parse", "HEAD").strip()
    epoch = int(run_git("show", "-s", "--format=%ct", commit).strip())
    configured_epoch = os.environ.get("SOURCE_DATE_EPOCH")
    if configured_epoch is not None and int(configured_epoch) != epoch:
        raise SystemExit(
            f"SOURCE_DATE_EPOCH must match the release commit ({epoch}), got {configured_epoch}"
        )
    return commit, epoch


def build_archive(output: Path, prefix: str, commit: str) -> None:
    with tempfile.TemporaryDirectory(prefix="barebuh-release-") as temporary:
        tar_path = Path(temporary) / "source.tar"
        archive = run_git_bytes("archive", "--format=tar", f"--prefix={prefix}/", commit)
        tar_path.write_bytes(archive)
        with tar_path.open("rb") as source, lzma.open(
            output,
            "wb",
            format=lzma.FORMAT_XZ,
            check=lzma.CHECK_CRC64,
            preset=9 | lzma.PRESET_EXTREME,
        ) as destination:
            while chunk := source.read(1024 * 1024):
                destination.write(chunk)


def spdx_id(path: str) -> str:
    return "SPDXRef-File-" + hashlib.sha256(path.encode()).hexdigest()[:20]


def build_sbom(archive: Path, output: Path, config: dict, version: str, commit: str, epoch: int) -> None:
    files = []
    file_sha1_digests = []
    relationships = []
    with tarfile.open(archive, "r:xz") as source:
        for member in sorted(source.getmembers(), key=lambda item: item.name):
            if not member.isfile():
                continue
            extracted = source.extractfile(member)
            if extracted is None:
                raise SystemExit(f"unable to read archived file: {member.name}")
            content = extracted.read()
            checksum = hashlib.sha256(content).hexdigest()
            file_sha1_digests.append(hashlib.sha1(content).hexdigest())
            identifier = spdx_id(member.name)
            files.append(
                {
                    "SPDXID": identifier,
                    "fileName": f"./{member.name}",
                    "checksums": [{"algorithm": "SHA256", "checksumValue": checksum}],
                    "licenseConcluded": "NOASSERTION",
                    "copyrightText": "NOASSERTION",
                }
            )
            relationships.append(
                {
                    "spdxElementId": "SPDXRef-Package-Barebuh",
                    "relationshipType": "CONTAINS",
                    "relatedSpdxElement": identifier,
                }
            )

    namespace_seed = f"barebuh:{version}:{commit}:{sha256(archive)}"
    namespace = f"urn:uuid:{uuid.uuid5(uuid.NAMESPACE_URL, namespace_seed)}"
    document = {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": f"Barebuh-{version}",
        "documentNamespace": namespace,
        "creationInfo": {
            "created": iso8601(epoch),
            "creators": ["Tool: release/build.py"],
            "licenseListVersion": "3.25",
        },
        "packages": [
            {
                "name": "Barebuh",
                "SPDXID": "SPDXRef-Package-Barebuh",
                "versionInfo": version,
                "downloadLocation": "NOASSERTION",
                "filesAnalyzed": True,
                "packageVerificationCode": {
                    "packageVerificationCodeValue": hashlib.sha1(
                        "".join(sorted(file_sha1_digests)).encode()
                    ).hexdigest()
                },
                "licenseConcluded": config["upstream"]["license"],
                "licenseDeclared": config["upstream"]["license"],
                "copyrightText": "See the archived source files and debian/copyright",
                "checksums": [{"algorithm": "SHA256", "checksumValue": sha256(archive)}],
                "comment": (
                    "Modified fork of "
                    f"{config['upstream']['repository']} at {config['upstream']['base_commit']}"
                ),
            }
        ],
        "files": files,
        "relationships": [
            {
                "spdxElementId": "SPDXRef-DOCUMENT",
                "relationshipType": "DESCRIBES",
                "relatedSpdxElement": "SPDXRef-Package-Barebuh",
            },
            *relationships,
        ],
    }
    output.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "build" / "release")
    parser.add_argument(
        "--allow-dirty",
        action="store_true",
        help="development only: archive HEAD while tracked changes exist",
    )
    args = parser.parse_args()

    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    version = VERSION_PATH.read_text(encoding="utf-8").strip()
    commit, epoch = ensure_release_tree(args.allow_dirty)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)

    base = f"barebuh-{version}"
    archive = output / f"{base}.tar.xz"
    sbom = output / f"{base}.spdx.json"
    metadata = output / f"{base}.build-metadata.json"
    checksums = output / "SHA256SUMS"

    build_archive(archive, base, commit)
    build_sbom(archive, sbom, config, version, commit, epoch)
    metadata.write_text(
        json.dumps(
            {
                "product": config["product"],
                "version": version,
                "source_commit": commit,
                "source_date_epoch": epoch,
                "created": iso8601(epoch),
                "upstream": config["upstream"],
                "artifacts": [archive.name, sbom.name],
                "signed": False,
                "publishable": False,
                "reproduction": "SOURCE_DATE_EPOCH=%d make release" % epoch,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    artifacts = sorted([archive, sbom, metadata], key=lambda item: item.name)
    checksums.write_text(
        "".join(f"{sha256(path)}  {path.name}\n" for path in artifacts),
        encoding="utf-8",
    )
    print(f"Built unsigned local release bundle in {output}")
    for path in [*artifacts, checksums]:
        print(f"  {path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
