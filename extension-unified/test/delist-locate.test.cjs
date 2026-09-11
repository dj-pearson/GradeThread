// GradeThread Lister -- US-3369: ending a listing GradeThread has no link to.
//
// A sale ends the item's other listings. The extension used to need each
// listing's URL, and a listing posted by hand (or one whose capture missed)
// had none, so it read "By hand" and the seller did it themselves. Now the
// extension opens the seller's own active-listings page and finds the tile.
//
// What is pinned here:
//   1. the guard only ever builds that page from the bundled config, with a
//      username that cannot change the URL's shape;
//   2. a present-but-foreign link is refused, never swapped for a search;
//   3. the matcher returns ONE listing or reports, and never guesses between
//      two that look alike (ending the wrong garment is the worst outcome);
//   4. the background resolves every delist through the guard, the drain
//      included, and rebuilds the fields the content script acts on.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");

function loadGlobal(rel, name) {
  const src = fs.readFileSync(path.join(dir, rel), "utf8");
  const scope = {};
  return new Function("self", `${src}; return self.${name};`)(scope);
}

const SEL = loadGlobal("lister/selectors.js", "GT_LISTER_SELECTORS");
const GUARD = loadGlobal("lister/lister-guard.js", "GT_LISTER_GUARD");

// -- 1. the active-listings page comes from config, never from a message ----
{
  assert.strictEqual(
    GUARD.activeListingsUrlFor(SEL, "poshmark", "jane_closet"),
    "https://poshmark.com/closet/jane_closet?availability=available",
  );
  // Poshmark has no handle-free closet, so no handle is no page.
  assert.strictEqual(GUARD.activeListingsUrlFor(SEL, "poshmark", null), null);
  for (const bad of ["../x", "a/b", "jane?x=1", "https://evil.test", "a b", "x".repeat(41)]) {
    assert.strictEqual(GUARD.activeListingsUrlFor(SEL, "poshmark", bad), null, `handle ${bad}`);
  }
  // Mercari's page is owner-only by URL and needs nothing.
  assert.strictEqual(
    GUARD.activeListingsUrlFor(SEL, "mercari", null),
    "https://www.mercari.com/mypage/listings/active/",
  );
  // Vinted declares no locate page; its wardrobe needs an id we do not hold.
  assert.strictEqual(GUARD.activeListingsUrlFor(SEL, "vinted", null), null);
  // Every declared page must be https and on the platform's own hosts.
  for (const [platform, cfg] of Object.entries(SEL)) {
    const loc = cfg.delist && cfg.delist.locate;
    if (!loc) continue;
    const url = GUARD.activeListingsUrlFor(SEL, platform, "someone");
    assert.ok(url, `${platform}: declared locate page did not resolve`);
    assert.ok(GUARD.isAllowedDelistUrl(SEL, platform, url), `${platform}: locate page off-host`);
    assert.ok(new RegExp(loc.pagePattern, "i").test(url), `${platform}: pagePattern misses its own page`);
    assert.ok(cfg.liveListingUrlPattern, `${platform}: locate needs liveListingUrlPattern to know a tile`);
  }
}

// -- 2. where a delist opens its tab ----------------------------------------
{
  const link = "https://poshmark.com/listing/abc-123";
  assert.deepStrictEqual(
    GUARD.delistTargetFor(SEL, "poshmark", { listingUrl: link }),
    { url: link, locate: false, reason: null },
  );
  // A link that is there but wrong is a tampered payload, not a reason to search.
  const bad = GUARD.delistTargetFor(SEL, "poshmark", {
    listingUrl: "https://evil.test/listing/x",
    matchTitles: ["Nike Hoodie"],
    sellerHandle: "jane",
  });
  assert.strictEqual(bad.url, null);
  assert.strictEqual(bad.reason, "bad-url");

  const found = GUARD.delistTargetFor(SEL, "poshmark", {
    matchTitles: ["Nike Hoodie"],
    sellerHandle: "jane",
  });
  assert.deepStrictEqual(found, {
    url: "https://poshmark.com/closet/jane?availability=available",
    locate: true,
    reason: null,
  });
  assert.strictEqual(
    GUARD.delistTargetFor(SEL, "poshmark", { matchTitles: ["Nike Hoodie"] }).reason,
    "needs-handle",
  );
  assert.strictEqual(GUARD.delistTargetFor(SEL, "mercari", {}).reason, "no-titles");
  assert.strictEqual(
    GUARD.delistTargetFor(SEL, "vinted", { matchTitles: ["x"] }).reason,
    "no-page",
  );
  assert.deepStrictEqual(
    GUARD.sanitizeMatchTitles(["  a ", 5, "", null, "b", "c", "d", "e"]),
    ["a", "b", "c", "d"],
  );
}

// -- 3. the matcher: one clear winner, or a report --------------------------
function loadGT() {
  const src = fs.readFileSync(path.join(dir, "lister/common.js"), "utf8");
  const scope = { GT_LISTER_SELECTORS: SEL };
  const window = { scrollTo() {} };
  const document = {
    querySelector() { return null; },
    querySelectorAll() { return []; },
    body: { appendChild() {}, querySelector() { return null; }, scrollHeight: 0 },
    createElement() { return { style: {}, setAttribute() {}, appendChild() {}, remove() {} }; },
  };
  const chrome = { runtime: { sendMessage() { return Promise.resolve(); } } };
  const fn = new Function(
    "self", "window", "document", "chrome", "location", "HTMLInputElement", "HTMLTextAreaElement",
    `${src}; return self.GTLister;`,
  );
  return fn(scope, window, document, chrome, { href: "", origin: "", pathname: "" },
    class {}, class {});
}

const GT = loadGT();
assert.ok(GT && typeof GT.pickListingMatch === "function", "GT.pickListingMatch is exposed");
{
  const tiles = [
    { href: "https://poshmark.com/listing/a", text: "Vintage Levi's 501 Jeans 32x30 $45 Size 32" },
    { href: "https://poshmark.com/listing/b", text: "Nike Tech Fleece Hoodie Black $60" },
    { href: "https://poshmark.com/listing/c", text: "Patagonia Better Sweater Navy" },
  ];
  const hit = GT.pickListingMatch(tiles, ["Vintage Levi's 501 Jeans 32x30"]);
  assert.strictEqual(hit.status, "found");
  assert.strictEqual(hit.href, "https://poshmark.com/listing/a");
  // Any of the titles may match: the variant the seller posted, or the item.
  assert.strictEqual(
    GT.pickListingMatch(tiles, ["no such words here", "Nike Tech Fleece Hoodie"]).href,
    "https://poshmark.com/listing/b",
  );
  assert.strictEqual(GT.pickListingMatch(tiles, ["Carhartt Detroit Jacket"]).status, "none");
  assert.strictEqual(GT.pickListingMatch([], ["anything"]).status, "none");
  assert.strictEqual(GT.pickListingMatch(tiles, []).status, "none");
  // Two garments one letter apart: never pick one.
  const twins = [
    { href: "https://poshmark.com/listing/m", text: "Nike Hoodie Black Size M" },
    { href: "https://poshmark.com/listing/l", text: "Nike Hoodie Black Size L" },
  ];
  const amb = GT.pickListingMatch(twins, ["Nike Hoodie Black Size M"]);
  assert.strictEqual(amb.status, "ambiguous");
  assert.strictEqual(amb.count, 2);
  // Accents and punctuation do not decide a match.
  assert.strictEqual(GT.titleMatchScore("Café Crème Sweater!", "cafe creme sweater"), 1);
}

// -- 4. the background resolves every delist through the guard --------------
{
  const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8");
  const handler = bg.slice(bg.indexOf("function handleDelistRequest("), bg.indexOf("// US-9202: the web's \"Apply now\""));
  assert.ok(/delistTargetFor\(/.test(handler), "interactive delists no longer go through delistTargetFor");
  assert.ok(/delistJobPayload\(payload, target\)/.test(handler), "interactive delists skip the payload rebuild");
  const drain = bg.slice(bg.indexOf("for (let row of plan.toRun)"));
  assert.ok(/row\.kind === "delist"\s*\n?\s*\? self\.GT_LISTER_GUARD\.delistTargetFor/.test(drain),
    "the drain no longer resolves delist rows through delistTargetFor");
  const rebuild = bg.slice(bg.indexOf("function delistJobPayload("), bg.indexOf("function delistJobPayload(") + 700);
  // The content script acts on `locate` and `matchTitles`. A page must never be
  // able to set either directly.
  assert.ok(/delete out\.locate/.test(rebuild) && /delete out\.matchTitles/.test(rebuild),
    "delistJobPayload no longer strips the page-supplied locate fields");
}

console.log("delist-locate: ok");
