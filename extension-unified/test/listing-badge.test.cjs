// research/listing-badge.js — the on-marketplace verified badge (US-3060 AC5).
//
// The rule this file exists to hold: ABSENCE IS NOT A CLAIM. A miss, a 4xx, a
// 5xx, a dead network and a malformed body all render nothing. There is no
// "unverified" badge, because every ungraded listing on the page would become
// something our extension appears to have judged, and most of those sellers
// have never heard of us.
//
// Zero-dependency node script: throws on drift.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// A UMD content script, kept `.js` because Chrome rejects a `.cjs` content
// script. The repo is type:module, so require() of a .js returns an empty
// object rather than throwing — the quiet version of this mistake. Load it the
// way Chrome does: run the source with an injected `self`.
function load(rel, global, seed) {
  const src = fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
  const selfObj = seed || {};
  new Function("self", src)(selfObj);
  assert.ok(selfObj[global], `${rel} must assign self.${global}`);
  return selfObj[global];
}

const BADGE = load("research/listing-badge.js", "GT_LISTING_BADGE");

// ── The id rule is MIRRORED, so pin it to its source ────────────────────────
//
// listing-badge.js carries its own copy of the Poshmark and Mercari id regexes
// because the closet-import bundle is not loaded on a marketplace listing page.
// Three copies of one rule is a real cost; this is what makes it safe. A change
// in closet-import/extract.js fails HERE rather than quietly leaving the badge
// looking up ids the server keys differently.
(function idRegexesMatchTheirSource() {
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "closet-import", "extract.js"),
    "utf8",
  );
  for (const [name, re] of [
    ["POSHMARK_ID_RE", BADGE.POSHMARK_ID_RE],
    ["MERCARI_ID_RE", BADGE.MERCARI_ID_RE],
  ]) {
    const literal = re.toString();
    assert.ok(
      src.includes(literal),
      `${name} is ${literal}, which does not appear in closet-import/extract.js. ` +
        `The two must stay identical — the server keys listings by whichever ` +
        `one wrote the row.`,
    );
  }
})();

// ── Id extraction, per platform ─────────────────────────────────────────────

(function ebayIdsComeFromTheUrl() {
  // US-3042's rule: on eBay the ONLY thing read off the page is the item id.
  assert.strictEqual(
    BADGE.listingIdFromUrl("ebay", "https://www.ebay.com/itm/123456789012"),
    "123456789012",
  );
  // A slugged eBay URL still ends in the id.
  assert.strictEqual(
    BADGE.listingIdFromUrl("ebay", "https://www.ebay.co.uk/itm/vintage-jacket/265412345678"),
    "265412345678",
  );
  // Too short, too long, and not a number at all.
  for (const url of [
    "https://www.ebay.com/itm/12345678",
    "https://www.ebay.com/itm/1234567890123456",
    "https://www.ebay.com/sch/i.html?_nkw=jacket",
    "https://www.ebay.com/b/Mens-Coats/57988",
  ]) {
    assert.strictEqual(BADGE.listingIdFromUrl("ebay", url), null, url);
  }
})();

(function poshmarkAndMercariIds() {
  assert.strictEqual(
    BADGE.listingIdFromUrl(
      "poshmark",
      "https://poshmark.com/listing/Patagonia-Fleece-5f3a1b2c3d4e5f6a7b8c9d0e",
    ),
    "5f3a1b2c3d4e5f6a7b8c9d0e",
  );
  assert.strictEqual(
    BADGE.listingIdFromUrl("mercari", "https://www.mercari.com/us/item/m12345678901/"),
    "m12345678901",
  );
  // A closet page, a search page and a brand page are not listings.
  for (const [p, url] of [
    ["poshmark", "https://poshmark.com/closet/someone"],
    ["poshmark", "https://poshmark.com/brand/Patagonia"],
    ["mercari", "https://www.mercari.com/search/?keyword=jacket"],
    ["mercari", "https://www.mercari.com/us/item/notanid/"],
  ]) {
    assert.strictEqual(BADGE.listingIdFromUrl(p, url), null, `${p} ${url}`);
  }
})();

(function unknownPlatformsAndJunk() {
  // depop and grailed have no id extractor, so they are not badge platforms —
  // a platform in the list with no extractor is a request that always misses.
  assert.strictEqual(BADGE.isBadgePlatform("depop"), false);
  assert.strictEqual(BADGE.isBadgePlatform("grailed"), false);
  assert.strictEqual(
    BADGE.listingIdFromUrl("depop", "https://www.depop.com/products/x-y/"),
    null,
  );
  for (const bad of [null, undefined, 42, "", "not a url", "javascript:alert(1)"]) {
    assert.strictEqual(BADGE.listingIdFromUrl("ebay", bad), null, String(bad));
  }
})();

// ── The batch ───────────────────────────────────────────────────────────────

(function batchDeDuplicatesThenCaps() {
  const one = "https://www.ebay.com/itm/123456789012";
  // A grid repeats promoted listings. Eight copies of one item is ONE id, not
  // eight slots spent and not a rejected request.
  const ids = BADGE.badgeIdsFromUrls("ebay", new Array(8).fill(one));
  assert.deepStrictEqual(ids, ["123456789012"]);

  // Thirty distinct ids cap at MAX_IDS, and the cap matches the server's.
  const many = [];
  for (let i = 0; i < 30; i++) many.push(`https://www.ebay.com/itm/12345678${1000 + i}`);
  assert.strictEqual(BADGE.badgeIdsFromUrls("ebay", many).length, BADGE.MAX_IDS);
  assert.strictEqual(BADGE.MAX_IDS, 24);

  // Non-listing hrefs are dropped rather than sent, so a grid of mostly
  // category links does not spend the batch on them.
  const mixed = [one, "https://www.ebay.com/b/Mens/57988", "", null];
  assert.deepStrictEqual(BADGE.badgeIdsFromUrls("ebay", mixed), ["123456789012"]);
  assert.deepStrictEqual(BADGE.badgeIdsFromUrls("ebay", []), []);
  assert.deepStrictEqual(BADGE.badgeIdsFromUrls("ebay", null), []);
})();

(function requestUrlIsEncoded() {
  const url = BADGE.badgeRequestUrl("https://functions.gradethread.com/", "ebay", ["1", "2"]);
  assert.strictEqual(
    url,
    "https://functions.gradethread.com/api/grading/public/listing-certificates?platform=ebay&ids=1%2C2",
  );
  assert.ok(url.indexOf(BADGE.ENDPOINT) !== -1);
})();

// ── The 60-second refusal ───────────────────────────────────────────────────

(function oneRequestPerPageNotPerScroll() {
  let now = 1_000_000;
  const gate = BADGE.makeBadgeGate(() => now);

  assert.strictEqual(gate.allow(), true, "the first ask must go through");
  assert.strictEqual(gate.allow(), false, "an immediate second ask must be refused");

  now += 59_000;
  assert.strictEqual(gate.allow(), false, "still inside the window");

  now += 2_000; // 61s since the first
  assert.strictEqual(gate.allow(), true, "past the window, allowed again");
  assert.strictEqual(gate.allow(), false, "and the window restarts from THAT ask");

  assert.strictEqual(BADGE.REFUSAL_WINDOW_MS, 60_000);
})();

(function askingSpendsTheSlotEvenIfTheFetchFails() {
  // Deliberate: a page erroring in a retry loop must not become a request per
  // retry. The caller that asked has spent its slot whether or not it went on
  // to fetch anything.
  let now = 0;
  const gate = BADGE.makeBadgeGate(() => now);
  assert.strictEqual(gate.allow(), true);
  now += 100;
  for (let i = 0; i < 20; i++) assert.strictEqual(gate.allow(), false);
})();

// ── Reading the answer: every failure renders nothing ───────────────────────

(function malformedBodiesProduceNoBadges() {
  for (const body of [
    null,
    undefined,
    "",
    "not json",
    42,
    {},
    { certificates: null },
    { certificates: "nope" },
    { certificates: {} },
    { found: 3 }, // a count with no rows
  ]) {
    assert.deepStrictEqual(
      Object.keys(BADGE.badgesFromResponse(body)),
      [],
      `a badge was produced from ${JSON.stringify(body)}`,
    );
  }
})();

(function oneBadRowCostsThatRowAndNotThePage() {
  const good = { listingId: "111", grade: 8.5, tier: "Excellent", path: "/cert/GT-1" };
  const out = BADGE.badgesFromResponse({
    certificates: [
      null,
      { listingId: "", grade: 9, tier: "Mint", path: "/cert/x" }, // no id
      { listingId: "222", grade: null, tier: "Mint", path: "/cert/x" }, // no grade
      { listingId: "333", grade: 9, tier: "", path: "/cert/x" }, // no tier
      { listingId: "444", grade: 9, tier: "Mint", path: "" }, // nowhere to go
      { listingId: "555", grade: Infinity, tier: "Mint", path: "/cert/x" },
      good,
    ],
  });
  assert.deepStrictEqual(Object.keys(out), ["111"]);
  assert.deepStrictEqual(out["111"], good);
})();

(function duplicateRowsResolveFirstWins() {
  const out = BADGE.badgesFromResponse({
    certificates: [
      { listingId: "dup", grade: 8, tier: "A", path: "/cert/FIRST" },
      { listingId: "dup", grade: 9, tier: "B", path: "/cert/SECOND" },
    ],
  });
  assert.strictEqual(out["dup"].path, "/cert/FIRST");
})();

// ── What it renders ─────────────────────────────────────────────────────────

(function labelPutsTheGradeFirst() {
  assert.strictEqual(
    BADGE.badgeLabel({ grade: 8.5, tier: "Excellent" }),
    "8.5 · Excellent",
  );
  // One decimal always, because 9 and 9.0 next to each other on a grid reads
  // like two different precisions of claim.
  assert.strictEqual(BADGE.badgeLabel({ grade: 9, tier: "Mint" }), "9.0 · Mint");
  assert.strictEqual(BADGE.badgeLabel(null), "");
  assert.ok(BADGE.STRINGS.attribution.indexOf("GradeThread") !== -1);
})();

(function certificateLinkGoesThroughAttributionJs() {
  // Built by the REAL attribution.js, not a hand-rolled query string, so this
  // asserts the shape the certificate page will actually receive.
  const ATTR = load("attribution.js", "GT_ATTRIBUTION");
  const url = BADGE.certificateUrl(ATTR, { path: "/cert/GT-ABC" }, "poshmark");
  const u = new URL(url);

  assert.strictEqual(u.origin + u.pathname, "https://gradethread.com/cert/GT-ABC");

  // ⚠ THE PLATFORM IS IN utm_campaign, AND utm_source STAYS "extension".
  // attribution.js puts utm_source=extension on every link the extension places
  // on the site — that is how extension traffic is told apart from every other
  // channel. The first version of certificateUrl overwrote it with the
  // marketplace name, which would have made this one link type invisible as
  // extension traffic to answer a question utm_campaign already answers.
  assert.strictEqual(u.searchParams.get("utm_source"), "extension");
  assert.strictEqual(u.searchParams.get("utm_medium"), "badge");
  assert.strictEqual(u.searchParams.get("utm_campaign"), "poshmark");

  // utm_medium=badge is what the certificate page keys the arrival note and the
  // badge_certificate_click event on (src/lib/badge-arrival.ts). Without it the
  // whole site side of the loop is silent.
  assert.strictEqual(BADGE.certificateUrl(ATTR, null, "ebay"), null);

  // ⚠ AND WITH NO ATTRIBUTION MODULE IT RETURNS NULL, NOT A HAND-BUILT LINK.
  // The first version fell back to a literal https://gradethread.com URL, and
  // attribution.test.cjs refused it by name: a hand-built link reaches the site
  // with no funnel tags and its signups are recorded as direct traffic. Null is
  // also the rule the rest of this file follows — a badge with nowhere honest
  // to point does not render.
  assert.strictEqual(BADGE.certificateUrl(null, { path: "/cert/X" }, "ebay"), null);
})();

console.log("listing-badge.test.cjs: ok");

// ── The wiring (US-3060 AC4) ────────────────────────────────────────────────
//
// The render itself needs a DOM, so what is asserted here is the wiring that
// decides whether it EVER runs. Every one of these is a way the badge would
// silently never appear while every unit test above stayed green — which is the
// failure mode this repo keeps relearning.

const MANIFEST = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "..", "manifest.json"), "utf8"),
);
const MARKETPLACE = fs.readFileSync(
  path.resolve(__dirname, "..", "research", "marketplace.js"),
  "utf8",
);
const BACKGROUND = fs.readFileSync(
  path.resolve(__dirname, "..", "background.js"),
  "utf8",
);
const OVERLAY_CSS = fs.readFileSync(
  path.resolve(__dirname, "..", "research", "overlay.css"),
  "utf8",
);

(function theModuleIsActuallyLoadedWhereItIsUsed() {
  // self.GT_LISTING_BADGE is read at the top of marketplace.js. If the file is
  // not in the SAME content-script block, that read is undefined, every guard
  // in marketplace.js short-circuits, and the badge never renders — with no
  // error anywhere.
  const blocks = MANIFEST.content_scripts.filter(
    (b) => Array.isArray(b.js) && b.js.indexOf("research/marketplace.js") !== -1,
  );
  assert.ok(blocks.length > 0, "no content-script block loads research/marketplace.js");
  for (const b of blocks) {
    assert.ok(
      b.js.indexOf("research/listing-badge.js") !== -1,
      "a block loads marketplace.js without listing-badge.js, so GT_LISTING_BADGE " +
        "is undefined there and the badge silently never renders",
    );
    // And BEFORE it, because a UMD global has to exist when marketplace.js runs.
    assert.ok(
      b.js.indexOf("research/listing-badge.js") < b.js.indexOf("research/marketplace.js"),
      "listing-badge.js must load before marketplace.js",
    );
  }

  // Every badge platform must be a host the overlay actually runs on. A
  // platform in BADGE.PLATFORMS with no content script is a lookup that can
  // never fire.
  const hosts = blocks
    .flatMap((b) => b.matches)
    .map((m) => m.replace("https://", "").split("/")[0].replace("*.", ""));
  for (const p of BADGE.PLATFORMS) {
    assert.ok(
      hosts.some((h) => h.indexOf(p) !== -1),
      `${p} is a badge platform but no content-script block matches its host`,
    );
  }
})();

(function theLookupHappensBeforeTheCachedGradeReturns() {
  // boot() takes an EARLY RETURN when a cached grade exists. Loading the
  // certificate after that point made the bar appear on a first visit and
  // vanish on the second, which is the worst kind of bug to see reported.
  const load = MARKETPLACE.indexOf("await loadCertBadges([location.href])");
  const cached = MARKETPLACE.indexOf('send({ type: "GT_CC_GET_CACHED"');
  assert.ok(load > -1, "the detail page never loads its certificate");
  assert.ok(cached > -1, "the cached-grade branch moved; re-check this ordering");
  assert.ok(
    load < cached,
    "loadCertBadges runs AFTER the cached-grade early return, so a return " +
      "visit to a graded listing shows no badge",
  );
})();

(function aCertOnlyCardStillGetsAChip() {
  // renderBadge used to `return` whenever SCAN.badgeFor produced nothing. That
  // would make the verified badge conditional on a PRICE signal, so a graded
  // listing with no comps and no stated condition would carry nothing.
  assert.ok(
    /if \(!badge && !certBadge\) return;/.test(MARKETPLACE),
    "renderBadge returns on a missing triage badge alone, so a certificate " +
      "with no price signal renders nothing",
  );
})();

(function theBackgroundHandlerExistsAndIsPublic() {
  assert.ok(
    MARKETPLACE.indexOf('type: "GT_CC_LISTING_CERTS"') !== -1,
    "the content script never sends the lookup",
  );
  assert.ok(
    BACKGROUND.indexOf('case "GT_CC_LISTING_CERTS":') !== -1,
    "the background has no handler for the lookup, so every send resolves to " +
      "undefined and the badge silently never renders",
  );
  assert.ok(
    BACKGROUND.indexOf("/api/grading/public/listing-certificates") !== -1,
    "the background does not point at the public listing-certificates endpoint",
  );
  // ⚠ NO BUYER TOKEN. The endpoint is public, takes no user id, and returns
  // only already-published certificate fields — attaching an identity would
  // associate a shopper with the listings they browse for no gain at all.
  const fn = BACKGROUND.slice(
    BACKGROUND.indexOf("async function listingCertificates"),
    BACKGROUND.indexOf("async function scanCards"),
  );
  assert.ok(fn.length > 100, "listingCertificates not found where expected");
  assert.ok(
    fn.indexOf("gtBuyerToken") === -1 && fn.indexOf("Authorization") === -1,
    "the badge lookup attaches an identity to a public, anonymous read",
  );
})();

(function everyClassTheRenderUsesExistsInTheAuthoredCss() {
  // The sheet ships as a generated string adopted into a shadow root, so a
  // class that exists only in the render is invisible rather than unstyled —
  // and an unstyled chip inside a marketplace's own tile looks like a defect.
  for (const cls of [
    "gt-cc-cert",
    "gt-cc-cert-grade",
    "gt-cc-cert-by",
    "gt-cc-cert-link",
    "gt-cc-cert-chip",
  ]) {
    assert.ok(
      MARKETPLACE.indexOf('"' + cls + '"') !== -1,
      `${cls} is styled but never rendered`,
    );
    assert.ok(
      OVERLAY_CSS.indexOf("." + cls) !== -1,
      `${cls} is rendered but has no rule in research/overlay.css`,
    );
  }
})();

// -- badge_shown: the counter, DRIVEN rather than grepped (US-3060 AC6) ------
//
// The section above scans marketplace.js for wiring, which is what a scan is
// good for - WHERE a thing is mounted. "The counter fires when a badge is
// painted" is not that question. A grep for the call is satisfied by a call in
// an unreachable branch, by one that runs on every render rather than once, and
// by one that runs when nothing was painted. All three are the bug, and all
// three read green to a scan.
//
// So the REAL render functions are sliced out of marketplace.js and executed
// against stubs. They are closures inside a 1700-line IIFE that boots on load,
// so every free name they use is handed in as a parameter: this runs the
// shipped source, not a copy of it.
//
// WHAT badge_shown COUNTS, stated once so two people count the same thing:
// a badge that was PAINTED. One "badge_shown:overlay" per listing page whose
// overlay card carried the certificate bar in a readable (non-collapsed) state,
// counted once however many times that card re-renders. One "badge_shown:scan"
// per search-result card that ends up carrying a certificate chip that reached
// the page.
//
// WHAT IT DOES NOT COUNT, and this is a decision rather than an omission: a
// listing we did NOT badge is not counted at all, as neither a hit nor a miss.
// The extension cannot tell a refusal from a miss - a withheld certificate and
// two sellers disagreeing about one listing id return the SAME empty answer as
// a listing nobody ever graded, deliberately, so that absence is never a claim.
// A client-side "no badge here" tally would therefore be almost entirely
// ungraded listings with the refusals invisible inside it, and it would also be
// a count of how many listings the shopper opened, which is browsing volume and
// is not what the toggle asked consent for. The refusal rate has both its
// numerator and its denominator on the edge, where `found` against ids
// requested and the reason for each suppression are known; that is where it
// belongs if we want it.

const USAGE = load("usage-telemetry.js", "GT_USAGE");
const ATTRIBUTION = load("attribution.js", "GT_ATTRIBUTION");

/** A DOM stub with the handful of surfaces the render functions touch. */
function makeNode(tag, cls, text) {
  return {
    tag: String(tag || "div"),
    className: cls || "",
    textContent: text == null ? "" : String(text),
    children: [],
    attrs: {},
    firstChild: null,
    appendChild(n) {
      this.children.push(n);
      if (!this.firstChild) this.firstChild = n;
      return n;
    },
    insertBefore(n) {
      this.children.unshift(n);
      this.firstChild = n;
      return n;
    },
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    addEventListener() {},
  };
}

function stubEl(tag, cls, text) {
  return makeNode(tag, cls, text);
}

/** Slice a run of real source out of marketplace.js, with a vacuity floor. */
function sliceSource(from, to) {
  const a = MARKETPLACE.indexOf(from);
  assert.ok(a > -1, `marketplace.js no longer contains ${from} - re-anchor this slice`);
  const b = MARKETPLACE.indexOf(to, a);
  assert.ok(b > a, `marketplace.js no longer contains ${to} after ${from}`);
  const src = MARKETPLACE.slice(a, b);
  // A slice that collapsed to nothing would make every case below pass by
  // driving an empty function. Same reasoning as a corpus floor on a scan.
  assert.ok(src.length > 400, `the slice from ${from} is only ${src.length} chars`);
  return src;
}

// A recorder that is also a VOCABULARY check: everything the render path sends
// goes back through the real GT_USAGE.counterKey, so an event or a surface
// dropped from usage-telemetry.js fails right here rather than becoming a
// counter that silently never exists.
function makeUsageRecorder() {
  const sent = [];
  return {
    sent,
    send(event, surface) {
      const key = USAGE.counterKey(event, surface);
      assert.notStrictEqual(
        key,
        "",
        `the render path sent ("${event}", "${surface}"), which usage-telemetry.js ` +
          "drops - the badge would render and the counter would never exist",
      );
      // An unknown SURFACE does not drop the counter, it collapses to the bare
      // event - so the two badge surfaces would silently merge into one number
      // and nobody could tell a detail-page badge from a grid chip again.
      assert.strictEqual(
        key,
        event + ":" + surface,
        `the render path sent the surface "${surface}", which usage-telemetry.js ` +
          `does not know, so the counter collapsed to "${key}" and the two badge ` +
          "surfaces became one indistinguishable number",
      );
      sent.push(key);
    },
  };
}

const POSH_ID = "5f3a1b2c4d5e6f7a8b9c0d1e";
const POSH_URL = "https://poshmark.com/listing/Nice-Jacket-" + POSH_ID;
const BADGE_ROW = { listingId: POSH_ID, grade: 8.5, tier: "Excellent", path: "/cert/GT-ABC" };

// -- the detail-page bar -----------------------------------------------------

const DETAIL_SRC = sliceSource("function certBadgeHere()", "function renderLauncher()");

function mountDetail(opts) {
  const o = opts || {};
  const usage = makeUsageRecorder();
  const build = new Function(
    "CERT", "ATTR", "adapter", "certBadges", "location", "el",
    "openCollapsed", "certBarCounted", "sendUsage",
    DETAIL_SRC +
      "\nreturn { maybeCertBar: maybeCertBar," +
      " setCollapsed: function (v) { openCollapsed = v; } };",
  );
  const api = build(
    BADGE,
    ATTRIBUTION,
    { key: "poshmark" },
    o.badges || Object.create(null),
    { href: o.href || POSH_URL },
    stubEl,
    Boolean(o.collapsed),
    false,
    usage.send,
  );
  return { api, usage };
}

(function theOverlayBarCountsExactlyOnce() {
  const badges = Object.create(null);
  badges[POSH_ID] = BADGE_ROW;
  const { api, usage } = mountDetail({ badges });

  // renderLauncher's render.
  const launcher = makeNode("div");
  api.maybeCertBar(launcher);
  assert.strictEqual(launcher.children.length, 1, "the bar was not painted at all");
  assert.strictEqual(launcher.children[0].className, "gt-cc-cert");
  assert.deepStrictEqual(usage.sent, ["badge_shown:overlay"]);

  // ...and then renderResult's, on the same page. ONE badge, two renders.
  const result = makeNode("div");
  api.maybeCertBar(result);
  assert.strictEqual(result.children.length, 1, "the bar stopped painting on the second render");
  assert.deepStrictEqual(
    usage.sent,
    ["badge_shown:overlay"],
    "the bar is painted by renderLauncher AND renderResult, so counting per render " +
      "makes every shopper who asks for a read into two badges",
  );
})();

(function noHitIsNotCountedAtAll() {
  // The listing has no certificate - or has one we refused to hand over. The
  // extension cannot tell those apart, by design, so it counts NEITHER. A
  // "badge withheld" counter here would be a tally of listings opened.
  const { api, usage } = mountDetail({ badges: Object.create(null) });
  const body = makeNode("div");
  api.maybeCertBar(body);
  assert.strictEqual(body.children.length, 0, "a miss painted a bar");
  assert.deepStrictEqual(usage.sent, [], "a listing with no badge must count as nothing");
})();

(function anUnparseableListingUrlIsNotCounted() {
  const badges = Object.create(null);
  badges[POSH_ID] = BADGE_ROW;
  const { api, usage } = mountDetail({ badges, href: "https://poshmark.com/closet/someone" });
  const body = makeNode("div");
  api.maybeCertBar(body);
  assert.deepStrictEqual(usage.sent, []);
})();

(function aCollapsedOwnListingIsNotAShopperSeeingABadge() {
  // US-2622 opens the card as its header bar alone on a listing the VIEWER
  // OWNS. The bar is built into a hidden body. This counter answers "how often
  // does a shopper meet a certificate on a marketplace page", and a seller
  // looking at their own item is not that.
  const badges = Object.create(null);
  badges[POSH_ID] = BADGE_ROW;
  const { api, usage } = mountDetail({ badges, collapsed: true });

  const collapsed = makeNode("div");
  api.maybeCertBar(collapsed);
  assert.strictEqual(collapsed.children.length, 1, "the bar must still be BUILT, only not counted");
  assert.deepStrictEqual(usage.sent, []);

  // And the moment they expand it, it counts - the flag was never spent.
  api.setCollapsed(false);
  const expanded = makeNode("div");
  api.maybeCertBar(expanded);
  assert.deepStrictEqual(usage.sent, ["badge_shown:overlay"]);
})();

// -- the scan-mode card chip -------------------------------------------------

const SCAN_SRC = sliceSource("function renderBadge(card, result)", "async function runScan()");

function mountScan(opts) {
  const o = opts || {};
  const usage = makeUsageRecorder();
  const build = new Function(
    "SCAN", "CERT", "ATTR", "certBadges", "adapter", "SHADOW", "CSS", "document",
    "themePref", "el", "S", "window", "SCAN_MARK", "sendUsage",
    SCAN_SRC + "\nreturn renderBadge;",
  );
  const triage = { cls: "gt-cc-b", parts: [{ cls: "gt-cc-p", text: "Fair price" }] };
  const renderBadge = build(
    {
      badgeFor: () => (o.triage ? triage : null),
      STRINGS: { footnote: "rough triage" },
    },
    BADGE,
    o.noAttribution ? null : ATTRIBUTION,
    o.badges || Object.create(null),
    { key: "poshmark" },
    { createBadgeHost: () => ({ root: makeNode("div"), host: makeNode("div") }) },
    "/* sheet */",
    null,
    null,
    stubEl,
    { badgeCta: "Check condition" },
    { open() {} },
    "data-gt-cc-scanned",
    usage.send,
  );
  const node = makeNode("div");
  if (o.detached) {
    node.appendChild = () => {
      throw new Error("node is not attached to the document");
    };
  }
  return { renderBadge, usage, card: { node, href: o.href || POSH_URL, key: "k" } };
}

(function aCertOnlyCardCountsOnce() {
  const badges = Object.create(null);
  badges[POSH_ID] = BADGE_ROW;
  const { renderBadge, usage, card } = mountScan({ badges, triage: false });
  renderBadge(card, {});
  assert.strictEqual(card.node.children.length, 1, "the chip host never reached the card");
  assert.deepStrictEqual(usage.sent, ["badge_shown:scan"]);
})();

(function aTriageOnlyCardCountsNothing() {
  // A price chip is not a verified badge. Counting it would make badge_shown a
  // number about comps.
  const { renderBadge, usage, card } = mountScan({ badges: Object.create(null), triage: true });
  renderBadge(card, {});
  assert.strictEqual(card.node.children.length, 1, "the triage badge stopped rendering");
  assert.deepStrictEqual(usage.sent, []);
})();

(function aBadgeThatNeverReachedThePageWasNeverShown() {
  // The grid re-rendered under the scan and the node is detached, so the mount
  // throws and the badge is dropped. Counting before the mount would report
  // badges nobody could have seen.
  const badges = Object.create(null);
  badges[POSH_ID] = BADGE_ROW;
  const { renderBadge, usage, card } = mountScan({ badges, detached: true });
  renderBadge(card, {});
  assert.deepStrictEqual(usage.sent, []);
})();

(function aChipWithNowhereHonestToPointIsNotCounted() {
  // certificateUrl returns null with no attribution module, so no chip is
  // appended - and an absent chip is not a shown badge.
  const badges = Object.create(null);
  badges[POSH_ID] = BADGE_ROW;
  const { renderBadge, usage, card } = mountScan({ badges, noAttribution: true, triage: true });
  renderBadge(card, {});
  assert.deepStrictEqual(usage.sent, []);
})();

console.log(
  "listing-badge.test.cjs: badge_shown driven through the real render source - " +
    "once per page on the overlay bar, once per card in scan mode, nothing for a " +
    "listing we did not badge",
);
