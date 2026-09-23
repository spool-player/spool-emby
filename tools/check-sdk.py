#!/usr/bin/env python3
import hashlib
import json
import pathlib

root = pathlib.Path(__file__).resolve().parents[1]
lock = json.loads((root / "sdk.lock.json").read_text())
for name, expected in lock["files"].items():
    actual = hashlib.sha256((root / name).read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f"SDK pin mismatch: {name}")
print("Pinned Spool SDK hashes verified")
