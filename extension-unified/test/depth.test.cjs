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
   
  new Function("self", "module", src)(selfObj, { exports: {} });
  return selfObj;
}

const REG = loadIntoSelf("registry.js").GT_REGISTRY;
const IMG = loadIntoSelf("research/image-utils.js").GT_CC_IMG;

// ── 1. the photo cap ──────────────────────────────────────────────────────
assert.strictEqual(REG.MAX_IMAGES_ANON, 4);
assert.strictEqual(REG.MAX_IMAGES_PAID, 8);

// The client mirrors the server's caps. They are declared next to the parser
// that enforces them (lib/extension-image-urls.ts) so the value and its clamp
// can't drift apart; extension-gates.ts re-exports them for tier resolution.
//
// Read from the DECLARING file rather than the re-exporting one: a re-export
// would still match a loose regex after the real constant had changed, which is
// exactly the drift this assertion exists to catch.
const capsSrc = fs.readFileSync(
  path.resolve(dir, "..", "services", "edge-functions", "src", "lib", "extension-image-urls.ts"),
  "utf8",
);
const anonServer = /export const EXTENSION_MAX_IMAGES_ANON\s*=\s*(\d+)/.exec(capsSrc);
const paidServer = /export const EXTENSION_MAX_IMAGES_PAID\s*=\s*(\d+)/.exec(capsSrc);
assert.ok(
  anonServer && paidServer,
  "lib/extension-image-urls.ts must declare both image caps — it is the file that " +
    "enforces them, so it is the one the client must agree with",
);
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
  assert.doesNotThrow(
    () => new RegExp(a.assetIdPattern, "i"),
    `adapter ${key}.assetIdPattern is not a valid regex`,
  );
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

const menuHandler = /onClicked\.addListener\(function \(info, tab\) \{([\s\S]*?)\n {4}\}\);/.exec(bg);
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

// No host permission may sneak in — a widened host list is the thing store
// review looks at hardest, and "we added it while doing something else" is
// exactly how an unexplained host ends up in a submission.
//
// US-2479/US-2480 CHANGED THE SHAPE OF THIS CHECK, and the reason is worth
// stating. It used to be a frozen literal list, which was right when the answer
// was "this story adds none" and wrong the moment a story legitimately added
// some: a frozen list has to be hand-edited by whoever widens it, which makes
// the guard a formality they update rather than a rule they satisfy.
//
// So it now asserts the RULE instead: every marketplace host the extension asks
// for must be a host some lister platform actually declares in selectors.js.
// That still fails on an unexplained host — the case this exists for — and it
// keeps passing when a channel is added properly, without anyone touching this
// file. Adding a host to selectors.js without a flow behind it is caught by
// scripts/verify-lister-selectors.mjs on the other side.
const selectorsSrc = fs.readFileSync(
  path.join(dir, "lister", "selectors.js"),
  "utf8",
);
const listerScope = {};
 
new Function("self", `${selectorsSrc}; return self.GT_LISTER_SELECTORS;`)(listerScope);
const listerHosts = new Set(
  Object.values(listerScope.GT_LISTER_SELECTORS).flatMap((c) => c.hosts || []),
);

const GRADETHREAD_HOSTS = ["https://gradethread.com/*", "https://*.gradethread.com/*"];
for (const h of GRADETHREAD_HOSTS) {
  assert.ok(
    (manifest.host_permissions || []).includes(h),
    `host_permissions must include ${h} — the extension cannot reach its own API without it`,
  );
}

for (const pattern of manifest.host_permissions || []) {
  if (GRADETHREAD_HOSTS.includes(pattern)) continue;
  const bare = pattern.replace(/^https:\/\//, "").replace(/^\*\./, "").replace(/\/\*$/, "");
  assert.ok(
    listerHosts.has(bare),
    `host permission "${pattern}" is requested but no lister platform in ` +
      `lister/selectors.js declares "${bare}" in its \`hosts\`. Either it belongs ` +
      `to a channel that was never wired up, or it was added while doing something ` +
      `else — both are store-review problems and neither should ship.`,
  );
}

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

// ── the telemetry vocabulary is a contract, in both directions ────────────
//
// The scan grid and the seller lookup both fail SILENTLY on purpose, so a ping
// is the only way a broken adapter surfaces at all. The server drops any name
// outside its closed allowlist — silently, and with a 204, so a drift here looks
// exactly like "nothing is broken out there". That is the worst possible failure
// mode for a signal whose entire job is to tell us something IS broken.
const gradingSrc = fs.readFileSync(
  path.resolve(dir, "..", "services", "edge-functions", "src", "routes", "public-grading.ts"),
  "utf8",
);
const vocabBlock = /const SELECTOR_HEALTH_LISTS = new Set\(\[([\s\S]*?)\]\);/.exec(gradingSrc);
assert.ok(vocabBlock, "public-grading.ts must define SELECTOR_HEALTH_LISTS");
const serverVocab = new Set(
  Array.from(vocabBlock[1].matchAll(/"([^"]+)"/g)).map((m) => m[1]),
);

// Every literal the content script can send must be in it.
for (const sent of ["gallery", "gallery-no-urls", "title", "brand", "search-cards", "seller"]) {
  assert.ok(
    serverVocab.has(sent),
    `marketplace.js can send "${sent}" but SELECTOR_HEALTH_LISTS does not accept it. ` +
      "The endpoint drops it and answers 204, so the ping vanishes and a dead " +
      "adapter reads as a healthy one.",
  );
}

// And the adapter keys the ping carries must be accepted too — the ping sends
// adapter.key, and an unknown key rejects the WHOLE ping, not just the name.
const adaptersBlock = /const SELECTOR_HEALTH_ADAPTERS = new Set\(\[([\s\S]*?)\]\);/.exec(gradingSrc);
assert.ok(adaptersBlock, "public-grading.ts must define SELECTOR_HEALTH_ADAPTERS");
const serverAdapters = new Set(
  Array.from(adaptersBlock[1].matchAll(/"([^"]+)"/g)).map((m) => m[1]),
);
for (const key of Object.keys(cfg.adapters)) {
  assert.ok(
    serverAdapters.has(key),
    `adapter "${key}" ships in the extension but SELECTOR_HEALTH_ADAPTERS rejects ` +
      "it — every ping from that marketplace is discarded, so it is precisely the " +
      "newest (least verified) adapter that would report nothing.",
  );
}

// ── the silent surfaces actually report ───────────────────────────────────
assert.ok(
  /reportMiss\(\["search-cards"\]\)/.test(mkt),
  "an unreadable search grid must ping. The search selectors ship unverified " +
    "against six live DOMs and the shopper is shown nothing when they break, so " +
    "without this the feature can die on a marketplace and look identical to " +
    "'nobody used it'.",
);
assert.ok(
  /reportMiss\(\["seller"\]\)/.test(mkt),
  "an unresolvable seller must ping — it is indistinguishable from 'no repeat " +
    "reads yet' from the outside",
);
assert.ok(
  /if \(!lastCardSelectorMatched\) reportMiss/.test(mkt),
  "the scan ping must fire ONLY when no card selector matched. An empty card list " +
    "is also the steady state of the re-scan tick (every card already badged), and " +
    "pinging on that would bury the real signal under noise on every healthy page.",
);
assert.ok(
  /if \(sellerMissReported\) return;/.test(mkt),
  "the seller ping is once per page — a re-read must not double-count one broken " +
    "selector",
);
