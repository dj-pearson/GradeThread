// GradeThread unified extension — US-2241 depth guards.
//
// Four small features that each have one way to go quietly wrong:
//
//   1. THE PHOTO CAP. It is now the account's, mirrored on the client so the
//      gallery is extracted at the right depth. Client and server must agree, or
//      a paying shopper sends four photos and never learns they bought eight.
//   2. ASSET DEDUPE. The same photo at two sizes is two URLs. Without an asset
//      identity it occupies two of the slots the shopper paid for — but a
//      malformed pattern must never make photos VANISH.
//   3. THE CONTEXT MENU + COMMAND. Both must route through the overlay, not
//      open a second result surface with its own staleness rules.
//   4. THE BADGE. It is per-tab and cleared on navigation, or it labels the
//      wrong listing with the previous one's score.
//
// Zero-dependency node script: throws on drift.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");

function loadIntoSelf(rel) {
  const selfObj = {};
  const src = fs.readFileSync(path.join(dir, rel), "utf8");
  // eslint-disable-next-line no-new-func
  new Function("self", "module", src)(selfObj, { exports: {} });
  return selfObj;
}

const REG = loadIntoSelf("registry.js").GT_REGISTRY;
const IMG = loadIntoSelf("research/image-utils.js").GT_CC_IMG;

// ── 1. the photo cap ──────────────────────────────────────────────────────
assert.strictEqual(REG.MAX_IMAGES_ANON, 4);
assert.strictEqual(REG.MAX_IMAGES_PAID, 8);

// The client mirrors lib/extension-gates.ts. If that file's constants move, this
// assertion is the thing that notices — the two are a contract, not a coincidence.
const gatesSrc = fs.readFileSync(
  path.resolve(dir, "..", "services", "edge-functions", "src", "lib", "extension-gates.ts"),
  "utf8",
);
const anonServer = /EXTENSION_MAX_IMAGES_ANON\s*=\s*(\d+)/.exec(gatesSrc);
const paidServer = /EXTENSION_MAX_IMAGES_PAID\s*=\s*(\d+)/.exec(gatesSrc);
assert.ok(anonServer && paidServer, "extension-gates.ts must export both image caps");
assert.strictEqual(
  Number(anonServer[1]),
  REG.MAX_IMAGES_ANON,
  "registry.js and lib/extension-gates.ts disagree on the ANONYMOUS photo cap. " +
    "The client extracts the gallery at its own number, so a drift means either " +
    "wasted URLs or a paying shopper silently getting the free-tier read.",
);
assert.strictEqual(Number(paidServer[1]), REG.MAX_IMAGES_PAID, "paid cap drifted");

assert.strictEqual(REG.maxImagesFor("free"), 4, "signing in is not the same as paying");
assert.strictEqual(REG.maxImagesFor(""), 4);
assert.strictEqual(REG.maxImagesFor(null), 4);
assert.strictEqual(REG.maxImagesFor(undefined), 4);
assert.strictEqual(REG.maxImagesFor("guard"), 8);
assert.strictEqual(
  REG.maxImagesFor("collector-2027"),
  8,
  "an unknown FUTURE plan must inherit the paid cap. Enumerating plan names here " +
    "means a plan added later silently falls back to the free-tier read.",
);

// The fail-safe path: anonymous entitlements resolve to the floor.
const anonCaps = REG.resolveCapabilities(REG.ANONYMOUS_ENTITLEMENTS, {});
assert.strictEqual(anonCaps.maxImages, 4);
assert.strictEqual(REG.resolveCapabilities(null, {}).maxImages, 4, "a malformed response is anonymous");
assert.strictEqual(
  REG.resolveCapabilities({ authenticated: true, buyerPlan: "guard" }, {}).maxImages,
  8,
);

// ── 2. asset dedupe ───────────────────────────────────────────────────────
const EBAY_PATTERN = "/g/([^/]+)/";
const twoSizes = [
  "https://i.ebayimg.com/images/g/AbCd/s-l64.jpg",
  "https://i.ebayimg.com/images/g/AbCd/s-l1600.jpg",
  "https://i.ebayimg.com/images/g/ZzYy/s-l1600.jpg",
];
assert.deepStrictEqual(
  IMG.dedupeUrls(twoSizes, 4, EBAY_PATTERN),
  ["https://i.ebayimg.com/images/g/AbCd/s-l64.jpg", "https://i.ebayimg.com/images/g/ZzYy/s-l1600.jpg"],
  "one photo at two sizes must occupy ONE slot — otherwise a gallery that emits " +
    "both a filmstrip and a main image spends half the shopper's budget on " +
    "duplicates of the same shot",
);

// Without a pattern, behaviour is exactly as before — this is additive.
assert.strictEqual(IMG.dedupeUrls(twoSizes, 4).length, 3);
assert.deepStrictEqual(IMG.dedupeUrls(["a", "a", "b"], 4), ["a", "b"], "plain URL dedupe still works");

// A malformed or non-matching pattern must degrade to URL identity, NEVER drop
// photos. A bad remote config is the realistic case here.
for (const bad of ["(unclosed", "[", null, undefined, 42, "", "/nomatch/([0-9]+)/"]) {
  assert.strictEqual(
    IMG.dedupeUrls(twoSizes, 4, bad).length,
    3,
    `pattern ${JSON.stringify(bad)} must fall back to URL identity, not lose images`,
  );
}

// A pattern with no capture group must not collapse everything into one.
assert.strictEqual(
  IMG.dedupeUrls(twoSizes, 4, "/g/").length,
  3,
  "a pattern with no capture group has no asset id — fall back, don't merge",
);

// The cap still applies after dedupe.
assert.strictEqual(IMG.dedupeUrls(twoSizes, 1, EBAY_PATTERN).length, 1);

// The shipped adapters' patterns must actually be valid regexes with a group.
const cfg = loadIntoSelf("research/selectors.js").GT_CC_CONFIG;
for (const [key, a] of Object.entries(cfg.adapters)) {
  if (!a.assetIdPattern) continue;
  let re;
  assert.doesNotThrow(() => {
    re = new RegExp(a.assetIdPattern, "i");
  }, `adapter ${key}.assetIdPattern is not a valid regex`);
  assert.ok(
    /\((?!\?)/.test(a.assetIdPattern),
    `adapter ${key}.assetIdPattern has no capture group — it would never produce ` +
      "an asset id, making it dead config that looks like it works",
  );
}

// ── 3. the command + context menu route through the overlay ───────────────
const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8");
const mkt = fs.readFileSync(path.join(dir, "research", "marketplace.js"), "utf8");

for (const [api, why] of [
  ["commands", "a browser may not grant the commands API"],
  ["contextMenus", "contextMenus is a separate permission a browser may withhold"],
]) {
  assert.ok(
    new RegExp(`if\\s*\\([^)]*\\b${api}\\b[^)]*\\)`).test(bg),
    `background.js registers on ${api} without an existence guard. ${why}, and ` +
      "reading .addListener off an undefined namespace throws at LOAD — aborting " +
      "the WHOLE worker, including buyer research (US-1881 AC2).",
  );
}

const menuHandler = /onClicked\.addListener\(function \(info, tab\) \{([\s\S]*?)\n    \}\);/.exec(bg);
assert.ok(menuHandler, "background.js must handle contextMenus.onClicked");
assert.ok(
  /tabs\.sendMessage/.test(menuHandler[1]),
  "the context menu must route through the CONTENT SCRIPT so the result lands in " +
    "the same overlay under the same epoch guard. Grading straight from the " +
    "worker would create a second result surface with its own staleness rules.",
);
assert.ok(
  /https\?/.test(menuHandler[1]),
  "the clicked image URL must be scheme-checked before it is used",
);
assert.ok(
  /GT_CC_RUN/.test(mkt),
  "marketplace.js must accept GT_CC_RUN from the command and the context menu",
);
assert.ok(
  /runGrade\(\[msg\.imageUrl\]\)/.test(mkt),
  "a right-clicked image must be graded ON ITS OWN. Substituting the gallery " +
    "would ignore the photo the shopper deliberately picked — which is the entire " +
    "reason the menu exists (the gallery selector missed it).",
);

// ── 4. the badge ──────────────────────────────────────────────────────────
const badgeFn = /async function setScoreBadge\([\s\S]*?\n\}/.exec(bg);
assert.ok(badgeFn, "background.js must define setScoreBadge");
assert.ok(
  /tabId: tabId/.test(badgeFn[0]),
  "the badge must be PER-TAB. A global badge shows the previous listing's score " +
    "against whatever tab the shopper switches to.",
);
assert.ok(
  /sender\.tab && sender\.tab\.id/.test(bg),
  "the tab id must come from sender.tab, never from the message body — otherwise " +
    "any content script could badge any tab",
);
assert.ok(
  /GT_CC_CLEAR_BADGE/.test(bg) && /GT_CC_CLEAR_BADGE/.test(mkt),
  "navigating away must clear the badge, or it outlives the listing it describes",
);

// ── the options page exists and is declared ───────────────────────────────
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
assert.strictEqual(manifest.options_ui && manifest.options_ui.page, "options.html");
assert.ok(manifest.commands && manifest.commands["run-condition-read"]);
assert.ok(
  (manifest.permissions || []).includes("contextMenus"),
  "the contextMenus permission must be declared",
);
for (const f of ["options.html", "options.js", "options.css"]) {
  assert.ok(fs.existsSync(path.join(dir, f)), `${f} must exist`);
}

// No new HOST permission may sneak in with this work — the depth features are
// all local, and a widened host list is the thing store review looks at hardest.
assert.deepStrictEqual(
  manifest.host_permissions,
  [
    "https://gradethread.com/*",
    "https://*.gradethread.com/*",
    "https://*.poshmark.com/*",
    "https://*.mercari.com/*",
    "https://*.grailed.com/*",
  ],
  "US-2241 must not widen host_permissions — every feature in it is local",
);

const opts = fs.readFileSync(path.join(dir, "options.js"), "utf8");
assert.ok(!/\bfetch\s*\(/.test(opts), "the settings page must make no network call");
assert.ok(
  /disabledHosts/.test(opts),
  "the settings page must list the disabled sites — the popup can only turn a " +
    "site off while you are ON it, so it can only turn one back on the same way",
);

console.log(
  "depth.test.cjs: client/server photo caps agree, asset dedupe never loses " +
    "images, menu + command route through the overlay, badge is per-tab",
);
