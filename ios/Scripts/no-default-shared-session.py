#!/usr/bin/env python3
"""US-1407 — fail CI if any app-source network service defaults a `URLSession`
parameter to `.shared`.

Background: `URLSession.shared` defaults to a 60s per-request timeout. On flaky
cellular a stalled request hangs ~60s behind a spinner — the dominant App Review
rejection pattern ("screen fails to load / spins forever"). A prior sweep moved
the concrete `URLSession.shared` *call-sites* onto the bounded `EdgeNetwork`
sessions, but missed the DEFAULT-ARGUMENT form:

    init(..., session: URLSession = .shared)        # <-- the bug signature

which silently reintroduces the 60s session for every caller that doesn't pass
one. This guard bans that form so the class can't regress. Use
`EdgeNetwork.shared` (bounded, 20s idle) for normal edge/storage traffic, or
`EdgeNetwork.aiSession` for slow `/ai/*` inference calls.

Scans the app targets, skipping the test target (tests legitimately inject
`URLSession.shared` or a mock). Exits non-zero with the offending locations.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET_DIRS = ["GradeThread", "ShareExtension", "GradeThreadWidget", "Shared"]

# A default argument of `.shared` (or `URLSession.shared`) on a parameter typed
# `URLSession`. Tolerates spacing variations:
#   session: URLSession = .shared
#   session: URLSession = URLSession.shared
DEFAULT_SHARED_RE = re.compile(
    r":\s*URLSession\s*=\s*(?:URLSession\.)?\.?shared\b"
)


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
                    for i, line in enumerate(fh):
                        if DEFAULT_SHARED_RE.search(line):
                            rel = os.path.relpath(path, ROOT)
                            offenders.append(f"{rel}:{i + 1}: {line.strip()}")

    if offenders:
        print(
            "Default `URLSession = .shared` argument found (use EdgeNetwork.shared "
            "/ EdgeNetwork.aiSession — see US-1407):"
        )
        for o in offenders:
            print(f"  {o}")
        return 1
    print("OK: no default `URLSession = .shared` arguments in app sources.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
