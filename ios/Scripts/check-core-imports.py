#!/usr/bin/env python3
"""Every Swift file that names a GradeThreadCore type imports GradeThreadCore.

WHY THIS EXISTS. Mobile plan action 6 moves pure logic out of the app target
and into ios/Packages/GradeThreadCore, so `swift test` can run it on Linux.
Each move turns an app-internal type into a type from another module, and
every file that used it now needs `import GradeThreadCore`. Miss one and the
build dies on a macOS runner with "cannot find 'MoneyDate' in scope", twenty
minutes after a push that every local check called green. No Swift compiler
runs off a Mac here, so this reads the question a compiler would ask first.

WHAT IT CHECKS. The names come from the package itself: every top-level
`public enum|struct|class|protocol|actor|typealias` under
ios/Packages/GradeThreadCore/Sources. A file in the app, test, widget or share
extension targets that mentions one of those names outside a comment or string
literal, and has no `import GradeThreadCore`, fails. A file that DECLARES a
type of the same name (the app shadowing a Core type) is left alone.

WHAT IT DOES NOT CHECK. Access level (`public` on each member), argument
labels, or anything else a compiler does properly. A pass is not a build.

Run: python3 ios/Scripts/check-core-imports.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
IOS = REPO / "ios"
CORE_SOURCES = IOS / "Packages" / "GradeThreadCore" / "Sources"

# Targets that consume the package. Packages/ is excluded on purpose: inside
# the package the types are its own and need no import.
CONSUMER_DIRS = [
    "GradeThread",
    "GradeThreadTests",
    "GradeThreadUITests",
    "GradeThreadWidget",
    "ShareExtension",
    "Shared",
]

PUBLIC_TYPE = re.compile(
    r"^public\s+(?:final\s+)?(?:enum|struct|class|protocol|actor|typealias)\s+([A-Za-z_]\w*)",
    re.M,
)
IMPORT_CORE = re.compile(r"^\s*(?:@testable\s+)?import\s+GradeThreadCore\b", re.M)


def core_type_names(sources: Path) -> set[str]:
    names: set[str] = set()
    for f in sources.rglob("*.swift"):
        names.update(PUBLIC_TYPE.findall(f.read_text(encoding="utf-8")))
    return names


def strip_comments_and_strings(src: str) -> str:
    """Blank out comments and string literals, keeping everything else.

    Crude but sufficient for a name scan: `Text("Money in")` and a doc comment
    saying `MoneyDate` must not count as uses.
    """
    src = re.sub(r'"""[\s\S]*?"""', '""', src)
    src = re.sub(r"/\*[\s\S]*?\*/", "", src)
    src = re.sub(r"//[^\n]*", "", src)
    src = re.sub(r'"(?:\\.|[^"\\\n])*"', '""', src)
    return src


def violations(names: set[str], files: list[Path]) -> list[tuple[Path, list[str]]]:
    out: list[tuple[Path, list[str]]] = []
    if not names:
        return out
    word = re.compile(r"\b(" + "|".join(sorted(map(re.escape, names))) + r")\b")
    for f in files:
        raw = f.read_text(encoding="utf-8")
        if IMPORT_CORE.search(raw):
            continue
        code = strip_comments_and_strings(raw)
        used = set(word.findall(code))
        declared = set(
            re.findall(r"\b(?:enum|struct|class|protocol|actor|typealias)\s+([A-Za-z_]\w*)", code)
        )
        used -= declared
        if used:
            out.append((f, sorted(used)))
    return out


def consumer_files() -> list[Path]:
    files: list[Path] = []
    for d in CONSUMER_DIRS:
        root = IOS / d
        if root.is_dir():
            files.extend(sorted(root.rglob("*.swift")))
    return files


def self_check() -> None:
    """The scan must catch a missing import, or a quiet result means nothing."""
    names = {"MoneyDate", "PayoutDateFormat"}
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        bad = Path(tmp) / "Bad.swift"
        bad.write_text('import Foundation\nlet d = MoneyDate.parse("2026-09-01")\n')
        ok = Path(tmp) / "Ok.swift"
        ok.write_text("import Foundation\nimport GradeThreadCore\nlet d = MoneyDate.parse(x)\n")
        prose = Path(tmp) / "Prose.swift"
        prose.write_text('import SwiftUI\n// MoneyDate lives in Core\nlet t = Text("MoneyDate")\n')
        found = {p.name for p, _ in violations(names, [bad, ok, prose])}
    if found != {"Bad.swift"}:
        print(f"check-core-imports: self-check failed, flagged {sorted(found)}")
        sys.exit(2)


def main() -> int:
    self_check()
    names = core_type_names(CORE_SOURCES)
    if not names:
        print(f"check-core-imports: no public types found under {CORE_SOURCES}")
        return 2
    bad = violations(names, consumer_files())
    if bad:
        print("These files use a GradeThreadCore type without `import GradeThreadCore`:")
        for f, used in bad:
            print(f"  {f.relative_to(REPO)}: {', '.join(used)}")
        return 1
    print(f"check-core-imports: {len(names)} Core types, every consumer imports the package")
    return 0


if __name__ == "__main__":
    sys.exit(main())
