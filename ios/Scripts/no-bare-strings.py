#!/usr/bin/env python3
r"""US-1224 — advisory guard against NEW bare UI string literals in the small set
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
import json
import os
import re
import sys

# The offenders this script prints are UI copy, so they carry the ellipsis, the
# arrow and the middle dot that real product text carries. On a Windows console
# (cp1252) printing one raises UnicodeEncodeError, and the developer sees a
# traceback where the offender list should be — which is how a red lane went five
# days without anyone reading past the first line. CI is UTF-8 either way; this
# is purely so the failure is legible where it is most likely to be ignored.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# US-1155: the String Catalog that build-time loc-string extraction
# (SWIFT_EMIT_LOC_STRINGS=YES) populates. Validated here so a corrupted/renamed
# catalog fails CI on this fast lane rather than only at xcodebuild time.
CATALOG = os.path.join(ROOT, "GradeThread", "Localizable.xcstrings")

# Tiny "migrated" set. Prospect is the most recently reworked UI surface
# (US-1170/1225/1224); Vision + Speech are logic-only (zero literals today) and
# included so any UI text added there is caught from the first line.
SCOPE_DIRS = [
    os.path.join("GradeThread", "Prospect"),
    os.path.join("GradeThread", "Vision"),
    os.path.join("GradeThread", "Speech"),
    # US-1155 widened the localization migration to the Settings priority flow.
    # Its existing literals are baselined below; NEW Settings UI text must go
    # through a localized key (or the BASELINE be updated) or CI fails here.
    os.path.join("GradeThread", "Settings"),
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
    # Prospect / Vision / Speech (US-1224 baseline).
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
    "Take photo",
    # ── US-2923 (2026-08-26): point-shoot-correct in Prospect ────────────────
    #
    # Acknowledged rather than translated, for the reason spelled out in the
    # Thrift Radar block below: Localizable.xcstrings is still empty, so a
    # "localized key" and a bare SwiftUI literal are the same artifact today.
    #
    # FIVE ENTRIES WERE REMOVED HERE, not just added. "Add the front + the tag",
    # the old "Snap the item and its brand/size tag…" copy, "Sells ", "est. "
    # and "going rate · range " no longer appear in any scoped file — the photo
    # strip became two named slots, and the price and sell-through lines were
    # reworded to stop a formula reading as a measurement. A baseline nobody
    # prunes stops being a record of what is there and becomes a record of what
    # once was, which is how the stale half hides a real regression.
    "Correct the title and pull fresh comps",
    "Edit title",
    "Keeps your condition grade and photos. No AI charge.",
    "Re-pull comps",
    "Remove ",
    # ── US-3026 (2026-08-30): the sold-comps search terms are on screen ───────
    #
    # Two entries, both about the same complaint: the link said "See sold comps
    # on eBay" and nothing else, so when the identification was thin it opened
    # the completed search for the brand alone and there was nothing on the card
    # to say so. Baselined on the same grounds as the block below - the catalog
    # is populated at build time on the Mac and is not committed, so a "localized
    # key" and a bare SwiftUI literal are still the same artifact.
    "Searching: ",
    "Sold comps search terms: ",
    "Snap the item, and its tag if it has one. We'll identify it and pull eBay "
    "comps: how many are listed, what they're asking, and how fast it should "
    "move. Got the wrong item? Tap the title to fix it.",
    # Settings priority flow (US-1155 baseline). "" = an interpolation-only
    # Text("\\(…)") whose static prefix is empty.
    "",
    "AI Item Assistant",
    "AI fills in brand, size, material, and more from your photos. Turn it off "
    "to skip AI suggestions, or set a monthly action cap to control usage.",
    "AI suggestions",
    "Buy grade credits or change your plan with “See plans & credits” above.",
    "Buy grade credits or change your plan with “See plans & credits” above. "
    "View past invoices on the web.",
    "Choose a new password with at least ",
    "Claim your public profile — buyers can see your verified grades and stats.",
    "Couldn't load AI usage.",
    "Couldn't load your plan.",
    "Data",
    "Deleting your account permanently removes your inventory, photos, listings, "
    "sales, and marketplace connections from GradeThread. Listings already live "
    "on eBay are not affected and must be ended there.",
    "Diagnostics",
    "Downloads a JSON file with your profile, submissions, grades, inventory, "
    "listings, and sales.",
    "Export my data",
    "Grading plan",
    "Invite friends",
    "Invite teammates to your workspace and manage their access.",
    "Manage plan & billing",
    "Manage subscription",
    "Monthly cap",
    "Password updated",
    "Plan & credits",
    "Probes your Supabase connection. Tap, wait, then long-press the result to "
    "copy it and paste it back to support.",
    "Resets at the start of next month.",
    "Run connection test",
    "Save name",
    "Saved",
    "See plans & credits",
    "Share your code — you both earn a reward when a friend grades their first item.",
    "Team",
    "This can't be undone",
    "Type ",
    "Used this month",
    "Verified seller",
    # ── Thrift Radar (US-1866, added 2026-08-07; baselined 2026-08-12) ────────
    #
    # THIS LANE WAS RED ON MAIN FOR FIVE DAYS and nothing in the backlog said so.
    # US-1866 dropped RadarNearbyView.swift into Prospect, which is IN SCOPE, and
    # never updated this set — so every iOS CI run since has failed at this step,
    # after the simulator build, which is the slowest possible place to learn it.
    # Writing that down rather than quietly appending: a baseline that grows
    # without anyone noticing the red run has stopped being a review checkpoint.
    #
    # These are baselined rather than rewritten because there is no other option
    # in this repo today — Localizable.xcstrings has ZERO entries, so not one
    # string in this file has ever been translated, including the US-1224 and
    # US-1155 ones above. `SWIFT_EMIT_LOC_STRINGS=YES` populates the catalog at
    # build time on the Mac and the result is not committed. So "localize via a
    # string key" currently means the same thing as a bare SwiftUI literal, and
    # what this guard actually buys is a human acknowledging new UI copy.
    "A store appears once ",
    "Averages ",
    "Brand mix",
    "Condition found here",
    "Empty radar near you?",
    "Estimated grades from field scans, not certified grades.",
    "Hotness, brand mix and busy days come from everyone else's scans. Your own "
    "stores and your own numbers stay on this list on every plan.",
    "Loading your stores…",
    "Loading…",
    "Location is off for GradeThread. Turn it on in iOS Settings → Privacy → "
    "Location Services to sort by what is near you. Radar still works without it.",
    "Nearby",
    "Nothing on the radar here yet",
    "Only brands enough different people have scanned appear here. A brand "
    "missing from this list is not a brand missing from the store.",
    "Share your location to look around you, or link a source to a store on the "
    "web so your own places show up here.",
    "The shared map is on Pro",
    "These have your money in them but no place yet. Link one on the web "
    "(FlipDesk → My stores) and it joins this list.",
    "Weighted toward ",
    "When it is busy",
    "Window",
    "Your history here",
    "Your own numbers, on every plan. They are not part of the shared map.",
    "Your store · nothing shared about this place yet",
    "Your stores that are not on the map",
    # US-2671 two-factor enrollment (TwoFactorSheet). Added rather than
    # localized because iOS ships English-only today (US-2499 holds the
    # decision); these move into the catalog with the rest of Settings.
    "Add a one-time code from an authenticator app (Google Authenticator, "
    "1Password, Authy) as a second factor when you sign in. If your workspace "
    "owner requires it, you need this to keep working in their workspace.",
    "Cancel setup",
    "Codes change every 30 seconds. Enter the one showing now.",
    "Confirm this session",
    "Confirm this session with a code before you can turn it off.",
    "Open your authenticator app and scan the code. Can't scan? Enter the key "
    "below by hand.",
    "Signing in with your password alone doesn't satisfy a workspace that "
    "requires two-factor authentication. Enter a code once per sign-in to "
    "unlock it, and to change this setting.",
    "Step 1: scan this",
    "Step 2: confirm",
    "Turn off two-factor authentication",
    "Two-factor authentication is off.",
    "Two-factor authentication is on.",
    "You'll be asked for a code from your authenticator app. Recovery codes "
    "are managed on gradethread.com. Keep them somewhere other than this phone.",
    "Your account goes back to a password only. If your workspace owner "
    "requires two-factor authentication, you'll be locked out of their "
    "workspace.",
})


def check_catalog():
    """Yield problems if the US-1155 String Catalog is missing or malformed."""
    rel = os.path.relpath(CATALOG, ROOT)
    if not os.path.exists(CATALOG):
        return [f"{rel}: String Catalog is missing — required so build-time "
                f"loc-string extraction has somewhere to land (US-1155)."]
    try:
        with open(CATALOG, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as exc:
        return [f"{rel}: not valid JSON ({exc})."]
    problems = []
    if data.get("sourceLanguage") != "en":
        problems.append(f"{rel}: sourceLanguage must be 'en'.")
    if not isinstance(data.get("strings"), dict):
        problems.append(f"{rel}: missing a 'strings' object.")
    return problems


def main():
    catalog_problems = check_catalog()

    offenders = []
    for rel, line_no, raw, prefix in all_hits():
        if prefix not in BASELINE:
            offenders.append(f"{rel}:{line_no}: {raw}")

    if catalog_problems:
        print("String Catalog check FAILED (US-1155):")
        for p in catalog_problems:
            print(f"  {p}")
    if offenders:
        print("New bare UI string literal(s) in a migrated directory "
              "(localize via a string key, or update BASELINE in this script):")
        for o in offenders:
            print(f"  {o}")
    if catalog_problems or offenders:
        return 1
    print("OK: String Catalog valid; no new bare UI string literals in "
          "migrated directories.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
