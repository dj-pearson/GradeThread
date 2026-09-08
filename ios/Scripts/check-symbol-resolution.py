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
    # US-3138. Two enums, ONE file, and that is the whole reason the scoping
    # below had to change. `EbayViewItemPreviewSheet` called
    # `PhotoSlotType.isNonListable`, which lives on `FlipdeskPhotoType` -- the
    # enum modelling server photo_type strings, not the one modelling capture
    # slots. It failed iOS CI with "type 'PhotoSlotType' has no member
    # 'isNonListable'" and, because Swift reports one error and stops, it also
    # hid every other file in the build behind it.
    "PhotoSlotType": "GradeThread/Capture/PhotoSlotType.swift",
    "FlipdeskPhotoType": "GradeThread/Capture/PhotoSlotType.swift",
}

DECL = re.compile(
    r"(?:static\s+func|static\s+let|static\s+var|func|let|var|enum|struct|case)\s+"
    r"([A-Za-z_][A-Za-z0-9_]*)"
)

# Where a type's body starts: its own declaration, or an extension of it.
TYPE_HEAD = (
    r"^[ \t]*(?:public |internal |private |fileprivate |open |final |@\w+\s+)*"
    r"(?:enum|struct|class|actor|extension)\s+{name}\b"
)


# Members no body declares because a conformance synthesizes them. Only granted
# when the type's own declaration lists that conformance, so a type that does
# not conform still fails on them.
SYNTHESIZED = {
    "CaseIterable": {"allCases", "AllCases"},
    "Identifiable": {"ID"},
    "Hashable": {"hashValue"},
    "RawRepresentable": {"RawValue"},
    "Equatable": {},
    "Codable": {"CodingKeys"},
    "Decodable": {"CodingKeys"},
    "Encodable": {"CodingKeys"},
}

# A raw-value enum (`enum Foo: String`) is RawRepresentable without saying so.
RAW_VALUE_KINDS = ("String", "Int", "Int8", "Int16", "Int32", "Int64", "Double", "Character")


def _synthesized_for(source: str, type_name: str) -> set[str]:
    """What conformance gives `type_name`, read off its declaration line."""
    head = re.search(
        TYPE_HEAD.format(name=re.escape(type_name)) + r"[^\n{]*",
        source,
        re.MULTILINE,
    )
    if not head:
        return set()
    line = head.group(0)
    granted: set[str] = set()
    for proto, members in SYNTHESIZED.items():
        if re.search(rf"\b{proto}\b", line):
            granted |= set(members)
    if any(re.search(rf":\s*{kind}\b", line) for kind in RAW_VALUE_KINDS):
        granted |= SYNTHESIZED["RawRepresentable"]
    return granted


def _bodies(source: str, type_name: str) -> list[str]:
    """Every brace-matched body belonging to `type_name` in `source`."""
    bodies: list[str] = []
    head = re.compile(TYPE_HEAD.format(name=re.escape(type_name)), re.MULTILINE)
    for m in head.finditer(source):
        open_at = source.find("{", m.end())
        if open_at == -1:
            continue
        depth = 0
        for i in range(open_at, len(source)):
            ch = source[i]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    bodies.append(source[open_at + 1 : i])
                    break
    return bodies


def declared_members(source: str, type_name: str) -> set[str]:
    """Members declared INSIDE `type_name`, not merely somewhere in the file.

    ⚠ THIS USED TO BE FILE-SCOPED, and file-scoping is what let the bug above
    through. `PhotoSlotType` and `FlipdeskPhotoType` share a file, so a union of
    everything the file declares resolves `PhotoSlotType.isNonListable`
    perfectly happily -- the guard would have passed on the exact call that
    failed the build. Adding the type to OWNED without this change would have
    bought nothing and looked like coverage. ``self_check`` below is what stops
    it silently reverting.
    """
    bodies = _bodies(source, type_name)
    if not bodies:
        return set()
    found = {m.group(1) for body in bodies for m in DECL.finditer(body)}
    return found | _synthesized_for(source, type_name)


def self_check() -> list[str]:
    """Prove the scoping still bites, using the case that got past it.

    A guard nobody can see failing is a guard that quietly stops guarding
    (`vault/70-agent/guards-that-do-not-guard.md`). This asserts BOTH halves:
    the member resolves on the type that has it, and does NOT resolve on its
    file-mate.
    """
    path = IOS / "GradeThread/Capture/PhotoSlotType.swift"
    if not path.is_file():
        return ["self-check: PhotoSlotType.swift is gone; update this check with it"]
    source = path.read_text(encoding="utf-8")
    out: list[str] = []
    if "isNonListable" not in declared_members(source, "FlipdeskPhotoType"):
        out.append(
            "self-check: isNonListable no longer parses as a FlipdeskPhotoType "
            "member — the scoping or the DECL regex has broken"
        )
    if "isNonListable" in declared_members(source, "PhotoSlotType"):
        out.append(
            "self-check: isNonListable resolves on PhotoSlotType, which does not "
            "declare it — member lookup has gone back to file scope and this "
            "guard would now pass on the bug it was widened for"
        )
    return out


def main() -> int:
    problems: list[str] = self_check()

    for type_name, rel in OWNED.items():
        decl_path = IOS / rel
        if not decl_path.is_file():
            problems.append(
                f"{type_name}: this guard names {rel} and it does not exist. "
                "Renamed or moved? Update OWNED rather than deleting the entry, "
                "or the type stops being checked and nothing says so."
            )
            continue

        members = declared_members(decl_path.read_text(encoding="utf-8"), type_name)
        if not members:
            problems.append(
                f"{type_name}: no members parsed out of {rel} — either the type "
                "is not declared there any more or the regex has stopped matching"
            )
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
                f"{type_name}.{member} is used but is not declared ON "
                f"{type_name} (in {rel}). If a different type in that file has "
                f"it, call it on that one.\n"
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
