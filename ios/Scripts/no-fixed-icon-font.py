#!/usr/bin/env python3
"""Fail if app sources pin a glyph or badge to `.font(.system(size:))`.

WHY
---
`.font(.system(size: 20))` is an absolute point size. It ignores the user's
Dynamic Type setting entirely, so at the largest accessibility sizes every
label on the screen grows and the icon beside it does not — the empty-state
glyph shrinks into the copy, and a count badge stays 11pt for the person who
set the text to 53pt because they cannot read 11pt.

US-1152 added `ScaledIconFont` (ios/GradeThread/Accessibility/ScaledIconFont.swift)
for exactly this: `@ScaledMetric` grows the point size with the text setting,
and an optional `maxSize` clamps it so a glyph inside a fixed frame can't
overflow. It was applied to ten call sites and the rule then stopped being
enforced — seventeen more fixed sizes were written afterwards, including the
inventory filter's active-count badge and the "Camera access is off" glyph on
both capture screens.

THE FIX IS ALWAYS THE SAME
--------------------------
    .font(.system(size: 20))                  ->  .scaledIconFont(size: 20)
    .font(.system(size: 22, weight: .light))  ->  .scaledIconFont(size: 22, weight: .light)

Add `maxSize:` when the glyph sits in a fixed frame:

    .scaledIconFont(size: 22, weight: .light, maxSize: 44)

For TEXT, prefer a real text style (`.caption2`, `.subheadline`, ...) — those
scale on their own. `scaledIconFont` is for glyphs and for the rare badge digit
that has to match a glyph's size.
"""

from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _scan_scope import TARGET_DIRS as SCAN_DIRS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# `.font(.system(size: <literal>` and the `Font.system(size: <literal>`
# spelling. A NUMERIC LITERAL is the thing that can't scale — a size fed by a
# variable is either a @ScaledMetric or a deliberate computation, which is why
# `ScaledIconFont` itself and the share extension's inline @ScaledMetric need no
# exception here. (A `let size: CGFloat = 20` handed to the same call would slip
# through; that is a hole a line-level scan can't close, and nobody writes it
# by accident.) A `.system(size:)` with `relativeTo:` scales and is allowed.
PATTERN = re.compile(r"\.(?:font\(\s*\.|font\(\s*Font\.)system\(\s*size:\s*[0-9]")
RELATIVE_TO = re.compile(r"relativeTo:")

ALLOWED = {
    # WidgetKit renders at a size the system fixes; widget content does not
    # follow the in-app Dynamic Type setting the way app views do, and the
    # layouts are budgeted to the widget families' exact point sizes.
    "GradeThreadWidget/GradeThreadWidget.swift",
}


def main() -> int:
    violations: list[str] = []
    scanned = 0

    for rel_dir in SCAN_DIRS:
        base = os.path.join(ROOT, rel_dir)
        if not os.path.isdir(base):
            continue
        for dirpath, _dirnames, filenames in os.walk(base):
            for name in filenames:
                if not name.endswith(".swift"):
                    continue
                path = os.path.join(dirpath, name)
                rel = os.path.relpath(path, ROOT).replace(os.sep, "/")
                if "Tests" in rel:
                    continue
                scanned += 1
                if rel in ALLOWED:
                    continue
                with open(path, encoding="utf-8") as handle:
                    for num, line in enumerate(handle, 1):
                        stripped = line.strip()
                        if stripped.startswith("//"):
                            continue
                        if PATTERN.search(line) and not RELATIVE_TO.search(line):
                            violations.append(f"{rel}:{num}: {stripped}")

    # A gate that scans nothing passes forever. Fail loudly instead.
    if scanned < 50:
        print(
            f"ERROR: only {scanned} Swift files scanned - the layout changed and "
            "this gate is no longer looking at the app. Fix the paths.",
            file=sys.stderr,
        )
        return 2

    if violations:
        print("ERROR: fixed point size ignores Dynamic Type:", file=sys.stderr)
        for v in violations:
            print(f"  {v}", file=sys.stderr)
        print(
            "\nUse `.scaledIconFont(size: N)` (US-1152) for a glyph, adding "
            "`maxSize:` when it sits in a fixed frame, or a real text style "
            "(.caption2/.subheadline/...) for text. A fixed size stays 11pt for "
            "the person who set their text to 53pt.",
            file=sys.stderr,
        )
        return 1

    print(f"OK: every glyph size scales with Dynamic Type ({scanned} files).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
