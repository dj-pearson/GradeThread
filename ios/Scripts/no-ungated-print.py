#!/usr/bin/env python3
"""US-698 — fail CI if any non-test app source contains a `print(` that is not
inside a `#if DEBUG` compilation block.

Release builds must not log to the console: a stray `print(error)` can leak
tokens, signed-storage URLs, or PII into device logs / screen recordings. The
three legitimate diagnostic prints in the app are all wrapped in `#if DEBUG`;
this guard keeps it that way.

Scans the app targets (GradeThread / ShareExtension / GradeThreadWidget /
Shared), skipping the test target. Exits non-zero with the offending locations.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# US-2342: the scan scope lives in one place now. See _scan_scope.py for why
# no-bare-strings.py and check-ats.py deliberately do NOT import it.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _scan_scope import TARGET_DIRS  # noqa: E402

# A `print(` call that is the start of a statement (allowing leading whitespace).
PRINT_RE = re.compile(r"^\s*print\s*\(")


def debug_gated_lines(lines):
    """Return a set of 0-based line indices that compile only under DEBUG.

    Tracks #if / #elseif / #else / #endif nesting. A line is "debug-gated" when
    every enclosing conditional branch is a `#if DEBUG` (true) branch.
    """
    gated = set()
    # stack of bools: is the current active branch a DEBUG-only branch?
    stack = []
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("#if "):
            cond = stripped[len("#if "):].strip()
            stack.append(cond == "DEBUG")
            continue
        if stripped.startswith("#elseif "):
            if stack:
                cond = stripped[len("#elseif "):].strip()
                stack[-1] = (cond == "DEBUG")
            continue
        if stripped == "#else":
            if stack:
                # The #else branch of `#if DEBUG` is the NON-debug branch.
                stack[-1] = False
            continue
        if stripped.startswith("#endif"):
            if stack:
                stack.pop()
            continue
        if stack and all(stack):
            gated.add(i)
    return gated


def main():
    offenders = []
    for target in TARGET_DIRS:
        base = os.path.join(ROOT, target)
        for dirpath, _dirs, files in os.walk(base):
            for name in files:
                if not name.endswith(".swift"):
                    continue
                path = os.path.join(dirpath, name)
                with open(path, encoding="utf-8") as fh:
                    lines = fh.readlines()
                gated = debug_gated_lines(lines)
                for i, line in enumerate(lines):
                    if PRINT_RE.match(line) and i not in gated:
                        rel = os.path.relpath(path, ROOT)
                        offenders.append(f"{rel}:{i + 1}: {line.strip()}")

    if offenders:
        print("Ungated print() found in app sources (wrap in #if DEBUG):")
        for o in offenders:
            print(f"  {o}")
        return 1
    print("OK: no ungated print() in app sources.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
