#!/usr/bin/env python3
"""Fail when a SwiftUI view carries more than one `.sheet` modifier.

WHY THIS IS A GUARD AND NOT A STYLE NOTE.

A view has ONE sheet slot. Writing

    someView
        .sheet(isPresented: $a) { A() }
        .sheet(isPresented: $b) { B() }

compiles, reads fine in review, and is undefined at runtime: the modifiers
compete for that one slot, and the ones that lose present and are torn down in
the same frame. To the person holding the phone the screen opens and closes on
its own, with nothing in the console and nothing in Sentry.

That is what happened to "Prospect an item" and "What's it worth?" — both were
the second and third sheet on views (Home and the Tools hub) that carried three
each. The Settings list carried nine. None of it was ever reported against the
sheet modifier, because the symptom looks like the module is broken rather than
the presentation.

The fix is always the same shape: one `Identifiable` enum naming the sheets, one
optional holding which is up, one `.sheet(item:)` switching over it. That also
states the mutual exclusion that was true all along — two of these could never
sensibly be on screen at once, and a pile of booleans said nothing about it.

WHAT COUNTS. Two `.sheet` modifiers in the SAME modifier chain: same
indentation, with only other modifiers (`.foo`) or closing braces between them.
Two sheets on genuinely different views — a row and its list, a parent and its
child — are fine and are not flagged. `.fullScreenCover` is a different
presentation kind and is left alone; one of each on a view works.
"""

import os
import re
import sys

SHEET = re.compile(r"\s*\.sheet\(")
ROOTS = ["GradeThread", "Shared", "ShareExtension", "GradeThreadWidget"]


def indent_of(line):
    return len(line) - len(line.lstrip())


def violations(path):
    lines = open(path, encoding="utf-8").read().split("\n")
    sheets = [(i, indent_of(line)) for i, line in enumerate(lines) if SHEET.match(line)]

    found = []
    for a in range(len(sheets)):
        first, indent = sheets[a]
        for b in range(a + 1, len(sheets)):
            second, indent2 = sheets[b]
            if indent2 != indent:
                continue
            # Same chain? Every line between them that sits at exactly this
            # indentation must be another modifier or a closing brace. Anything
            # else means a new view started and these are not siblings.
            same_chain = True
            for k in range(first + 1, second):
                line = lines[k]
                if not line.strip() or indent_of(line) != indent:
                    continue
                stripped = line.strip()
                if not (stripped.startswith(".")
                        or stripped.startswith("}")
                        or stripped.startswith("//")):
                    same_chain = False
                    break
            if same_chain:
                found.append((first + 1, second + 1, lines[first].strip(), lines[second].strip()))
            break  # only report each sheet against its nearest sibling
    return found


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(root)
    failures = []
    for top in ROOTS:
        for dirpath, _, files in os.walk(top):
            for name in files:
                if not name.endswith(".swift"):
                    continue
                path = os.path.join(dirpath, name).replace("\\", "/")
                for first, second, a, b in violations(path):
                    failures.append(
                        f"{path}:{second}: shares a sheet slot with line {first}\n"
                        f"    {a}\n"
                        f"    {b}"
                    )
    if failures:
        print("Views carrying more than one .sheet modifier:\n")
        for f in failures:
            print(f)
            print()
        print(f"{len(failures)} pair(s). Collapse each view's sheets into one "
              f".sheet(item:) over an Identifiable enum.")
        return 1
    print("check_chained_sheets: every view carries at most one .sheet modifier")
    return 0


if __name__ == "__main__":
    sys.exit(main())
