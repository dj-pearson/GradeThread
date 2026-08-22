#!/usr/bin/env python3
"""Fail on a trailing comma in a parameter or argument list.

Swift allows this from 6.1. This target builds at SWIFT_VERSION 5.9, where it is
a PARSE error - and a parse error is the worst kind to learn about late, because
the compiler reports it as a bare "Unexpected ',' separator" with no file and no
line. That is exactly how it reached CI: the message in the log named no source
file, and the surrounding lines were whichever files happened to be compiling.

It is an easy one to write, because every other language the same person touches
in a day allows it, and because a formatter will happily leave it in place.

WHAT COUNTS. A line ending in a comma whose next non-blank, non-comment line
starts with a closing paren or bracket. That is the shape in both positions that
matter - a declaration's parameter list and a call's argument list - and it does
not fire on a comma inside a collection literal spread over lines, which Swift
has always allowed.
"""

import os
import re
import sys

ROOTS = ["GradeThread", "Shared", "ShareExtension", "GradeThreadWidget", "GradeThreadTests"]

# A closing paren/bracket, optionally followed by a return arrow, a chained call,
# or a trailing closure - i.e. the end of a parameter or argument list.
CLOSER = re.compile(r"^\s*[)\]]")
# Collection and array literals legitimately take a trailing comma in Swift.
LITERAL_OPEN = re.compile(r"[\[(]\s*$")


def violations(path):
    lines = open(path, encoding="utf-8").read().split("\n")
    found = []
    for i, line in enumerate(lines):
        code = line.split("//")[0].rstrip()
        if not code.endswith(","):
            continue
        # Next line that carries code.
        j = i + 1
        while j < len(lines) and (not lines[j].strip() or lines[j].strip().startswith("//")):
            j += 1
        if j >= len(lines):
            continue
        nxt = lines[j]
        if not CLOSER.match(nxt):
            continue
        # `]` closes an array/dictionary literal, where the trailing comma is legal.
        if nxt.strip().startswith("]"):
            continue
        found.append((i + 1, code.strip()[:80], nxt.strip()[:40]))
    return found


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(root)
    failures = []
    for top in ROOTS:
        if not os.path.isdir(top):
            continue
        for dirpath, _, files in os.walk(top):
            for name in files:
                if not name.endswith(".swift"):
                    continue
                path = os.path.join(dirpath, name).replace("\\", "/")
                for line, code, nxt in violations(path):
                    failures.append(f"{path}:{line}: trailing comma before `{nxt}`\n      {code}")

    if failures:
        print("Trailing comma in a parameter/argument list (Swift 6.1+ only; this target is 5.9):\n")
        for f in failures:
            print("  " + f)
        print(
            "\nThe compiler reports this as a bare \"Unexpected ',' separator\" with no file\n"
            "and no line. Drop the comma after the last item."
        )
        return 1
    print("no-trailing-comma: no trailing commas in parameter or argument lists")
    return 0


if __name__ == "__main__":
    sys.exit(main())
