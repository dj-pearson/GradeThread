#!/usr/bin/env python3
"""Fail CI if any app source uses a force `try!` or force cast `as!`.

Both crash the app at runtime on the unhappy path — `try!` on any thrown error,
`as!` on a type mismatch — with no chance to recover or surface a friendly
message. The app currently has ZERO of either (verified in code review); this
guard keeps it that way. Use `try?` / do-catch / `try` and `as?` + guard/if-let.

Runs on Linux/Windows (pure Python) — a Mac-free companion to the macOS-only
`xcodebuild` gate. Scans the app targets (not the test target, where `try!` in
fixtures is acceptable). Comments and string literals are stripped first so a
`try!` mentioned in a doc comment or a literal doesn't trip the guard.

Exit non-zero with the offending locations.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET_DIRS = ["GradeThread", "ShareExtension", "GradeThreadWidget", "Shared"]

# A force `try!` / force cast `as!` as a real operator (followed by whitespace or
# an opening paren/bracket), not part of a longer identifier.
FORCE_RE = re.compile(r"\b(try|as)!(?=[\s(\[])")

# Double-quoted string literals (incl. escapes) on a single line.
STRING_RE = re.compile(r'"(?:\\.|[^"\\])*"')
LINE_COMMENT_RE = re.compile(r"//.*$")


def strip_noise(lines):
    """Yield (line_no, cleaned_line) with block/line comments and string literals
    blanked out so matches inside them don't count. Best-effort: tracks `/* */`
    nesting and removes `"..."` and `//...` per line. Swift multiline `\"\"\"`
    strings are rare for these operators and left as residual risk."""
    in_block = False
    for i, raw in enumerate(lines):
        line = raw
        if in_block:
            end = line.find("*/")
            if end == -1:
                yield i, ""
                continue
            line = line[end + 2:]
            in_block = False
        # Remove inline /* ... */ (possibly opening an unterminated block).
        out = []
        while True:
            start = line.find("/*")
            if start == -1:
                break
            end = line.find("*/", start + 2)
            if end == -1:
                out.append(line[:start])
                line = ""
                in_block = True
                break
            line = line[:start] + " " + line[end + 2:]
        cleaned = "".join(out) + line
        cleaned = STRING_RE.sub('""', cleaned)
        cleaned = LINE_COMMENT_RE.sub("", cleaned)
        yield i, cleaned


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
                for i, cleaned in strip_noise(lines):
                    if FORCE_RE.search(cleaned):
                        rel = os.path.relpath(path, ROOT)
                        offenders.append(f"{rel}:{i + 1}: {lines[i].strip()}")

    if offenders:
        print("Force `try!` / `as!` found in app sources "
              "(use try?/do-catch and as?/guard):")
        for o in offenders:
            print(f"  {o}")
        return 1
    print("OK: no force try!/as! in app sources.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
