// US-3098: the sourcing filters, the total-price rule, and the two-phase rank.
//
// Three things are being held here, and only the first is about validation.
//
//  1. Every refusal NAMES its field. A scan is run from a phone in a thrift
//     store; "Invalid request" there costs the seller the aisle they are
//     standing in, and they have no console to look at.
//  2. Absent shipping is UNKNOWN, not free. eBay omits shippingOptions on
//     plenty of summaries, and reading that as zero quietly passes a listing
//     whose real total is anything at all — the expensive direction to be
//     wrong in for a tool whose entire job is "should I pay this".
//  3. Phase one spends no AI. The point of looking at fifty listings is to
//     pick the best eight to grade; if a filter excludes everything, the scan
//     must cost the seller nothing at all.

// US-2379: FIRST, before anything that reaches lib/supabase.ts at import time.
// Importing the route pulls that in transitively, so without this the file only
// passes when another test happened to run before it.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  parseScanFilters,
  PHASE_ONE_NOMINAL_GRADE,
  rankByRoughValue,
  SCAN_CONSIDER_LIMIT,
} from "../routes/flipdesk-scout.ts";
import { totalPriceCents } from "../lib/scout-scoring.ts";

function ok(body: Record<string, unknown>) {
  const out = parseScanFilters(body);
  assert(!("error" in out), `expected valid filters, got: ${JSON.stringify(out)}`);
  return out;
}

function err(body: Record<string, unknown>): string {
  const out = parseScanFilters(body);
  assert("error" in out, `expected a refusal for ${JSON.stringify(body)}`);
  return out.error;
}

// ── 1. Defaults ────────────────────────────────────────────────────────────

Deno.test("an empty body is every filter off, and Best Match", () => {
  const f = ok({});
  assertEquals(f.minMarginCents, null);
  assertEquals(f.minMarginPct, null);
  assertEquals(f.maxTotalCents, null);
  assertEquals(f.buyingOptions, null);
  assertEquals(f.conditionIds, null);
  assertEquals(f.freeShippingOnly, false);
  assertEquals(f.sort, "bestMatch", "no sort means eBay relevance, as before");
});

// ── 2. Every validation branch, and every refusal names its field ──────────

Deno.test("a non-numeric money filter is refused by name", () => {
  assertEquals(err({ minMarginCents: "20" }), "minMarginCents must be a number");
  assertEquals(err({ maxTotalCents: "80" }), "maxTotalCents must be a number");
  assertEquals(err({ minMarginPct: "0.3" }), "minMarginPct must be a number");
  assertEquals(err({ minMarginCents: Number.NaN }), "minMarginCents must be a number");
});

Deno.test("a negative money filter is refused by name", () => {
  assertEquals(err({ minMarginCents: -1 }), "minMarginCents cannot be negative");
  assertEquals(err({ maxTotalCents: -1 }), "maxTotalCents cannot be negative");
  assertEquals(err({ minMarginPct: -0.1 }), "minMarginPct cannot be negative");
});

Deno.test("minMarginPct is a fraction, and 30 is refused rather than guessed at", () => {
  // A caller sending 30 for "30%" means 3000% here. Silently accepting it
  // returns an empty scan with nothing on screen to explain why, so the
  // refusal says which unit the field is in.
  const message = err({ minMarginPct: 30 });
  assert(message.includes("fraction"), message);
  assert(message.includes("0.3"), "the refusal shows the right shape");
  assertEquals(ok({ minMarginPct: 0.3 }).minMarginPct, 0.3);
  assertEquals(ok({ minMarginPct: 1 }).minMarginPct, 1, "100% is a legitimate bar");
});

Deno.test("buyingOptions accepts eBay's three and refuses anything else", () => {
  assertEquals(ok({ buyingOptions: ["FIXED_PRICE"] }).buyingOptions, ["FIXED_PRICE"]);
  assertEquals(
    ok({ buyingOptions: ["FIXED_PRICE", "BEST_OFFER", "FIXED_PRICE"] }).buyingOptions,
    ["FIXED_PRICE", "BEST_OFFER"],
    "duplicates collapse rather than being sent to eBay twice",
  );
  assert(err({ buyingOptions: [] }).includes("non-empty"));
  assert(err({ buyingOptions: "FIXED_PRICE" }).includes("non-empty"));
  assert(err({ buyingOptions: ["BUY_IT_NOW"] }).includes("FIXED_PRICE"));
});

Deno.test("conditionIds takes four-digit ids, normalizes a number, refuses the rest", () => {
  assertEquals(ok({ conditionIds: ["3000", "4000"] }).conditionIds, ["3000", "4000"]);
  assertEquals(
    ok({ conditionIds: [3000] }).conditionIds,
    ["3000"],
    "a hand-written JSON body carries a number about half the time",
  );
  assert(err({ conditionIds: [] }).includes("non-empty"));
  assert(err({ conditionIds: ["used"] }).includes("four-digit"));
  assert(err({ conditionIds: ["300"] }).includes("four-digit"));
});

Deno.test("freeShippingOnly and sort are refused by name", () => {
  assertEquals(err({ freeShippingOnly: "yes" }), "freeShippingOnly must be true or false");
  assertEquals(ok({ freeShippingOnly: true }).freeShippingOnly, true);
  const message = err({ sort: "cheapest" });
  assert(message.includes("priceAsc"), message);
  for (const sort of ["bestMatch", "newlyListed", "endingSoonest", "priceAsc"]) {
    assertEquals(ok({ sort }).sort, sort);
  }
});

// ── 3. The total-price rule (shared with US-3081's sweep) ──────────────────

Deno.test("total is asking plus shipping, and free shipping is a real zero", () => {
  assertEquals(totalPriceCents(1200, 900), { cents: 2100, includesShipping: true });
  assertEquals(totalPriceCents(2000, 0), { cents: 2000, includesShipping: true });
});

Deno.test("absent shipping is unknown, so the comparison falls back to asking", () => {
  // NOT zero. A listing eBay sent no shipping for could cost anything to
  // deliver, and calling it free would pass it through a cap it may not clear.
  assertEquals(totalPriceCents(1200, null), { cents: 1200, includesShipping: false });
  assertEquals(totalPriceCents(1200, undefined), { cents: 1200, includesShipping: false });
  assertEquals(
    totalPriceCents(1200, -5),
    { cents: 1200, includesShipping: false },
    "a nonsense shipping value is unknown, not a discount",
  );
});

Deno.test("no asking price is no total at all", () => {
  assertEquals(totalPriceCents(null, 500), { cents: null, includesShipping: false });
  assertEquals(totalPriceCents(0, 500), { cents: null, includesShipping: false });
});

Deno.test("the $12 tee with $9 shipping loses to the $20 free-shipping listing", () => {
  // The concrete case the whole rule exists for: on asking price alone the
  // wrong one wins a $15 cap.
  const cheapLooking = totalPriceCents(1200, 900).cents;
  const actuallyCheaper = totalPriceCents(2000, 0).cents;
  assert(cheapLooking != null && actuallyCheaper != null);
  assert(cheapLooking > 1500, "the tee does not clear a $15 cap once shipping is counted");
  assert(actuallyCheaper < cheapLooking);
});

// ── 4. Phase one ranks by value, not by eBay's order ───────────────────────

function cand(itemId: string, askingCents: number | null, shippingCents: number | null = 0) {
  return {
    itemId,
    title: itemId,
    imageUrl: "https://img.test/x.jpg",
    itemWebUrl: null,
    askingCents,
    shippingCents,
  };
}

Deno.test("cheapest relative to the rough value leads", () => {
  const ranked = rankByRoughValue(
    [cand("expensive", 9000), cand("cheap", 2000), cand("middling", 5000)],
    10000,
  );
  assertEquals(ranked.map((c) => c.itemId), ["cheap", "middling", "expensive"]);
});

Deno.test("shipping decides the order when the asking prices are close", () => {
  const ranked = rankByRoughValue(
    [cand("plus-shipping", 2000, 1500), cand("free-shipping", 2200, 0)],
    10000,
  );
  assertEquals(
    ranked.map((c) => c.itemId),
    ["free-shipping", "plus-shipping"],
    "the $22 free-shipping listing really is the cheaper one",
  );
});

Deno.test("a listing with no asking price sorts last, never first", () => {
  const ranked = rankByRoughValue([cand("no-price", null), cand("priced", 5000)], 10000);
  assertEquals(ranked.map((c) => c.itemId), ["priced", "no-price"]);
});

Deno.test("no rough value still gives a useful order rather than eBay's", () => {
  // The value read is allowed to fail; the phase falls back to cheapest-first,
  // which is still a better eight than whichever eight eBay listed first.
  const ranked = rankByRoughValue([cand("b", 5000), cand("a", 1000)], null);
  assertEquals(ranked.map((c) => c.itemId), ["a", "b"]);
});

Deno.test("ranking does not mutate its input", () => {
  const input = [cand("b", 5000), cand("a", 1000)];
  rankByRoughValue(input, 10000);
  assertEquals(input.map((c) => c.itemId), ["b", "a"]);
});

// ── 5. The constants the phases rest on ────────────────────────────────────

Deno.test("phase one looks wider than phase two grades", () => {
  assertEquals(SCAN_CONSIDER_LIMIT, 50, "eBay Browse caps a page at 50");
  assert(
    SCAN_CONSIDER_LIMIT > 8,
    "if phase one is not wider than MAX_CANDIDATES the two-phase rank buys nothing",
  );
  assertEquals(
    PHASE_ONE_NOMINAL_GRADE,
    7.0,
    "the middle of the used band — a ranking input, never a number shown to anyone",
  );
});

// ── SRC-6: priced against its own condition, not cheapest-first ────────────

function condCand(itemId: string, askingCents: number, sellerCondition: string) {
  return { ...cand(itemId, askingCents), sellerCondition };
}

Deno.test("SRC-6: at the same price, the listing cheap FOR ITS CONDITION leads", () => {
  // New-with-tags listings go for about $80 here and pre-owned for about $20,
  // so a $40 NWT is half its bucket's price and a $40 pre-owned is double.
  const nwt = [8000, 7500, 8500, 9000, 7000].map((p, i) => condCand(`nwt-${i}`, p, "New with tags"));
  const used = [2000, 1800, 2200, 2500, 1500].map((p, i) => condCand(`used-${i}`, p, "Pre-owned"));
  const ranked = rankByRoughValue(
    [condCand("used-40", 4000, "Pre-owned"), condCand("nwt-40", 4000, "New with tags"), ...nwt, ...used],
    null,
  ).map((c) => c.itemId);
  assert(ranked.indexOf("nwt-40") < ranked.indexOf("used-40"));
});

Deno.test("SRC-6: with a ten-listing bucket the order is not simply ascending by total", () => {
  const used = Array.from({ length: 10 }, (_, i) => condCand(`used-${i}`, 1500 + i * 200, "Pre-owned"));
  const nwt = [9000, 8500, 9500, 10000, 4500].map((p, i) => condCand(`nwt-${i}`, p, "New with tags"));
  const input = [...used, ...nwt];
  const ranked = rankByRoughValue(input, null).map((c) => c.itemId);
  const byTotal = [...input].sort((a, b) => a.askingCents - b.askingCents).map((c) => c.itemId);
  assert(JSON.stringify(ranked) !== JSON.stringify(byTotal), "phase one must not be cheapest-first");
  // The $45 NWT (about half its bucket) beats the $17 pre-owned (about 0.8 of its).
  assert(ranked.indexOf("nwt-4") < ranked.indexOf("used-1"));
});

Deno.test("SRC-6: lots and kids' sizes fall back unless the search asked for them", () => {
  const ranked = rankByRoughValue(
    [
      { ...cand("kids", 2000), title: "Patagonia fleece kids size 10" },
      { ...cand("adult", 2100), title: "Patagonia fleece mens large" },
    ],
    10000,
    { q: "fleece", brand: "Patagonia" },
  );
  assertEquals(ranked.map((c) => c.itemId), ["adult", "kids"]);
  const asked = rankByRoughValue(
    [
      { ...cand("kids", 2000), title: "Patagonia fleece kids size 10" },
      { ...cand("adult", 2100), title: "Patagonia fleece mens large" },
    ],
    10000,
    { q: "kids fleece", brand: "Patagonia" },
  );
  assertEquals(asked[0].itemId, "kids");
});

Deno.test("SRC-6: unknown shipping ranks just behind an equal known total", () => {
  const ranked = rankByRoughValue([cand("unknown", 2000, null), cand("known", 2000, 0)], 10000);
  assertEquals(ranked.map((c) => c.itemId), ["known", "unknown"]);
});
