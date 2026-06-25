#!/usr/bin/env python3
"""US-1224 — advisory guard against NEW bare UI string literals in the small set
of directories that have begun the localization migration.

Full localization (US-1155) is DEFERRED, so this is INTENTIONALLY narrow: it does
NOT flag the ~670 bare strings across the whole app. It scans only ``SCOPE_DIRS``
(a tiny, deliberately-chosen "migrated" set) and allow-lists the literals that
exist there TODAY (``BASELINE``). The net effect: the existing strings pass, but
adding a NEW ``Text("…")`` / ``Label("…", …)`` first-argument string literal to a
scoped directory fails CI — nudging new UI text toward a localized string key as
the migration widens.

How a literal is identified: the FIRST argument of ``Text(`` / ``Label(`` when it
is a ``"…"`` string literal. For interpolated strings (``Text("Sold \(n)")``) we
compare on the STATIC PREFIX up to the first ``\(`` — stable across value edits.

To widen scope later: add a directory to ``SCOPE_DIRS``; to legitimately add a new
unlocalized string (or after refactoring an allow-listed one), update ``BASELINE``.

Exits non-zero with the offending locations; mirrors ``no-ungated-print.py``.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Tiny "migrated" set. Prospect is the most recently reworked UI surface
# (US-1170/1225/1224); Vision + Speech are logic-only (zero literals today) and
# included so any UI text added there is caught from the first line.
SCOPE_DIRS = [
    os.path.join("GradeThread", "Prospect"),
    os.path.join("GradeThread", "Vision"),
    os.path.join("GradeThread", "Speech"),
]

# Match `Text("…")` / `Label("…"` where the first arg opens with a string literal.
# Captures the literal body (handling escaped quotes) so we can take its static
# prefix.
LITERAL_RE = re.compile(r'\b(?:Text|Label)\(\s*"((?:[^"\\]|\\.)*)"')


def static_prefix(body: str) -> str:
    """Static text up to the first SwiftUI interpolation (`\\(`)."""
    idx = body.find(r"\(")
    return body if idx == -1 else body[:idx]


def collect(path):
    """Yield (line_no, raw_line, static_prefix) for each scoped literal in a file."""
    with open(path, encoding="utf-8") as fh:
        for i, line in enumerate(fh):
            for m in LITERAL_RE.finditer(line):
                yield i + 1, line.strip(), static_prefix(m.group(1))


def all_hits():
    for scope in SCOPE_DIRS:
        base = os.path.join(ROOT, scope)
        if not os.path.isdir(base):
            continue
        for dirpath, _dirs, files in os.walk(base):
            for name in files:
                if not name.endswith(".swift"):
                    continue
                path = os.path.join(dirpath, name)
                for line_no, raw, prefix in collect(path):
                    yield os.path.relpath(path, ROOT), line_no, raw, prefix


# Allow-list of static prefixes that exist in the scoped dirs at the time this
# guard was added (the migration baseline). KEEP SORTED. Any scoped literal whose
# static prefix is NOT here is treated as NEW.
BASELINE = frozenset({
    "Add the front + the tag",
    "Add to inventory",
    "Added — view inventory",
    "Based on ",
    "Couldn't identify the item",
    "Enter your cost for a buy / skip verdict and ROI.",
    "Est. grade ",
    "Library",
    "Not enough comps to price yet",
    "Only ",
    "Re-run to apply this cost to the buy / skip verdict.",
    "See sold comps on eBay",
    "Sells ",
    "Snap the item and its brand/size tag. We'll identify it and pull eBay comps "
    "— how many are out there, the going rate, and how fast it sells.",
    "Take photo",
    "est. ",
    "going rate · range ",
})


def main():
    offenders = []
    for rel, line_no, raw, prefix in all_hits():
        if prefix not in BASELINE:
            offenders.append(f"{rel}:{line_no}: {raw}")

    if offenders:
        print("New bare UI string literal(s) in a migrated directory "
              "(localize via a string key, or update BASELINE in this script):")
        for o in offenders:
            print(f"  {o}")
        return 1
    print("OK: no new bare UI string literals in migrated directories.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
