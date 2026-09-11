// GradeThread Lister - the offer price that reaches Poshmark's own field (US-2739).
//
// THE FIFTH PATH. US-2739 counted four places a FlipDesk price becomes the
// keystrokes a marketplace input receives: the desk list payload, the queued
// list payload, and the two revise payloads. All four now cross the unit
// boundary in one module (src/lib/marketplace-price.ts and its edge twin).
//
// This is the fifth, and nothing was counting it. `offerOne` in
// lister/poshmark-engage.js does `GT.setValue(input, String(price))` into
// Poshmark's `offerPrice` field, and the number comes from the engagement run
// the background builds - not from a listing payload at all, so none of the
// four crossings can see it.
//
// WHAT WAS WRONG. The value was clamped inline in background.js as
// `Math.max(1, Math.floor(Number(msg.offerPrice) || 0))`, and the line below it
// refused the run when `!run.offerPrice`. The clamp ran FIRST, so an empty
// price field (Number("") is 0), a nonsense one (Number("abc") is NaN, then
// `|| 0`) and a negative one all arrived at the refusal as the number 1, which
// is truthy. The refusal could not fire for any of them. The seller pressed
// Start with a blank price box and a ONE DOLLAR offer went to every liker in
// the closet - which is the exact outcome the clamp's own comment says it
// exists to prevent.
//
// DIRECTION IS UNCHANGED AND IS NOT THIS FILE'S TO PICK. This path floors;
// every other Poshmark price path rounds to nearest (US-2739 AC4). The two
// disagree, the disagreement predates this change, and flooring may well be
// right HERE, because an offer to likers has to stay at least 10% below the
// listing price and rounding up can cross that line and have Poshmark refuse
// the offer. The assertions below record the floor as the CURRENT behaviour so
// it is a decision with a name instead of an expression in a message handler.
// Flipping it is one word in engagement.js and the two cases that say "floors".

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");

function load(rel, globalName) {
  const src = fs.readFileSync(path.join(dir, rel), "utf8");
  const scope = {};
  return new Function("self", `${src}; return self.${globalName};`)(scope);
}

const E = load("lister/engagement.js", "GT_ENGAGE");

assert.strictEqual(
  typeof E.offerPrice,
  "function",
  "GT_ENGAGE.offerPrice must exist - the clamp belongs in the pure module the " +
    "tests can call, not inline in a background message handler",
);

// -- 1. No usable price means NO RUN ----------------------------------------
//
// The measured defect. Every one of these used to come out as 1, and 1 is
// truthy, so `if (action === "offer" && !run.offerPrice)` never refused.
for (const [raw, what] of [
  [0, "an empty price box (the popup sends 0 for a blank field)"],
  [undefined, "no price in the message at all"],
  [null, "an explicit null"],
  [Number.NaN, "a value that is not a number"],
  [-5, "a negative price"],
  [Number.POSITIVE_INFINITY, "a non-finite price"],
]) {
  assert.strictEqual(
    E.offerPrice(raw),
    null,
    `offerPrice must return null for ${what} - anything truthy here sends that ` +
      "number to every liker in the closet instead of asking the seller for one",
  );
}

// -- 2. A usable price is whole dollars -------------------------------------
//
// Poshmark's offer input takes the same digits-only value its listing price
// does, so a price with cents on it is not a value the field can hold.
assert.strictEqual(E.offerPrice(18), 18, "a whole-dollar price is untouched");
assert.strictEqual(E.offerPrice(24.99), 24, "floors: see the header, this is the current direction");
assert.strictEqual(E.offerPrice(24.01), 24, "floors");
assert.strictEqual(E.offerPrice("18"), 18, "a numeric string from a message is coerced, not trusted");

// -- 3. Never below one dollar ----------------------------------------------
//
// The same never-below-one-step rule the listing price has (US-2739 AC5): a
// price the seller really did type stays a price, it does not floor to nothing.
assert.strictEqual(E.offerPrice(0.4), 1, "a real sub-dollar price becomes 1, never 0");
assert.strictEqual(E.offerPrice(0.99), 1, "ditto");

// -- 4. WIRING: the background uses it and keeps no second copy --------------
//
// A behavioural test cannot see whether anything calls the function. This can,
// and only this - the scan is here for where the rule is applied, never for
// what it computes. (See guards-that-do-not-guard, mode 0.)
{
  const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8");
  const startAt = bg.indexOf('msg.type === "GT_ENGAGE_START"');
  assert.ok(startAt > -1, "background.js must still handle GT_ENGAGE_START");
  const startBlock = bg.slice(startAt, startAt + 4000);
  assert.ok(
    /GT_ENGAGE\.offerPrice\(/.test(startBlock),
    "the start handler must build the run's price with GT_ENGAGE.offerPrice",
  );
  assert.ok(
    !/Math\.floor\(Number\(msg\.offerPrice\)/.test(bg),
    "the inline clamp must be gone - two copies of a money rule is how the two " +
      "disagree, and this one disagreed with the refusal on the line below it",
  );
  assert.ok(
    startBlock.indexOf("GT_ENGAGE.offerPrice(") < startBlock.indexOf("no_price"),
    "the price must be resolved BEFORE the no_price refusal reads it",
  );
}

console.log(
  "engage-offer-price.test.cjs: an unusable offer price refuses the run instead " +
    "of sending $1 to every liker; a usable one reaches Poshmark in whole dollars",
);
