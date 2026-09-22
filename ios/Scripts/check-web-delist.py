#!/usr/bin/env python3
"""US-3281 — hold the in-app delist to the seven things its copy claims.

WHY THIS EXISTS
---------------
The iOS app can end a Poshmark or Mercari listing by showing the seller that
marketplace's own site in a ``WKWebView`` they signed into themselves. Whether
that is a person using a browser or an app reaching into Poshmark is decided by
seven properties of the build, written down in
``vault/10-ops/ios-webview-delist-app-review.md`` §3 and repeated to Apple in
``ios/fastlane/metadata/review_information/notes.txt``.

Every one of them is a sentence somebody could make false with a small, sensible
looking change: a "just cache the login so they don't have to type it" field, a
"run the queue on background refresh" convenience, a "fetch the selectors so we
can fix a breakage without a release" optimisation. None of those would fail a
build, none would look wrong in review, and each one turns a truthful App Review
submission into an untruthful one. A rejection under guideline 5.2.2 is resolved
by producing written authorization from the marketplace, which does not exist
and can never be fabricated, so this is not a cost anyone gets to pay later.

So the sentences are checked, here, on every verify.

US-3455 widened the scope to ``Marketplaces/WebList``, the sibling that FILLS
a create form and stops. Same seven properties, one more that is the list
flow's own: nothing in it clicks the marketplace's submit control.

WHAT IT CHECKS
--------------
1. No marketplace credential field anywhere in the delist sources.
2. Nothing scheduled ever starts a run.
3. No script or selector is fetched at runtime.
4. The web view uses the per-marketplace store, never the default one.
5. Sign-out erases those stores.
6. The consent screen carries the same risk sentence as the web.
7. The generated flow table is generated, not hand-edited.
8. The list flow never clicks the marketplace's submit control, and the web
   view is never hidden, shrunk to nothing or faded out.

Mirrors the exit contract of the other guards: non-zero with the offending
locations, one line of OK otherwise.
"""

from __future__ import annotations

import os
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
DELIST_DIR = os.path.join(ROOT, "GradeThread", "Marketplaces", "WebDelist")
LIST_DIR = os.path.join(ROOT, "GradeThread", "Marketplaces", "WebList")
CONTENT_VIEW = os.path.join(ROOT, "GradeThread", "ContentView.swift")
BACKGROUND_DIR = os.path.join(ROOT, "GradeThread", "Background")
GENERATED = os.path.join(DELIST_DIR, "DelistFlows.generated.swift")
LIST_GENERATED = os.path.join(LIST_DIR, "ListFlows.generated.swift")
WEB_DISCLOSURE = os.path.join(REPO, "src", "lib", "marketplace-disclosure.ts")

problems: list[str] = []


def read(path: str) -> str:
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def sources() -> list[tuple[str, str]]:
    out = []
    for directory in (DELIST_DIR, LIST_DIR):
        if not os.path.isdir(directory):
            continue
        for name in sorted(os.listdir(directory)):
            if name.endswith(".swift"):
                out.append((name, read(os.path.join(directory, name))))
    return out


def fail(message: str) -> None:
    problems.append(message)


for required_dir in (DELIST_DIR, LIST_DIR):
    if not os.path.isdir(required_dir):
        print(f"check-web-delist: {required_dir} is missing", file=sys.stderr)
        sys.exit(1)

files = sources()
joined = "\n".join(src for _, src in files)

# ── 1. no credential field ────────────────────────────────────────────────
#
# The seller signs in on the marketplace's own page, inside the view. A
# SecureField here would mean the app is collecting a marketplace password,
# which is both the thing the review notes say it never does and the thing the
# ADR draws its bright line around. TextField is included because a password
# typed into a plain field is still a password.
for name, src in files:
    for control in ("SecureField", "TextField"):
        if control in src:
            fail(
                f"{name}: contains {control}. The seller signs in to the marketplace on the "
                "marketplace's own page inside the web view - this app never collects a "
                "marketplace credential (review notes; ADR §3.1)."
            )

# ── 2. nothing scheduled starts a run ─────────────────────────────────────
#
# iOS suspends WKWebView JavaScript the moment the app backgrounds, so a
# scheduled run could not work anyway. The reason to forbid the code path is
# that its EXISTENCE makes "there is no background job" false in the review
# notes and on the consent screen, whether or not it ever fires.
SCHEDULERS = ("BGTaskScheduler", "BGAppRefreshTask", "BGProcessingTask", "Timer.scheduledTimer")
for name, src in files:
    for scheduler in SCHEDULERS:
        if scheduler in src:
            fail(
                f"{name}: references {scheduler}. Every run is one tap on one listing; "
                "a scheduled path makes the consent screen's 'nothing runs unless you tap' false."
            )

if os.path.isdir(BACKGROUND_DIR):
    for name in sorted(os.listdir(BACKGROUND_DIR)):
        if not name.endswith(".swift"):
            continue
        src = read(os.path.join(BACKGROUND_DIR, name))
        for symbol in (
            "WebDelistRunner", "WebDelistModel", "WebDelistView",
            "WebListRunner", "WebListModel", "WebListView",
        ):
            if symbol in src:
                fail(
                    f"Background/{name}: references {symbol}. The delist run is reachable only "
                    "from a tap; the background path must not know it exists."
                )

# ── 3. no runtime fetch ───────────────────────────────────────────────────
#
# App Review guideline 4.7 covers software not embedded in the binary. The
# selectors and the page scripts are compiled in (see the generated file) and a
# fetch here would be the obvious "so we can fix a marketplace breakage without
# shipping" change that quietly moves this app into 4.7's scope.
FETCHERS = ("URLSession", "EdgeAPI", "EdgeNetwork", "dataTask", "AsyncHTTP")
for name, src in files:
    for fetcher in FETCHERS:
        if fetcher in src:
            fail(
                f"{name}: references {fetcher}. Nothing in the delist run may be fetched at "
                "runtime - the scripts and selectors ship in the binary (App Review 4.7)."
            )

# A URL literal that is not a marketplace is the same problem wearing a
# different hat. The delist table's hosts are bare domains, not URLs. The
# list table (US-3455) carries each marketplace's create-listing page, which
# is the one URL the list flow opens on its own; it is allowed only when its
# host is one of the hosts declared in that same generated file, so a
# selectors.js edit pointing the create page anywhere else fails here.
HOST_LIST_RE = re.compile(r'hosts:\s*\[([^\]]*)\]')


def declared_hosts(src: str) -> set[str]:
    hosts: set[str] = set()
    for group in HOST_LIST_RE.findall(src):
        hosts.update(re.findall(r'"([^"]+)"', group))
    return hosts


def on_declared_host(url: str, hosts: set[str]) -> bool:
    match = re.match(r'https://([^/]+)', url)
    if not match:
        return False
    host = match.group(1).lower()
    return any(host == h or host.endswith("." + h) for h in hosts)


for name, src in files:
    allowed_hosts = declared_hosts(src) if name == "ListFlows.generated.swift" else set()
    for match in re.finditer(r'"(https?://[^"]+)"', src):
        if allowed_hosts and on_declared_host(match.group(1), allowed_hosts):
            continue
        fail(
            f"{name}: hardcodes {match.group(1)}. The only URLs this feature opens are the "
            "seller's own listing (arrives on the row, host-checked) and the generated "
            "table's create page on its own declared host."
        )

# ── 4. the per-marketplace store ──────────────────────────────────────────
if "WKWebsiteDataStore.default()" in joined:
    fail(
        "the delist web view uses WKWebsiteDataStore.default(). A marketplace session must "
        "live in its own per-marketplace store, or one marketplace's page can read another's "
        "cookies (WebDelistDataStore)."
    )
for runner_name in ("WebDelistRunner.swift", "WebListRunner.swift"):
    runner_src = next((src for n, src in files if n == runner_name), "")
    if "config.websiteDataStore = WebDelistDataStore.store(for: platform)" not in runner_src:
        fail(
            f"{runner_name} no longer assigns WebDelistDataStore.store(for:). Without it the "
            "session lands in whatever store WebKit picks."
        )

# ── 5. sign-out erases them ───────────────────────────────────────────────
content_view = read(CONTENT_VIEW)
if "WebDelistDataStore.removeAll()" not in content_view:
    fail(
        "ContentView no longer calls WebDelistDataStore.removeAll() on sign-out. A device "
        "handed to the next account would still be signed in to the previous owner's closet."
    )

# ── 6. the risk sentence matches the web ──────────────────────────────────
#
# A phone disclosure gentler than the website's is the single most damaging
# inconsistency this feature can ship, because anyone who lines the two up
# learns something about us that no other sentence undoes.
SHARED_RISK = (
    "terms restrict third-party automation. Plenty of sellers use tools like "
    "this one, and"
)
# The Swift literal is split across lines with `" + "`, so the comparison is on
# the concatenated text rather than the source as written.
flattened = re.sub(r'"\s*\+\s*"', "", joined)
# And the consent screen must actually RENDER it. Without this the sentence can
# sit unused in the model while the screen shows something friendlier, which is
# exactly the failure and is invisible to a whole-directory search.
for view_path in (
    os.path.join(DELIST_DIR, "WebDelistView.swift"),
    os.path.join(LIST_DIR, "WebListView.swift"),
):
    if os.path.exists(view_path):
        view_src = read(view_path)
        if "WebDelistModel.riskDisclosure(" not in view_src:
            fail(
                f"{os.path.basename(view_path)} no longer renders WebDelistModel.riskDisclosure(). "
                "The shared risk sentence existing in the model is not the same as the seller "
                "reading it."
            )

if SHARED_RISK not in flattened:
    fail(
        "the consent screen no longer carries the shared risk sentence from "
        "src/lib/marketplace-disclosure.ts (MECHANISM_DISCLOSURE.extension). The phone "
        "must not soften what the website states."
    )

if os.path.exists(WEB_DISCLOSURE):
    web = read(WEB_DISCLOSURE)
    if SHARED_RISK not in web:
        fail(
            "src/lib/marketplace-disclosure.ts no longer contains the risk sentence this "
            "guard pins. Update both copies together, or neither."
        )

# ── 7. the generated tables are generated ─────────────────────────────────
for generated, generator in (
    (GENERATED, "scripts/gen-ios-delist-selectors.mjs"),
    (LIST_GENERATED, "scripts/gen-ios-list-selectors.mjs"),
):
    if not os.path.exists(generated):
        fail(f"{os.path.basename(generated)} is missing. Run: node {generator}")
    else:
        header = read(generated)[:400]
        if "GENERATED FILE. DO NOT EDIT." not in header:
            fail(
                f"{os.path.basename(generated)} lost its generated header. It is derived from "
                "extension-unified/lister/selectors.js so the phone and the desktop use the same "
                "selectors; a hand-kept copy goes stale the day the other one is fixed."
            )

# ── 8. the list flow never posts, and the page is never hidden ────────────
#
# US-3455. The whole case for filling a form in the app is that the SELLER
# presses the marketplace's button. The submit selector is carried so the run
# can probe that it is on the real form; a call site that clicks it turns the
# feature into the bot the review notes say it is not. And a web view that is
# hidden, zero-sized or faded is a run the seller cannot watch, which is §3.4.
list_runner = next((src for n, src in files if n == "WebListRunner.swift"), "")
if list_runner and re.search(r'click\(\s*(flow\.)?submit', list_runner):
    fail(
        "WebListRunner clicks the submit selector. The seller posts; GradeThread never "
        "does (review notes; vault §3)."
    )
if list_runner and re.search(r'querySelector\([^)]*submit[^)]*\)\.click', list_runner):
    fail("WebListRunner clicks a submit control from page script. The seller posts.")
for name, src in files:
    if not name.endswith("View.swift"):
        continue
    for tell in (".hidden()", ".opacity(0)", "frame(width: 0", "frame(height: 0"):
        if tell in src:
            fail(
                f"{name}: uses {tell}. The web view is visible the whole run; a hidden or "
                "zero-sized page is a run the seller cannot watch."
            )

if problems:
    for problem in problems:
        print(f"  ✗ {problem}", file=sys.stderr)
    print(f"\ncheck-web-delist: {len(problems)} problem(s).", file=sys.stderr)
    sys.exit(1)

print(
    f"check-web-delist: {len(files)} source(s) - no credential field, nothing scheduled, "
    "nothing fetched, per-marketplace session erased on sign-out, risk sentence shared with "
    "the web, flow tables generated, list flow never posts"
)
