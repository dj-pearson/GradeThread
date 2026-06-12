// US-562: best-offer threshold derivation + eBay-constraint clamping. Pure math
// (no env / I/O), so a direct import is fine.
import { assert, assertEquals } from "@std/assert";
import {
  centsToMoneyString,
  resolveBestOfferThresholds,
} from "../lib/best-offer.ts";

Deno.test("derives accept=p75, decline=p25 from comp stats when both below list", () => {
  const r = resolveBestOfferThresholds({
    priceCents: 5000, // $50 list
    p25Cents: 3000, // $30 floor
    p75Cents: 4500, // $45
    acceptOverrideCents: null,
    declineOverrideCents: null,
  });
  assertEquals(r.autoAcceptCents, 4500);
  assertEquals(r.autoDeclineCents, 3000);
});

Deno.test("clamps accept to one cent under list when p75 exceeds the price", () => {
  const r = resolveBestOfferThresholds({
    priceCents: 4000, // $40 list
    p25Cents: 2500,
    p75Cents: 6000, // p75 above list → must be nudged below list
    acceptOverrideCents: null,
    declineOverrideCents: null,
  });
  assertEquals(r.autoAcceptCents, 3999);
  assertEquals(r.autoDeclineCents, 2500);
  assert(r.autoAcceptCents! < 4000);
  assert(r.autoDeclineCents! < r.autoAcceptCents!);
});

Deno.test("per-item overrides win over comp-derived defaults", () => {
  const r = resolveBestOfferThresholds({
    priceCents: 10000,
    p25Cents: 4000,
    p75Cents: 8000,
    acceptOverrideCents: 9000,
    declineOverrideCents: 5000,
  });
  assertEquals(r.autoAcceptCents, 9000);
  assertEquals(r.autoDeclineCents, 5000);
});

Deno.test("drops decline when it is not strictly below accept (inverted override)", () => {
  const r = resolveBestOfferThresholds({
    priceCents: 10000,
    p25Cents: null,
    p75Cents: null,
    acceptOverrideCents: 6000,
    declineOverrideCents: 7000, // decline >= accept → invalid, drop it
  });
  assertEquals(r.autoAcceptCents, 6000);
  assertEquals(r.autoDeclineCents, null);
});

Deno.test("no comp stats and no overrides → both null", () => {
  const r = resolveBestOfferThresholds({
    priceCents: 5000,
    p25Cents: null,
    p75Cents: null,
    acceptOverrideCents: null,
    declineOverrideCents: null,
  });
  assertEquals(r.autoAcceptCents, null);
  assertEquals(r.autoDeclineCents, null);
});

Deno.test("decline-only must still sit below list price", () => {
  const r = resolveBestOfferThresholds({
    priceCents: 3000,
    p25Cents: null,
    p75Cents: null,
    acceptOverrideCents: null,
    declineOverrideCents: 3500, // above list, no accept set → drop
  });
  assertEquals(r.autoAcceptCents, null);
  assertEquals(r.autoDeclineCents, null);
});

Deno.test("ignores non-positive / non-finite candidates", () => {
  const r = resolveBestOfferThresholds({
    priceCents: 5000,
    p25Cents: 0,
    p75Cents: -100,
    acceptOverrideCents: Number.NaN,
    declineOverrideCents: null,
  });
  assertEquals(r.autoAcceptCents, null);
  assertEquals(r.autoDeclineCents, null);
});

Deno.test("centsToMoneyString formats whole cents as money", () => {
  assertEquals(centsToMoneyString(2499), "24.99");
  assertEquals(centsToMoneyString(4000), "40.00");
  assertEquals(centsToMoneyString(5), "0.05");
});
