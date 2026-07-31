#!/usr/bin/env python3
"""US-1391 — fail CI if any app source logs without a build-type gate.

The Android half of the iOS `no-ungated-print.py` guard (US-698), and for the
same reason: a release build must not write to the device log. A stray
`Log.d(TAG, response)` can put a session token, a signed storage URL, or a
seller's address into logcat, where any app with READ_LOGS on a rooted device
and every bug-report capture can read it. `android.util.Log` is NOT stripped by
R8 unless a proguard rule removes it, so "it's only debug" is not true by
default.

The allowed shapes are:

    if (BuildConfig.LOGGING_ENABLED) Log.d(...)
    if (AppConfig.loggingEnabled) { Log.d(...) }

...and anything routed through Telemetry, which redacts.

Scans `app/src/main`, skipping tests. Exits non-zero listing every offender.

Run locally:  python3 android/scripts/no-ungated-log.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE_DIR = os.path.join(ROOT, "app", "src", "main")

# `Log.d(`, `Log.e(`, ... and bare `println(`. Matched anywhere on the line,
# not just at the start: `runCatching { Log.e(...) }` is the common shape.
LOG_RE = re.compile(r"\b(android\.util\.)?Log\s*\.\s*[vdiwe]\s*\(|(?<![.\w])println\s*\(")

# The gate, on the same line or an enclosing one.
GATE_RE = re.compile(r"BuildConfig\.LOGGING_ENABLED|AppConfig\.loggingEnabled")

# Not logging: a Compose/Room/serialization symbol that merely contains "Log".
FALSE_POSITIVE_RE = re.compile(r"\bLogin|\bLogger|Dialog|Catalog|Analog")


def gated_line_indices(lines):
    """0-based indices of lines inside a `if (LOGGING_ENABLED)` block.

    Brace-tracked rather than regex-matched, so a multi-line gated block counts
    as gated all the way to its closing brace. A single-statement gate with no
    braces covers only the following line.
    """
    gated = set()
    open_blocks = []  # depth at which each gate block was opened

    depth = 0
    for i, line in enumerate(lines):
        stripped = line.strip()
        opens_gate = GATE_RE.search(stripped) and stripped.startswith(("if ", "if("))

        # Everything inside a currently-open gate block.
        if open_blocks:
            gated.add(i)

        depth += line.count("{") - line.count("}")

        if opens_gate:
            if "{" in line:
                open_blocks.append(depth - 1)
            else:
                # Braceless single statement — the next line is the body.
                gated.add(i + 1)

        while open_blocks and depth <= open_blocks[-1]:
            open_blocks.pop()

    return gated


def scan(path):
    with open(path, "r", encoding="utf-8") as handle:
        lines = handle.read().splitlines()

    gated = gated_line_indices(lines)
    offenders = []
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("//") or stripped.startswith("*"):
            continue
        if not LOG_RE.search(line):
            continue
        if FALSE_POSITIVE_RE.search(line):
            continue
        if i in gated or GATE_RE.search(line):
            continue
        offenders.append((i + 1, stripped))
    return offenders


def main():
    if not os.path.isdir(SOURCE_DIR):
        print(f"no-ungated-log: {SOURCE_DIR} not found", file=sys.stderr)
        return 1

    failures = []
    for base, _dirs, files in os.walk(SOURCE_DIR):
        for name in files:
            if not name.endswith(".kt"):
                continue
            path = os.path.join(base, name)
            for line_no, text in scan(path):
                failures.append((os.path.relpath(path, ROOT), line_no, text))

    if not failures:
        print("no-ungated-log: OK")
        return 0

    print("no-ungated-log: ungated logging found\n", file=sys.stderr)
    for path, line_no, text in failures:
        print(f"  {path}:{line_no}: {text}", file=sys.stderr)
    print(
        "\nWrap it in `if (BuildConfig.LOGGING_ENABLED) { ... }`, or route it "
        "through Telemetry, which redacts.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
