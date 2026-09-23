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

It also reads ios/project.yml. An import only compiles in a target that links
the package, and Shared/ is compiled into the app, the widget and the share
extension at once. So every target whose `sources` include a directory holding
a file that imports or names Core must list `- package: GradeThreadCore` under
its `dependencies`, or that target fails with "no such module".

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


PROJECT_YML = IOS / "project.yml"
CORE_PACKAGE = "GradeThreadCore"


def parse_targets(text: str) -> dict[str, dict[str, set[str]]]:
    """Read each target's source roots and package deps out of project.yml.

    A line reader rather than a YAML library: CI's macOS runner and the dev
    boxes have python3 but not necessarily PyYAML, and project.yml keeps a
    fixed shape (targets at two spaces, their keys at four, list items at
    six). Only `sources` and `dependencies` are read.
    """
    targets: dict[str, dict[str, set[str]]] = {}
    in_targets = False
    current: str | None = None
    section: str | None = None
    for raw in text.splitlines():
        line = raw.split(" #", 1)[0].rstrip() if not raw.lstrip().startswith("#") else ""
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        body = line.strip()
        if indent == 0:
            in_targets = body == "targets:"
            current = None
            continue
        if not in_targets:
            continue
        if indent == 2 and body.endswith(":"):
            current = body[:-1]
            targets.setdefault(current, {"sources": set(), "packages": set()})
            section = None
            continue
        if current is None:
            continue
        if indent == 4:
            section = body[:-1] if body.endswith(":") else None
            continue
        if indent == 6 and body.startswith("- "):
            item = body[2:].strip()
            if section == "sources":
                path = item[len("path:"):].strip() if item.startswith("path:") else item
                targets[current]["sources"].add(path.strip("'\"").split("/")[0])
            elif section == "dependencies" and item.startswith("package:"):
                targets[current]["packages"].add(item[len("package:"):].strip())
    return targets


def linking_violations(
    targets: dict[str, dict[str, set[str]]],
    needing: dict[str, list[str]],
) -> list[str]:
    """Targets that compile a Core-using file but do not link the package.

    `needing` maps a consumer top-level directory to the files in it that
    import or name Core. A file in `Shared/` is compiled into the app, the
    widget and the share extension, so every one of them must link Core; an
    import alone does not make the module available, and the failure is
    "no such module 'GradeThreadCore'" on the target that forgot it.
    """
    out: list[str] = []
    for name, spec in sorted(targets.items()):
        if CORE_PACKAGE in spec["packages"]:
            continue
        for root in sorted(spec["sources"]):
            files = needing.get(root)
            if files:
                shown = ", ".join(files[:3]) + (" ..." if len(files) > 3 else "")
                out.append(
                    f"{name} compiles {root}/ ({shown}), which uses GradeThreadCore, "
                    f"but project.yml does not give {name} `- package: {CORE_PACKAGE}`"
                )
    return out


def core_needing_files(names: set[str], files: list[Path]) -> dict[str, list[str]]:
    """Consumer files that import Core or name a Core type, grouped by root dir."""
    word = re.compile(r"\b(" + "|".join(sorted(map(re.escape, names))) + r")\b") if names else None
    out: dict[str, list[str]] = {}
    for f in files:
        raw = f.read_text(encoding="utf-8")
        code = strip_comments_and_strings(raw)
        declared = set(
            re.findall(r"\b(?:enum|struct|class|protocol|actor|typealias)\s+([A-Za-z_]\w*)", code)
        )
        uses = bool(word and (set(word.findall(code)) - declared))
        if IMPORT_CORE.search(raw) or uses:
            rel = f.relative_to(IOS)
            out.setdefault(rel.parts[0], []).append(rel.as_posix())
    return out


def self_check_linking() -> None:
    """A widget file using Core must fail when the widget does not link Core."""
    yml = (
        "name: X\n"
        "targets:\n"
        "  App:\n"
        "    sources:\n"
        "      - path: App\n"
        "      - path: Shared   # shared helpers\n"
        "    dependencies:\n"
        "      - package: GradeThreadCore\n"
        "        product: GradeThreadCore\n"
        "  Widget:\n"
        "    sources:\n"
        "      - path: Widget\n"
        "      - path: Shared\n"
        "    dependencies:\n"
        "      - package: Supabase\n"
        "schemes:\n"
        "  App:\n"
        "    build:\n"
    )
    targets = parse_targets(yml)
    if targets.get("Widget", {}).get("sources") != {"Widget", "Shared"} or targets.get(
        "App", {}
    ).get("packages") != {"GradeThreadCore"}:
        print(f"check-core-imports: self-check failed, parsed {targets}")
        sys.exit(2)
    bad = linking_violations(targets, {"Shared": ["Shared/Snap.swift"]})
    if len(bad) != 1 or not bad[0].startswith("Widget "):
        print(f"check-core-imports: linking self-check failed, got {bad}")
        sys.exit(2)
    if linking_violations(targets, {"App": ["App/A.swift"]}):
        print("check-core-imports: linking self-check flagged a target that links Core")
        sys.exit(2)


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
    files = consumer_files()
    bad = violations(names, files)
    if bad:
        print("These files use a GradeThreadCore type without `import GradeThreadCore`:")
        for f, used in bad:
            print(f"  {f.relative_to(REPO)}: {', '.join(used)}")

    self_check_linking()
    targets = parse_targets(PROJECT_YML.read_text(encoding="utf-8"))
    if not targets:
        print(f"check-core-imports: no targets parsed out of {PROJECT_YML.relative_to(REPO)}")
        return 2
    unlinked = linking_violations(targets, core_needing_files(names, files))
    if unlinked:
        print("These targets compile GradeThreadCore users but do not link the package:")
        for line in unlinked:
            print(f"  {line}")

    if bad or unlinked:
        return 1
    print(
        f"check-core-imports: {len(names)} Core types, every consumer imports the package "
        f"and every target compiling one links it ({len(targets)} targets read)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
