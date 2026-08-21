#!/usr/bin/env python3
"""Fail when a service that calls an AI-inference route uses the short session.

WHAT THIS IS ABOUT.

Two URLSessions serve the edge. `EdgeNetwork.shared` (and `EdgeAPI.shared`)
gives up after 20 seconds of silence on the wire, which is right for ordinary
request/response traffic and is the reason a stalled call fails fast instead of
hanging behind a spinner. `EdgeNetwork.aiSession` (and `EdgeAPI.aiShared`) waits
two minutes, because an AI route does its work server-side and sends NOTHING
back until the JSON is ready — the connection is legitimately idle the whole
time, so a short idle timeout is exactly the wrong instrument.

Put an AI route on the short session and it fails EVERY time, in the worst way:
the server finishes the work, bills the seller's AI quota for it, and the app
shows a network error. Nothing in the edge log says the request failed, because
from the server's side it did not.

That is what happened to ScoutAI. A scan grades up to eight listings; one shadow
grade is two model calls and lands around 15-25 seconds, so a scan could not
finish inside 20 seconds even on its first candidate. It had been on the short
session since US-1407, a sweep that was fixing hangs and did not yet have the AI
session to sweep towards. Item Prospecting was on it for the same reason.

WHAT COUNTS. A Swift file that mentions one of the AI route paths below must
also mention `aiSession` or `aiShared`. It is a coarse check on purpose: the
question "does this file talk to a model?" has an answer a regex can find, and a
false positive costs one line of thought while a false negative costs a feature.
"""

import os
import re
import sys

# Edge routes where the server runs a model before it answers.
# Listed one by one rather than by prefix: /api/flipdesk/ai/log is under the same
# prefix and is an ordinary logging PATCH, which belongs on the SHORT session.
AI_ROUTES = [
    "/api/flipdesk/ai/extract",
    "/api/flipdesk/ai/size",
    "/api/flipdesk/ai/listing-copy",
    "/api/flipdesk/ai/negotiate",
    "/api/flipdesk/ai/analytics-narrative",
    "/api/grade/snap",            # Snap-to-Value
    "/api/flipdesk/scout",        # the ScoutAI scan, and /scout/prospect beneath it
]

# The sessions that wait long enough for one.
#
# Matched against CODE ONLY. The first cut of this guard scanned the whole file,
# and the comment explaining why ScoutService must use `aiSession` was enough to
# satisfy it - so the guard passed on the exact bug it was written for. A guard a
# comment can satisfy is not a guard.
AI_SESSIONS = re.compile(r"\baiSession\b|\baiShared\b")


def code_only(src):
    """The source with comments stripped, so prose cannot satisfy a check."""
    out = []
    in_block = False
    for line in src.split("\n"):
        if in_block:
            end = line.find("*/")
            if end == -1:
                continue
            line = line[end + 2:]
            in_block = False
        start = line.find("/*")
        if start != -1:
            end = line.find("*/", start + 2)
            if end == -1:
                in_block = True
                line = line[:start]
            else:
                line = line[:start] + line[end + 2:]
        slash = line.find("//")
        if slash != -1:
            line = line[:slash]
        out.append(line)
    return "\n".join(out)

ROOTS = ["GradeThread", "Shared", "ShareExtension"]

# Files that name a route without being the thing that calls it.
EXEMPT = {
    # /api/flipdesk/scout/buy commits a prospected item into inventory. It is an
    # ordinary insert with no model behind it, and it shares this file with the
    # prospect call, which does use the AI session.
}


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
                if path in EXEMPT:
                    continue
                src = code_only(open(path, encoding="utf-8").read())
                hits = [r for r in AI_ROUTES if r in src]
                if not hits:
                    continue
                # A file that only mentions a route inside a comment is still
                # worth a look, but only flag it when it actually builds a
                # request — the tell is a URLSession or an EdgeAPI instance.
                if not re.search(r"URLSession|EdgeAPI", src):
                    continue
                if AI_SESSIONS.search(src):
                    continue
                failures.append(f"{path}: calls {', '.join(hits)} without aiSession/aiShared")

    if failures:
        print("AI-inference calls on the 20s-idle session:\n")
        for f in failures:
            print("  " + f)
        print(
            "\nThese routes stream nothing until the model finishes, so the short idle\n"
            "timeout kills a request the SERVER completed and billed. Use\n"
            "EdgeNetwork.aiSession (or EdgeAPI.aiShared) instead."
        )
        return 1
    print("check-ai-session: every AI-route caller uses the long-idle session")
    return 0


if __name__ == "__main__":
    sys.exit(main())
