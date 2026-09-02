// GradeThread unified extension — flip-mode guards (US-2238).
//
// Flip mode tells a reseller whether to spend real money. Two failure modes are
// worth a test each, and neither is a crash:
//
//   1. A CONFIDENT-LOOKING NUMBER BUILT ON NOTHING. Every currency figure comes
//      off the eBay comp band. When the comps are too thin the endpoint says so,
//      and the panel must drop ALL of them — resale, margin, breakeven — not
//      just the one it happens to check.
//   2. A UNIT SLIP. decideBuy returns roiPct as a RATIO (0.3 = 30%). Rendering
//      it raw prints "0.3%" on a deal that returns 30%, which reads as a pass.
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

const FLIP = loadIntoSelf("research/flip-format.js").GT_CC_FLIP;
assert.ok(FLIP, "research/flip-format.js must assign self.GT_CC_FLIP");

// A comp band and a decision as the endpoint actually returns them.
const VALUE = {
  lowCents: 4000,
  medianCents: 6000,
  highCents: 8500,
  sampleSize: 14,
  confidence: 0.9,
  sufficient: true,
  currency: "USD",
};
const DECISION = {
  recommendation: "buy",
  estProceedsCents: 5220,
  estMarginCents: 3220,
  roiPct: 1.61,
  breakevenCents: 5220,
  reason: "Resale ≈ $60 net $52 vs $20 cost — 161% ROI.",
  confident: true,
};
const SELL_THROUGH = {
  sellThroughPct: 0.6,
  daysLow: 14,
  daysHigh: 45,
  label: "moderate",
  sampleSize: 14,
};

function response(over) {
  return Object.assign(
    {
      grade: { value: 7.5, tier: "Good", confidence: 0.82, imagesAnalyzed: 4 },
      value: VALUE,
      sellThrough: SELL_THROUGH,
      costCents: 2000,
      decision: DECISION,
      insufficientComps: false,
      disclaimer: "A private AI estimate…",
    },
    over,
  );
}

// ── rule 1: no money without comps ────────────────────────────────────────
const thin = FLIP.panelFor(response({ insufficientComps: true }));
assert.deepStrictEqual(
  thin.rows,
  [],
  "insufficientComps must drop EVERY currency row. Breakeven and resale come off " +
    "the same band as the margin — dropping only the margin leaves two figures " +
    "that look just as authoritative and rest on the same missing data.",
);
assert.strictEqual(thin.note, FLIP.STRINGS.noComps, "and it must say why the figures are gone");

// Even a decision object present alongside insufficientComps must not leak money.
const thinWithDecision = FLIP.panelFor(
  response({ insufficientComps: true, decision: DECISION, value: VALUE }),
);
for (const row of thinWithDecision.rows) {
  assert.ok(!/\$/.test(row.value), `"${row.value}" leaked a currency figure past the comps gate`);
}

// A band the SERVER marked insufficient must not render either, even when the
// insufficientComps flag is somehow absent — the two disagree only in a bug.
assert.strictEqual(
  FLIP.rangeLabel(Object.assign({}, VALUE, { sufficient: false })),
  null,
  "an insufficient ValueRange must never render a range",
);

// ── rule 2: roiPct is a ratio, not a percentage ───────────────────────────
assert.strictEqual(
  FLIP.marginLabel(DECISION),
  "+$32 (161%)",
  "roiPct 1.61 must render as 161%, not 1.61% or 16100%",
);
assert.strictEqual(
  FLIP.marginLabel({ estMarginCents: 500, roiPct: 0.3 }),
  "+$5 (30%)",
  "the threshold case: 0.3 is a 30% return, and 'maybe' territory",
);
assert.strictEqual(
  FLIP.marginLabel({ estMarginCents: -1500, roiPct: -0.4 }),
  "$-15 (-40%)",
  "a loss must render as a loss, with no '+' sign",
);
assert.strictEqual(
  FLIP.marginLabel({ estMarginCents: null, roiPct: null }),
  null,
  "no cost basis → no margin row at all, rather than a '—' the reader fills in",
);
assert.strictEqual(FLIP.marginLabel(null), null);
assert.strictEqual(
  FLIP.marginLabel({ estMarginCents: 500, roiPct: NaN }),
  "+$5",
  "a non-finite ROI drops the percentage but keeps the real margin",
);

// ── the happy path renders the four rows a sourcer acts on ────────────────
const full = FLIP.panelFor(response());
assert.deepStrictEqual(
  full.rows.map((r) => r.label),
  [FLIP.STRINGS.resale, FLIP.STRINGS.margin, FLIP.STRINGS.breakeven, FLIP.STRINGS.sellThrough],
);
assert.deepStrictEqual(
  full.rows.map((r) => r.value),
  ["$40–$85", "+$32 (161%)", "$52", "14–45 days"],
);
assert.strictEqual(full.verdict.label, FLIP.STRINGS.buy);
assert.strictEqual(full.verdict.cls, "gt-cc-v-buy");
assert.strictEqual(full.note, "", "a confident, well-comped result needs no caveat");
assert.strictEqual(full.reason, DECISION.reason, "decideBuy's own reason line is preferred");

// ── an unconfident verdict must say WHY it is soft ────────────────────────
const soft = FLIP.panelFor(
  response({ decision: Object.assign({}, DECISION, { recommendation: "maybe", confident: false }) }),
);
assert.strictEqual(soft.verdict.label, FLIP.STRINGS.maybe);
assert.strictEqual(
  soft.note,
  FLIP.STRINGS.lowConfidence,
  "'maybe' means two different things — a thin margin and an unreadable photo set. " +
    "Without the reason, a low-confidence read is indistinguishable from a marginal deal.",
);

// ── unknown sell-through renders nothing, not "0 days" ────────────────────
assert.strictEqual(FLIP.sellThroughLabel({ label: "unknown", daysLow: 0, daysHigh: 0 }), null);
assert.strictEqual(FLIP.sellThroughLabel(null), null);
assert.strictEqual(
  FLIP.sellThroughLabel({ label: "fast", daysLow: 7, daysHigh: 7 }),
  "7 days",
  "an equal range collapses to one figure rather than '7–7 days'",
);

// ── money() never emits NaN or a negative zero ────────────────────────────
for (const junk of [null, undefined, NaN, Infinity, "abc", {}]) {
  assert.strictEqual(FLIP.money(junk), null, `money(${JSON.stringify(junk)}) must be null`);
}
assert.strictEqual(FLIP.money(-4), "$0", "a sub-cent negative must not render '$-0'");
assert.strictEqual(FLIP.money(0), "$0");

// ── priceToCents matches the server's parser ──────────────────────────────
// The panel's cost basis has to be the number the server actually used, or the
// margin shown and the margin computed are answers to different questions.
assert.strictEqual(FLIP.priceToCents("$59.99"), 5999);
assert.strictEqual(FLIP.priceToCents("US $1,299.00"), 129900);
assert.strictEqual(FLIP.priceToCents("£45"), 4500);
assert.strictEqual(FLIP.priceToCents("Make an offer"), null);
assert.strictEqual(FLIP.priceToCents(null), null);
assert.strictEqual(FLIP.priceToCents(""), null);

// ── the panel is seller-gated in the content script ───────────────────────
const mkt = fs.readFileSync(path.join(dir, "research", "marketplace.js"), "utf8");
assert.ok(
  /caps\s*&&\s*caps\.sellerEnabled\s*===\s*true/.test(mkt),
  "the Flip panel must render only when the capability map reports sellerEnabled. " +
    "A shopper seeing a resale-margin panel on the item they are trying to buy is " +
    "the wrong product entirely.",
);
assert.ok(
  !/autoRun[\s\S]{0,200}runAppraise\(\)/.test(mkt) && !/runAppraise\(\);\s*\/\/ auto/.test(mkt),
  "the appraisal must stay CLICK-to-run — it spends a metered AI action, so an " +
    "automatic call would bill the seller for every listing they scrolled past",
);

const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8");
assert.ok(/GT_CC_APPRAISE/.test(bg), "background.js must route GT_CC_APPRAISE");
assert.ok(
  /sellerEnabled/.test(bg),
  "the background must re-check the entitlement too — the content script's copy of " +
    "caps is a render hint, not the gate",
);
assert.ok(
  /scout\/appraise-url/.test(bg),
  "flip mode must call the authenticated seller endpoint, not a public one",
);

// ── US-3052: the popup's on-device verdict cache ────────────────────────────
{
  assert.strictEqual(
    FLIP.cacheKey("https://www.ebay.com/itm/123?utm_source=x&hash=item1&_trkparms=a#frag"),
    "https://www.ebay.com/itm/123",
    "tracking params and the hash are not part of the listing",
  );
  assert.strictEqual(
    FLIP.cacheKey("https://poshmark.com/listing/abc/?b=2&a=1"),
    "https://poshmark.com/listing/abc?a=1&b=2",
    "real params are kept, sorted, and a trailing slash is dropped",
  );
  assert.strictEqual(FLIP.cacheKey("javascript:alert(1)"), null);
  assert.strictEqual(FLIP.cacheKey(""), null);
  assert.strictEqual(FLIP.cacheKey(null), null);

  const NOW = 1_800_000_000_000;
  assert.strictEqual(FLIP.cacheFresh({ at: NOW - 1000, data: {} }, NOW), true);
  assert.strictEqual(FLIP.cacheFresh({ at: NOW - FLIP.CACHE_TTL_MS, data: {} }, NOW), false, "at the TTL it is stale");
  assert.strictEqual(FLIP.cacheFresh({ at: NOW + 5000, data: {} }, NOW), false, "a future stamp is not fresh");
  assert.strictEqual(FLIP.cacheFresh({ at: NOW, data: null }, NOW), false, "no data, nothing to show");
  assert.strictEqual(FLIP.cacheFresh(null, NOW), false);

  let map = {};
  for (let i = 0; i < FLIP.CACHE_MAX + 5; i++) map = FLIP.cachePut(map, "https://x/" + i, { i }, NOW + i);
  assert.strictEqual(Object.keys(map).length, FLIP.CACHE_MAX, "the cache is capped");
  assert.ok(!("https://x/0" in map) && ("https://x/" + (FLIP.CACHE_MAX + 4)) in map, "oldest out, newest kept");
  const re = FLIP.cachePut(map, "https://x/10", { fresh: true }, NOW + 999);
  assert.deepStrictEqual(re["https://x/10"], { at: NOW + 999, data: { fresh: true } }, "a re-check replaces the entry");
  assert.strictEqual(Object.keys(re).length, FLIP.CACHE_MAX);
}

// ── US-3052: the popup never sends GT_CC_APPRAISE for a non-seller map ──────
{
  const html = fs.readFileSync(path.join(dir, "popup.html"), "utf8");
  const js = fs.readFileSync(path.join(dir, "popup.js"), "utf8");
  for (const id of ["flipBtn", "flipBlock", "flipVerdict", "flipRows", "flipNote", "flipOpen", "flipRecheck", "flipWhen"]) {
    assert.ok(html.includes('id="' + id + '"'), "popup.html is missing #" + id);
    assert.ok(js.includes('"' + id + '"'), "popup.js never uses #" + id);
  }
  assert.ok(/id="flipBtn"[^>]*hidden/.test(html), "the flip button starts hidden — it is shown only for a seller on a listing");
  const fmtAt = html.indexOf('src="research/flip-format.js"');
  const popupAt = html.indexOf('src="popup.js"');
  assert.ok(fmtAt > -1 && fmtAt < popupAt, "research/flip-format.js must load before popup.js");

  // Every GT_CC_APPRAISE the popup sends is inside runFlipFromPopup, and that
  // function returns on a non-seller map before it sends anything.
  const sends = js.split('type: "GT_CC_APPRAISE"').length - 1;
  assert.ok(sends >= 1, "the popup sends GT_CC_APPRAISE somewhere");
  const fnStart = js.indexOf("async function runFlipFromPopup(");
  const fnEnd = js.indexOf("\nfunction wireFlip(");
  assert.ok(fnStart > -1 && fnEnd > fnStart, "runFlipFromPopup must exist ahead of wireFlip");
  const fn = js.slice(fnStart, fnEnd);
  assert.strictEqual(fn.split('type: "GT_CC_APPRAISE"').length - 1, sends, "GT_CC_APPRAISE is sent only from runFlipFromPopup");
  const gate = fn.indexOf("if (!caps || !caps.sellerEnabled) return;");
  assert.ok(gate > -1 && gate < fn.indexOf('type: "GT_CC_APPRAISE"'), "the seller check must precede the send");
  assert.ok(gate < fn.indexOf("GT_CC_FLIP_CONTEXT"), "and precede even the context request to the tab");
  // The button is hidden for a non-seller, so the gate is not the only wall.
  assert.ok(/btn\.hidden = !\(seller && supported\)/.test(js), "renderFlip hides the button unless seller AND supported");

  const mp = fs.readFileSync(path.join(dir, "research", "marketplace.js"), "utf8");
  assert.ok(/msg\.type !== "GT_CC_FLIP_CONTEXT"/.test(mp), "marketplace.js must answer GT_CC_FLIP_CONTEXT");
  const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8");
  const gateFn = bg.slice(bg.indexOf("async function appraiseListing("), bg.indexOf("async function appraiseListing(") + 600);
  assert.ok(/if \(!caps\.sellerEnabled\)/.test(gateFn), "the worker still gates the appraisal on the seller entitlement");
}

console.log(
  "flip-format.test.cjs: comps gate drops all currency rows, roiPct renders as a " +
    "percentage, verdicts carry their reason, panel is seller-gated, the popup's " +
    "cache is keyed and capped, and the popup never appraises for a non-seller",
);
