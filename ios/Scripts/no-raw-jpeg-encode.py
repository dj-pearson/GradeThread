#!/usr/bin/env python3
"""Fail if app sources JPEG-encode an image without going through PhotoCompressor.

WHY
---
`UIImage.jpegData(compressionQuality:)` encodes the CGImage as-is and records the
orientation as an EXIF flag. Consumers that read EXIF render it correctly;
consumers that ignore EXIF render it sideways or upside-down. eBay's image
pipeline ignores it — PhotoCompressor's own header says so, which is exactly why
`compress()` calls `normalizedUp()` to bake the pixels upright BEFORE encoding.

A raw encode therefore silently ships rotated images to the one destination the
codebase already knows mishandles them, and skips the 1600px/0.75 downscale
(originals are 3-10 MB) and the off-MainActor hop as well.

This was not hypothetical: PostSaleView uploaded dispute evidence — a seller
contesting an eBay case, the highest-stakes photo in the product — with a bare
`image.jpegData(compressionQuality: 0.8)`.

The knowledge lived in a comment inside PhotoCompressor, where no call site
could be affected by it. This turns it into a gate, matching the other
ios/Scripts checks (no-force-unwrap, no-default-shared-session, ...).

ALLOWED
-------
  * PhotoCompressor itself — it is the sanctioned implementation.
  * ShareExtension/ShareViewController.swift — the extension deliberately does
    not link the app target (US-1646); its `downscaledJPEG` bakes orientation
    upright through UIGraphicsImageRenderer and is the documented equivalent.
  * Test sources.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

SCAN_DIRS = ["GradeThread", "ShareExtension", "Shared", "GradeThreadWidget"]

ALLOWED = {
    "GradeThread/Capture/PhotoCompressor.swift",
    "ShareExtension/ShareViewController.swift",
}

PATTERN = re.compile(r"\.jpegData\s*\(\s*compressionQuality")


def main() -> int:
    violations: list[str] = []
    scanned = 0

    for rel_dir in SCAN_DIRS:
        base = ROOT / rel_dir
        if not base.exists():
            continue
        for path in base.rglob("*.swift"):
            rel = path.relative_to(ROOT).as_posix()
            if rel in ALLOWED or "Tests" in rel:
                continue
            scanned += 1
            for num, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if line.lstrip().startswith("//"):
                    continue
                if PATTERN.search(line):
                    violations.append(f"{rel}:{num}: {line.strip()}")

    # A gate that scans nothing passes forever. Fail loudly instead.
    if scanned < 50:
        print(
            f"ERROR: only {scanned} Swift files scanned — the layout changed and "
            "this gate is no longer looking at the app. Fix the paths.",
            file=sys.stderr,
        )
        return 2

    if violations:
        print("ERROR: raw JPEG encode outside PhotoCompressor:", file=sys.stderr)
        for v in violations:
            print(f"  {v}", file=sys.stderr)
        print(
            "\nUse `await PhotoCompressor.compressOffMain(image)` (or "
            "`compressBatch`) instead. It bakes orientation upright before "
            "encoding — eBay ignores the EXIF orientation flag — downscales to "
            "1600px/0.75, and keeps the encode off the MainActor.",
            file=sys.stderr,
        )
        return 1

    print(f"OK: no raw JPEG encode outside PhotoCompressor ({scanned} files).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
