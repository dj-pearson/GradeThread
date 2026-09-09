#!/usr/bin/env python3
"""Fail if a cached @Model isn't erased on sign-out.

WHY
---
The offline cache holds a signed-in seller's inventory, sales, expenses,
sourcing log and mileage. Sign-out has to erase all of it, because the next
person to sign in on that device must not find any of it. The list of what to
erase used to be typed out by hand in ContentView, next to a schema that
already had the same list.

US-3100 is what that cost: `LocalSourcer` was registered in the schema and
erased by neither the sign-out path nor the workspace switch, so the previous
workspace's roster of the people who source for you stayed readable to the
next one. Nothing failed, nothing logged; the rows were simply still there.

`LocalCacheWipe` now owns the list. This script is what keeps it equal to the
schema's: every type in `GradeThreadSchemaV1.models` must have a deleter in
`LocalCacheWipe.deleters`, and vice versa. A new `@Model` added to the cache
therefore cannot ship without also being erased.

It is a NAME comparison over two literal lists, which is exactly why the
deleters are spelled out one per line rather than derived from a
`[any PersistentModel.Type]` — a derived list would be unreadable to a scan,
and the point is that the two lists are checkable.
"""

from __future__ import annotations

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = os.path.join(ROOT, "GradeThread", "Persistence", "GradeThreadSchema.swift")
WIPE = os.path.join(ROOT, "GradeThread", "Persistence", "LocalCacheWipe.swift")

# `        LocalSale.self,` inside GradeThreadSchemaV1.models
SCHEMA_MODEL_RE = re.compile(r"^\s*(Local[A-Za-z0-9_]+)\.self,\s*$", re.MULTILINE)
# `        ("LocalSale", { try $0.delete(model: LocalSale.self) }),`
DELETER_RE = re.compile(
    r'\(\s*"(Local[A-Za-z0-9_]+)"\s*,\s*\{\s*try\s+\$0\.delete\(model:\s*(Local[A-Za-z0-9_]+)\.self\)\s*\}\s*\)'
)


def schema_models(src: str) -> list[str]:
    """The types listed in GradeThreadSchemaV1.models, and only those.

    Bounded by the enum's closing brace, not by the first `]`: the property's
    own return type is `[any PersistentModel.Type]`, so slicing to the first
    bracket read an empty list and the gate reported the file had changed shape
    when it had not.
    """
    start = src.index("enum GradeThreadSchemaV1")
    body = src[start:]
    block = body[body.index("static var models"):]
    end = block.find("\n}")
    if end != -1:
        block = block[:end]
    return SCHEMA_MODEL_RE.findall(block)


def main() -> int:
    for path in (SCHEMA, WIPE):
        if not os.path.isfile(path):
            print(f"ERROR: {os.path.relpath(path, ROOT)} is missing.", file=sys.stderr)
            return 2

    with open(SCHEMA, encoding="utf-8") as handle:
        schema_src = handle.read()
    with open(WIPE, encoding="utf-8") as handle:
        wipe_src = handle.read()

    models = schema_models(schema_src)
    pairs = DELETER_RE.findall(wipe_src)
    deleters = [name for name, _ in pairs]

    # A gate that reads nothing passes forever.
    if len(models) < 5 or len(deleters) < 5:
        print(
            f"ERROR: read {len(models)} schema model(s) and {len(deleters)} deleter(s) "
            "- one of the two files changed shape and this gate stopped reading it.",
            file=sys.stderr,
        )
        return 2

    problems: list[str] = []

    # The label and the type it deletes must agree, or a partial-failure report
    # would name the wrong model.
    for label, deleted in pairs:
        if label != deleted:
            problems.append(f'deleter labelled "{label}" actually deletes {deleted}')

    for missing in [m for m in models if m not in deleters]:
        problems.append(
            f"{missing} is in the schema but LocalCacheWipe never deletes it - "
            "it would survive sign-out on a shared device"
        )
    for extra in [d for d in deleters if d not in models]:
        problems.append(
            f"{extra} is deleted by LocalCacheWipe but is not in the schema - "
            "either the model was removed and this is dead, or the schema is missing it"
        )

    if problems:
        print("ERROR: the cache wipe and the schema disagree:", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        print(
            "\nAdd the model to `deleters` in "
            "ios/GradeThread/Persistence/LocalCacheWipe.swift (and to "
            "`keptOnWorkspaceSwitch` / `localOnly` there if it belongs in "
            "either). A cached model nobody erases is the previous account's "
            "data on the next person's screen.",
            file=sys.stderr,
        )
        return 1

    print(f"check-cache-wipe: all {len(models)} cached model(s) are erased on sign-out")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
