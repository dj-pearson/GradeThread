#!/usr/bin/env python3
"""Fail if a UserDefaults key isn't classified as account- or device-scoped.

WHY
---
Sign-out on a shared device has to leave nothing of the previous seller behind.
The teardown in ContentView is long and careful — SwiftData cache, mutation
queue, drafts, recent searches, saved filters, exports, thumbnail caches, edge
response cache, push token, sync watermarks — and `UserDefaults` was simply not
part of it.

So the next account inherited the previous seller's currency and sourcing
budget (every money screen denominated in someone else's currency), their
onboarding answers, a plan checkout carrying another person's email address, a
radar-contribution consent given by somebody else, and a snoozed reconcile
badge that muted the new user's own unreconciled orders.
`ReconcileBadgeStore.reset()` had been written for that last one in US-1262,
with a comment saying "e.g. on sign-out", and nothing ever called it.

That is not one oversight, it is the absence of a decision point. This script is
the decision point: every `UserDefaults` key constant in the app must appear in
exactly one list in `AccountScopedDefaults` —

  * `accountScopedKeys`   — wiped on sign-out
  * `deviceScopedKeys`    — deliberately kept, with the reason
  * `clearedElsewhereKeys`— another teardown path owns it, named

— so adding a key forces the author to say which it is.

WHAT COUNTS AS A KEY
--------------------
A `com.gradethread...` string literal in a file that touches `UserDefaults`,
minus the ones that are demonstrably something else: notification names (used
with `Notification.Name`), dispatch queue labels, keychain services and App
Store product identifiers all share the reverse-DNS prefix. Those are excluded
by name below, each with a reason, rather than by a clever heuristic that would
quietly start excluding real keys.
"""

from __future__ import annotations

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "GradeThread")
REGISTRY = os.path.join(APP, "Persistence", "AccountScopedDefaults.swift")

KEY_LITERAL_RE = re.compile(r'"(com\.gradethread\.[A-Za-z0-9._-]+)"')
SECTION_END = "\n    ]"
LIST_ENTRY_RE = re.compile(r'"(com\.gradethread\.[A-Za-z0-9._-]+)"')

# Reverse-DNS strings in a UserDefaults-touching file that are NOT defaults
# keys. Each says what it actually is.
NOT_A_DEFAULTS_KEY = {
    "com.gradethread.app.deepLink": "Notification.Name for the deep-link post",
    "com.gradethread.app.localSaveFailed": "Notification.Name from PersistenceHealth",
    "com.gradethread.app.workspaceDidChange": "Notification.Name",
    "com.gradethread.app.workspaceAccessRevoked": "Notification.Name",
    "com.gradethread.app.workspaceMfaRequired": "Notification.Name",
    "com.gradethread.app.entitlementsDidChange": "Notification.Name",
    "com.gradethread.app.onboardingDidFinish": "Notification.Name",
    "com.gradethread.app.onboardingReplayRequested": "Notification.Name",
    "com.gradethread.app.refresh": "BGTaskScheduler identifier",
    "com.gradethread.app.photo-uploads": "URLSession background identifier",
    "com.gradethread.app.photo-draft-io": "DispatchQueue label",
    "com.gradethread.app.auth": "Keychain service",
    "com.gradethread.app.apple-credential": "Keychain service",
    "com.gradethread.app.shortcut.prospect": "UIApplicationShortcutItem type",
    "com.gradethread.app.shortcut.addItem": "UIApplicationShortcutItem type",
    "com.gradethread.app.shortcut.scout": "UIApplicationShortcutItem type",
    "com.gradethread.app.pendingDelistsRequested": "Notification.Name",
    "com.gradethread.app.ebayReconnectRequested": "Notification.Name",
    # Prefixes, not whole keys — the per-table/per-flag suffix is appended.
    "com.gradethread.app.syncWatermark.": "key PREFIX; the versioned key is listed",
    "com.gradethread.app.flagOverride.": "debug-only feature-flag override prefix",
}


def read(path: str) -> str:
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def registry_keys(src: str) -> tuple[set[str], set[str], set[str]]:
    def section(name: str) -> set[str]:
        # Bounded by the literal's own closing bracket, not by the first "]"
        # after the name: the declared TYPE is `[String]` / `[String: String]`,
        # so slicing to the first bracket reads an empty list. The same mistake
        # in check-cache-wipe.py made that gate report the file had changed
        # shape when it had not; here the classified-count floor caught it.
        start = src.index(name)
        open_bracket = src.index("= [", start) + len("= [")
        end = src.index(SECTION_END, open_bracket)
        return set(LIST_ENTRY_RE.findall(src[open_bracket:end]))

    return (
        section("static let accountScopedKeys"),
        section("static let deviceScopedKeys"),
        section("static let clearedElsewhereKeys"),
    )


def main() -> int:
    if not os.path.isfile(REGISTRY):
        print("ERROR: AccountScopedDefaults.swift is missing.", file=sys.stderr)
        return 2

    registry_src = read(REGISTRY)
    account, device, elsewhere = registry_keys(registry_src)
    classified = account | device | elsewhere

    if len(classified) < 20:
        print(
            f"ERROR: only {len(classified)} key(s) read out of the registry - it "
            "changed shape and this gate stopped reading it.",
            file=sys.stderr,
        )
        return 2

    found: dict[str, str] = {}
    scanned = 0
    for dirpath, _dirnames, filenames in os.walk(APP):
        for name in filenames:
            if not name.endswith(".swift"):
                continue
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, ROOT).replace(os.sep, "/")
            if rel.endswith("Persistence/AccountScopedDefaults.swift"):
                continue
            src = read(path)
            if "UserDefaults" not in src:
                continue
            scanned += 1
            for key in KEY_LITERAL_RE.findall(src):
                found.setdefault(key, rel)

    if scanned < 5:
        print(
            f"ERROR: only {scanned} UserDefaults-touching file(s) scanned - the "
            "layout changed and this gate is no longer looking at the app.",
            file=sys.stderr,
        )
        return 2

    unclassified = [
        (key, where)
        for key, where in sorted(found.items())
        if key not in classified and key not in NOT_A_DEFAULTS_KEY
    ]
    # A classification that names a key nothing uses is stale, and a stale entry
    # is how a list stops describing the app.
    stale = sorted(k for k in classified if k not in found)

    if unclassified or stale:
        print("ERROR: the sign-out classification and the app disagree:", file=sys.stderr)
        for key, where in unclassified:
            print(f"  {key} ({where}) is not classified", file=sys.stderr)
        for key in stale:
            print(f"  {key} is classified but no source uses it", file=sys.stderr)
        print(
            "\nPut the key in one of accountScopedKeys / deviceScopedKeys / "
            "clearedElsewhereKeys in "
            "ios/GradeThread/Persistence/AccountScopedDefaults.swift, with the "
            "reason. If it isn't a defaults key at all (a Notification.Name, a "
            "queue label, a keychain service), add it to NOT_A_DEFAULTS_KEY in "
            "this script saying what it is. An account key nobody clears is the "
            "previous seller's currency on the next seller's screen.",
            file=sys.stderr,
        )
        return 1

    print(
        f"check-signout-defaults: {len(classified)} key(s) classified across "
        f"{scanned} file(s); none unclassified or stale"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
