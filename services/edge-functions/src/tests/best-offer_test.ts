// US-562 / US-2405: best-offer threshold validation + eBay-constraint clamping.
// The thresholds are the seller's own numbers; nothing is derived. Pure math
// (no env / I/O), so a direct import is fine.
import { assert, assertEquals } from "@std/assert";
import {
  centsToMoneyString,
  resolveBestOfferThresholds,
} from "../lib/best-offer.ts";

Deno.test("keeps the seller's thresholds when both sit below list", () => {
  const r = resolveBestOfferThresholds({
    priceCents: 5000, // $50 list
    acceptCents: 4500, // $45
    declineCents: 3000, // $30
  });
  assertEquals(r.autoAcceptCents, 4500);
  assertEquals(r.autoDeclineCents, 3000);
});

Deno.test("clamps accept to one cent under list when it exceeds the price", () => {
  const r = resolveBestOfferThresholds({
    priceCents: 4000, // $40 list
    acceptCents: 6000, // above list → must be nudged below list
    declineCents: 2500,
  });
  assertEquals(r.autoAcceptCents, 3999);
  assertEquals(r.autoDeclineCents, 2500);
  assert(r.autoAcceptCents! < 4000);
  assert(r.autoDeclineCents! < r.autoAcceptCents!);
});

// US-2405 is exactly this test. It used to read "no comp stats and no overrides
// → both null", which meant the opposite: WITH comp stats, blank boxes were
// filled in from them, saved to the columns, and left behind by the next
// reprice. A $298 shirt kept auto-accepting at $27.50.
Deno.test("blank thresholds stay blank — never derived from anything", () => {
  const r = resolveBestOfferThresholds({
    priceCents: 29800,
    acceptCents: null,
    declineCents: null,
  });
  assertEquals(r.autoAcceptCents, null);
  assertEquals(r.autoDeclineCents, null);
});

Deno.test("drops decline when it is not strictly below accept", () => {
  const r = resolveBestOfferThresholds({
    priceCents: 10000,
    acceptCents: 6000,
    declineCents: 7000, // decline >= accept → invalid, drop it
  });
  assertEquals(r.autoAcceptCents, 6000);
  assertEquals(r.autoDeclineCents, null);
});

Deno.test("decline-only must still sit below list price", () => {
  const r = resolveBestOfferThresholds({
    priceCents: 3000,
    acceptCents: null,
    declineCents: 3500, // above list, no accept set → drop
  });
  assertEquals(r.autoAcceptCents, null);
  assertEquals(r.autoDeclineCents, null);
});

Deno.test("ignores non-positive / non-finite values", () => {
  const r = resolveBestOfferThresholds({
    priceCents: 5000,
    acceptCents: Number.NaN,
    declineCents: -100,
  });
  assertEquals(r.autoAcceptCents, null);
  assertEquals(r.autoDeclineCents, null);
});

Deno.test("centsToMoneyString formats whole cents as money", () => {
  assertEquals(centsToMoneyString(2499), "24.99");
  assertEquals(centsToMoneyString(4000), "40.00");
  assertEquals(centsToMoneyString(5), "0.05");
});
