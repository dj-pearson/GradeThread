// US-3062 AC3: what the item card says when a field is missing.
//
// The rule being tested is one rule stated many ways: AN ABSENCE IS NOT A ZERO.
// A seller who reads "0" next to Grade prices against a number nobody produced;
// a seller who reads "No comps" when the comps were never fetched concludes the
// market is thin. Both are worse than saying "not read", and both are what you
// get from `value || 0` and `arr || []` written without thinking.
//
// The view model is pure, so these are assertions about data rather than about
// rendered markup.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.resolve(__dirname, "..", "panel", "item-card.js"),
  "utf8",
);
const scope = { self: {} };
new Function("self", src)(scope.self);
const CARD = scope.self.GT_PANEL_ITEM_CARD;
assert.ok(CARD && CARD.viewFor, "item-card.js must export GT_PANEL_ITEM_CARD");

// ── the three kinds are distinct ─────────────────────────────────────────────

// A failed or unanswered read is UNKNOWN, never "none". Showing "open a
// marketplace listing" over a failed read sends the seller looking for a
// listing they already have open.
assert.strictEqual(CARD.viewFor(null).kind, "unknown");
assert.strictEqual(CARD.viewFor({ ok: false }).kind, "unknown");
assert.strictEqual(CARD.viewFor(undefined).kind, "unknown");

// A successful read with no item is NONE. Most tabs have no item and that is
// not a failure.
assert.strictEqual(CARD.viewFor({ ok: true, item: null }).kind, "none");
assert.strictEqual(CARD.viewFor({ ok: true }).kind, "none");

// ── an absence is not a zero ────────────────────────────────────────────────

const bare = CARD.viewFor({ ok: true, item: { id: "i1", title: "Tee" } });
assert.strictEqual(bare.kind, "item");
assert.strictEqual(
  bare.item.grade,
  null,
  "a missing grade must be null, not 0 — the scale starts at 1.0, so a 0 here " +
    "can only mean nobody read one",
);
assert.strictEqual(bare.item.targetPriceCents, null, "a missing price is null");
assert.strictEqual(
  bare.item.comps,
  null,
  "comps that were never fetched must be null, NOT []. [] means we looked and " +
    "the market is thin, which is a different thing to tell a seller.",
);

// A zero grade from a bad payload is treated as absent rather than rendered.
const zeroGrade = CARD.viewFor({ ok: true, item: { id: "i1", grade: 0 } });
assert.strictEqual(zeroGrade.item.grade, null);
const negPrice = CARD.viewFor({
  ok: true,
  item: { id: "i1", targetPriceCents: -100 },
});
assert.strictEqual(negPrice.item.targetPriceCents, null);

// An EMPTY comp list survives as an empty list, because it is an answer.
const noComps = CARD.viewFor({ ok: true, item: { id: "i1", comps: [] } });
assert.deepStrictEqual(noComps.item.comps, []);
assert.notStrictEqual(
  noComps.item.comps,
  null,
  "an empty comp array must not collapse into null — 'none found' and 'not " +
    "read' are different sentences",
);

// ── revise/relist availability ───────────────────────────────────────────────

for (const platform of CARD.REVISABLE) {
  const v = CARD.viewFor({ ok: true, item: { id: "i1", platform: platform } });
  assert.strictEqual(v.item.canRevise, true, `${platform} should be revisable`);
}

// Case-insensitive: the background may hand back "Poshmark" from a URL parse.
const upper = CARD.viewFor({ ok: true, item: { id: "i1", platform: "Poshmark" } });
assert.strictEqual(upper.item.canRevise, true);

// An unwired platform cannot revise, and carries the reason rather than a bare
// disabled control.
const grailed = CARD.viewFor({
  ok: true,
  item: { id: "i1", platform: "grailed", disabledReason: "List manually for now." },
});
assert.strictEqual(grailed.item.canRevise, false);
assert.strictEqual(grailed.item.disabledReason, "List manually for now.");

// No id means nothing to revise, whatever the platform says. Firing a revise
// with no item id is a request the background can only refuse.
const noId = CARD.viewFor({ ok: true, item: { platform: "poshmark" } });
assert.strictEqual(noId.item.canRevise, false);

// ── the title always says something ─────────────────────────────────────────
assert.strictEqual(bare.item.title, "Tee");
assert.strictEqual(
  CARD.viewFor({ ok: true, item: { id: "i1" } }).item.title,
  "Untitled item",
  "a missing title must not render as an empty line the seller cannot click",
);

console.log("✓ panel-item-card: absences render as absences, not zeros");

// ── pendingFor: Revise is offered only when a real row exists ───────────────
//
// A revise payload's `fields` is the set of things a FlipDesk edit made stale,
// computed by the server. If the panel guessed it, a revise would rewrite a
// live listing with values nobody asked to change. So the button is driven by
// the pending row, and these are the ways a row can fail to be one.

const ITEM_VIEW = CARD.viewFor({
  ok: true,
  item: { id: "item-1", platform: "poshmark" },
});

const GOOD_ROW = {
  itemId: "item-1",
  platform: "poshmark",
  listingUrl: "https://poshmark.com/listing/abc",
  fields: ["price"],
};

assert.strictEqual(
  CARD.pendingFor({ ok: true, pending: [GOOD_ROW] }, ITEM_VIEW),
  GOOD_ROW,
  "a complete row for this item is the payload",
);

// A failed or absent read offers nothing. Not "nothing to update" — the panel
// says that only when it actually looked.
assert.strictEqual(CARD.pendingFor(null, ITEM_VIEW), null);
assert.strictEqual(CARD.pendingFor({ ok: false }, ITEM_VIEW), null);
assert.strictEqual(CARD.pendingFor({ ok: true }, ITEM_VIEW), null);

// A row for a DIFFERENT item must never be sent. This is the one that would be
// silent in production: the revise succeeds, against the wrong listing.
assert.strictEqual(
  CARD.pendingFor(
    { ok: true, pending: [{ ...GOOD_ROW, itemId: "item-2" }] },
    ITEM_VIEW,
  ),
  null,
);

// An incomplete row fails isValidRevisePayload in the background, so offering
// it would be a button that always errors.
assert.strictEqual(
  CARD.pendingFor({ ok: true, pending: [{ ...GOOD_ROW, fields: [] }] }, ITEM_VIEW),
  null,
  "a row with no fields is not a revise",
);
assert.strictEqual(
  CARD.pendingFor({ ok: true, pending: [{ ...GOOD_ROW, listingUrl: "" }] }, ITEM_VIEW),
  null,
  "a row with no listing URL is not a revise",
);

// The snake_case spelling the server may use is accepted, so the two halves
// cannot disagree over a key name.
assert.strictEqual(
  CARD.pendingFor(
    {
      ok: true,
      pending: [{ ...GOOD_ROW, itemId: undefined, inventory_item_id: "item-1" }],
    },
    ITEM_VIEW,
  ).listingUrl,
  GOOD_ROW.listingUrl,
);

// No item on screen means nothing to revise, whatever is pending.
assert.strictEqual(
  CARD.pendingFor({ ok: true, pending: [GOOD_ROW] }, { kind: "none", item: null }),
  null,
);
assert.strictEqual(
  CARD.pendingFor({ ok: true, pending: [GOOD_ROW] }, { kind: "unknown", item: null }),
  null,
);

console.log("✓ panel-item-card: revise is driven by a real pending row");
