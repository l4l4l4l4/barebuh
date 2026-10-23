#!/usr/bin/env python3
# Copyright 2026 Barebuh contributors
# SPDX-License-Identifier: GPL-3.0-or-later

"""Fail-closed publication gate.

This repository intentionally contains no uploader. The command reports every
unresolved coordinate and still refuses publication after they are populated;
a reviewed publisher implementation is a separate change.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
config = json.loads((ROOT / "release" / "config.json").read_text(encoding="utf-8"))
missing = [name for name, value in config["publication"].items() if not value]
if missing:
    raise SystemExit("publication blocked; unresolved: " + ", ".join(missing))
raise SystemExit(
    "publication blocked; coordinates are present but no publisher is implemented. "
    "Add one only in a separately reviewed, explicitly authorized change."
)
