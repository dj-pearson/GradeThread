// GradeThread unified extension — US-2622 own-listing guard.
//
// WHAT THIS PROTECTS, AND WHY IT IS NOT OBVIOUS.
//
// A seller opening one of their own listings got the full buyer condition read
// unfurled over the page: an answer to a question they had already answered in
// FlipDesk, at whatever height the report happened to be. The overlay now opens
// as its header bar there, one click from the same read.
//
// The whole feature rests on ONE judgement — which DOM controls prove ownership —
// and getting it wrong fails in the direction nobody notices. A selector that
// also matches on a stranger's listing does not throw, does not log, and does not
// look broken: it just quietly folds the overlay away for the shoppers the
// extension exists for, and the only symptom is that people stop using it.
//
// eBay ships exactly that trap. Every visitor sees "Sell one like this", which
// links into the same /sl/list flow as the owner's "Sell a similar item" — so an
// href match on `/sl/` is true for everybody. Measured 2026-08-16 on both an
// owned listing and a stranger's:
//
//   selector                                            owned   stranger
//   a[href*='ReviseItem']                                 1         0
//   .ux-layout-section__textual-display--reviseList       1         0
//   .ux-layout-section__textual-display--sellSimilarItem  1         0
//   a[href*='/sl/list']                                   2         1   <-- trap
//
// So this asserts the shape of the contract, and it names the trap so the next
// person adding an adapter reads about it before repeating it.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const dir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(dir, "..");

function loadConfig(rel) {
  const src = fs.readFileSync(path.join(repoRoot, rel), "utf8");
  const ctx = {};
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  assert.ok(ctx.GT_CC_CONFIG, `${rel} must assign self.GT_CC_CONFIG`);
  return ctx.GT_CC_CONFIG;
}

const cfg = loadConfig("extension-unified/research/selectors.js");

// ── 1. eBay declares it, and the selectors are owner-only ──────────────────
{
  const own = cfg.adapters.ebay.ownListing;
  assert.ok(
    Array.isArray(own) && own.length > 0,
    "the eBay adapter must declare ownListing — it is the one marketplace this was " +
      "verified against, and the surface the seller actually hits",
  );

  // The trap, stated as a rule rather than as a comment nobody reads.
  const BUYER_VISIBLE = [/\/sl\//, /sellSimilarItem/i, /sell-?one/i, /prelist/i];
  for (const sel of own) {
    assert.strictEqual(typeof sel, "string", "every ownListing entry must be a selector string");
    for (const trap of BUYER_VISIBLE) {
      assert.ok(
        !trap.test(sel),
        `ownListing selector ${sel} matches ${trap} — eBay shows "Sell one like this" to ` +
          "EVERY visitor through that same flow, so this would fold the overlay away for " +
          "the shoppers it is for, silently",
      );
    }
  }
}

// ── 2. No adapter guesses ──────────────────────────────────────────────────
//
// Absent means "not yours", which changes nothing — the honest default for a
// marketplace whose DOM we have not checked this against. An unverified guess
// here is worse than no feature, for the reason in the header.
for (const [key, adapter] of Object.entries(cfg.adapters)) {
  if (!adapter.ownListing) continue;
  assert.ok(
    adapter.verified === true,
    `adapter ${key} declares ownListing but is not marked verified — ownership detection ` +
      "fails silently and in the wrong direction, so it may only ship for an adapter " +
      "somebody has actually checked against both an owned and a stranger's listing",
  );
}

// ── 3. The content script uses it, and only to change how the panel OPENS ──
//
// It must never become a reason to skip the read, skip the render, or return
// early: the seller asked for nothing, but they must still be able to get the
// same read with one click.
{
  const src = fs.readFileSync(path.join(dir, "research", "marketplace.js"), "utf8");
  assert.ok(
    /function isOwnListing\(\)/.test(src),
    "research/marketplace.js must resolve ownership from the adapter config",
  );
  assert.ok(
    /openCollapsed = isOwnListing\(\)/.test(src),
    "the ownership answer must feed the collapsed-open state and nothing else",
  );
  assert.ok(
    /root\.classList\.add\("gt-cc-collapsed"\)/.test(src),
    "an owned listing opens collapsed — a CSS state over a fully built card, so expanding " +
      "it costs no second render and no second Vision call",
  );
  assert.ok(
    !/isOwnListing\(\)\s*\)\s*return/.test(src),
    "ownership must not short-circuit the overlay: the seller still gets the read on demand",
  );
  // The one thing that makes the collapsed bar legible rather than a glitch.
  assert.ok(
    src.includes("S.ownListingBadge"),
    "the collapsed bar must say why it is a bar (FMT.STRINGS.ownListingBadge)",
  );
}

// ── 4. Asking for a read cancels it, for good ──────────────────────────────
//
// Without this, a seller who clicks "Get condition read" watches the result fold
// itself away again, which reads as the panel fighting them.
{
  const src = fs.readFileSync(path.join(dir, "research", "marketplace.js"), "utf8");
  assert.ok(
    /function userAsked\(\)\s*\{\s*openCollapsed = false;/.test(src),
    "research/marketplace.js must clear the collapsed-open state on a deliberate request",
  );
  const runGrade = /async function runGrade\([^)]*\)\s*\{([\s\S]*?)\n  \}/.exec(src);
  assert.ok(runGrade, "runGrade must still exist");
  assert.ok(
    runGrade[1].includes("userAsked()"),
    "runGrade must clear it — every path into a read (launcher, re-read, Alt+G, the image " +
      "context menu) goes through here, so clearing it anywhere else would miss one",
  );
}

console.log(
  "own-listing.test.cjs: eBay ownership selectors are owner-only (the /sl/ trap is refused), " +
    "no unverified adapter guesses, and ownership only changes how the panel opens",
);
