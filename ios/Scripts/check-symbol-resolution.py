#!/usr/bin/env python3
"""US-2889: every `Type.member` referenced in ios/ resolves to a declaration.

WHY THIS EXISTS. On 2026-08-28 a rewrite of MeasureGeometry.swift deleted
`isOutsideFrame` while three call sites still used it. Every local check passed:
Swift does not compile on the Windows dev box, and all twelve existing guards
read for PATTERNS (an ungated print, a raw JPEG encode, a bare string) rather
than for RESOLUTION. iOS CI on a macOS runner caught it, twenty minutes and one
push later, with "Type 'MeasureGeometry' has no member 'isOutsideFrame'".

That round trip is the thing worth removing. A compiler is not available here,
but the single most common way a Windows-authored Swift change breaks the build
- calling a member that no longer exists on a type in this repo - is answerable
by reading two files.

DELIBERATELY NARROW. It checks only types whose members are all declared in one
file that this script can find, and only `Type.member` at a call site. It says
nothing about argument labels, types, protocol conformances, or anything the
compiler does properly. A pass here is not a build; a FAILURE here is a build
error you would otherwise have found on a runner.

Run: python ios/Scripts/check-symbol-resolution.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
IOS = REPO / "ios"

# Types this script owns. Each maps to the file that declares every member.
#
# An allowlist rather than a sweep: a repo-wide "resolve every Type.member"
# needs a real parser to avoid drowning in framework types (URLSession.shared,
# Color.red, Image.Orientation), and a guard that reports a hundred false
# positives is one nobody runs twice. These are the pure-math enums whose
# members are edited by hand and used from several screens, which is exactly
# the shape that broke.
OWNED = {
    "MeasureGeometry": "GradeThread/Measure/MeasureGeometry.swift",
    "MeasureQuarterTurn": "GradeThread/Measure/MeasureQuarterTurn.swift",
    "MeasureNudge": "GradeThread/Measure/MeasureNudge.swift",
    "Consent": "GradeThread/Telemetry/ConsentRegime.swift",
}

DECL = re.compile(
    r"(?:static\s+func|static\s+let|static\s+var|func|let|var|enum|struct|case)\s+"
    r"([A-Za-z_][A-Za-z0-9_]*)"
)


def declared_members(source: str) -> set[str]:
    return {m.group(1) for m in DECL.finditer(source)}


def main() -> int:
    problems: list[str] = []

    for type_name, rel in OWNED.items():
        decl_path = IOS / rel
        if not decl_path.is_file():
            problems.append(
                f"{type_name}: this guard names {rel} and it does not exist. "
                "Renamed or moved? Update OWNED rather than deleting the entry, "
                "or the type stops being checked and nothing says so."
            )
            continue

        members = declared_members(decl_path.read_text(encoding="utf-8"))
        if not members:
            problems.append(f"{type_name}: no members parsed out of {rel} — the regex has stopped matching")
            continue

        used: dict[str, list[str]] = {}
        for swift in IOS.rglob("*.swift"):
            text = swift.read_text(encoding="utf-8", errors="replace")
            for m in re.finditer(rf"\b{type_name}\.([A-Za-z_][A-Za-z0-9_]*)", text):
                used.setdefault(m.group(1), []).append(
                    f"{swift.relative_to(REPO).as_posix()}:{text[: m.start()].count(chr(10)) + 1}"
                )

        for member, sites in sorted(used.items()):
            if member in members:
                continue
            problems.append(
                f"{type_name}.{member} is used but not declared in {rel}\n"
                + "".join(f"    {s}\n" for s in sites[:5])
            )

    if problems:
        print("check-symbol-resolution FAILED:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1

    print(f"check-symbol-resolution ok ({len(OWNED)} types, every member resolves)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
