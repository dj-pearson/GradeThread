// US-2160 — the pure half of buying an eBay shipping label.
//
// Money lands in sales.shipping_cost from these functions, so the parsing is
// what the per-item P&L rests on. Everything here is network-free.

import { assert, assertEquals } from "@std/assert";
import {
  cheapestRate,
  findRate,
  moneyToCents,
  normalizeRates,
  quoteCoversOrder,
  type ShippingRate,
} from "../lib/ebay-logistics.ts";
import {
  logisticsCapability,
  parseParcel,
  toLogisticsAddress,
} from "../routes/flipdesk-logistics.ts";

// ── moneyToCents ────────────────────────────────────────────────────

Deno.test("US-2160: eBay decimal strings parse to exact cents", () => {
  assertEquals(moneyToCents({ value: "7.35" }), 735);
  assertEquals(moneyToCents({ value: "0.05" }), 5);
  assertEquals(moneyToCents({ value: "12" }), 1200);
  assertEquals(moneyToCents({ value: "12.5" }), 1250);
  assertEquals(moneyToCents({ value: "1234.99" }), 123499);
  assertEquals(moneyToCents({ value: "-3.50" }), -350);
});

Deno.test("US-2160: the prices that break `Number(v) * 100` still parse exactly", () => {
  // These are the reason the parse reads digits instead of multiplying. Each one
  // lands just under its cent value in floating point, so a `| 0` / Math.floor
  // implementation under-records by a cent — silently, and only on some prices.
  for (const s of ["1.15", "4.35", "2.03", "19.99", "0.29", "16.08"]) {
    assert(
      !Number.isInteger(Number(s) * 100),
      `sanity: ${s} * 100 should be inexact in float`,
    );
  }
  assertEquals(moneyToCents({ value: "1.15" }), 115);
  assertEquals(moneyToCents({ value: "4.35" }), 435);
  assertEquals(moneyToCents({ value: "2.03" }), 203);
  assertEquals(moneyToCents({ value: "19.99" }), 1999);
  assertEquals(moneyToCents({ value: "0.29" }), 29);
  assertEquals(moneyToCents({ value: "16.08" }), 1608);
});

Deno.test("US-2160: an unparseable price is null, never zero", () => {
  // Zero would look like free postage and quietly wipe a real shipping cost.
  assertEquals(moneyToCents(null), null);
  assertEquals(moneyToCents(undefined), null);
  assertEquals(moneyToCents({}), null);
  assertEquals(moneyToCents({ value: "" }), null);
  assertEquals(moneyToCents({ value: "  " }), null);
  assertEquals(moneyToCents({ value: {} }), null);
  assertEquals(moneyToCents({ value: "abc" }), null);
});

Deno.test("US-2160: an odd-precision value still yields a cost", () => {
  // Better a rounded number than a dropped one — a missing cost blocks the
  // whole point of the story (no more manual entry).
  assertEquals(moneyToCents({ value: "7.353" }), 735);
});

// ── normalizeRates ──────────────────────────────────────────────────

Deno.test("US-2160: rates normalize, preferring TOTAL over base cost", () => {
  const rates = normalizeRates([
    {
      rateId: "r1",
      shippingCarrierName: "USPS",
      shippingServiceName: "Ground Advantage",
      baseShippingCost: { value: "6.00", currency: "USD" },
      // Base excludes surcharges — pricing off it understates every label.
      totalShippingCost: { value: "7.35", currency: "USD" },
      minEstimatedDeliveryDate: { value: "2026-08-04" },
      maxEstimatedDeliveryDate: { value: "2026-08-06" },
      additionalOptions: [{ additionalOptionType: "SIGNATURE" }],
    },
  ]);
  assertEquals(rates.length, 1);
  assertEquals(rates[0], {
    rateId: "r1",
    carrier: "USPS",
    serviceName: "Ground Advantage",
    totalCostCents: 735,
    currency: "USD",
    minDeliveryDate: "2026-08-04",
    maxDeliveryDate: "2026-08-06",
    additionalOptions: ["SIGNATURE"],
  });
});

Deno.test("US-2160: normalizeRates survives every missing-field shape", () => {
  assertEquals(normalizeRates(null), []);
  assertEquals(normalizeRates(undefined), []);
  assertEquals(normalizeRates({}), []);
  // A rate with no id cannot be bought, so it must not be offered.
  assertEquals(normalizeRates([{ shippingCarrierName: "USPS" }]), []);
  assertEquals(normalizeRates([{ rateId: "" }]), []);
  const [r] = normalizeRates([{ rateId: "r1" }]);
  assertEquals(r.carrier, null);
  assertEquals(r.serviceName, null);
  assertEquals(r.totalCostCents, null);
  assertEquals(r.additionalOptions, []);
});

Deno.test("US-2160: carrier/service fall back to the code when there's no name", () => {
  const [r] = normalizeRates([
    { rateId: "r1", shippingCarrierCode: "USPS", shippingServiceCode: "PRIORITY" },
  ]);
  assertEquals(r.carrier, "USPS");
  assertEquals(r.serviceName, "PRIORITY");
});

Deno.test("US-2160: base cost is used when eBay omits the total", () => {
  const [r] = normalizeRates([
    { rateId: "r1", baseShippingCost: { value: "4.20", currency: "USD" } },
  ]);
  assertEquals(r.totalCostCents, 420);
  assertEquals(r.currency, "USD");
});

// ── cheapestRate / findRate ─────────────────────────────────────────

function rate(over: Partial<ShippingRate> = {}): ShippingRate {
  return {
    rateId: "r",
    carrier: "USPS",
    serviceName: "Ground",
    totalCostCents: 500,
    currency: "USD",
    minDeliveryDate: null,
    maxDeliveryDate: null,
    additionalOptions: [],
    ...over,
  };
}

Deno.test("US-2160: cheapestRate picks the lowest known price", () => {
  const best = cheapestRate([
    rate({ rateId: "a", totalCostCents: 900 }),
    rate({ rateId: "b", totalCostCents: 735 }),
    rate({ rateId: "c", totalCostCents: 1200 }),
  ]);
  assertEquals(best?.rateId, "b");
});

Deno.test("US-2160: a rate with an UNKNOWN price never wins", () => {
  // Treating null as free would auto-select the one rate whose cost we cannot
  // record — reintroducing the manual-entry problem this story removes.
  const best = cheapestRate([
    rate({ rateId: "unknown", totalCostCents: null }),
    rate({ rateId: "known", totalCostCents: 2000 }),
  ]);
  assertEquals(best?.rateId, "known");
  assertEquals(cheapestRate([rate({ totalCostCents: null })]), null);
  assertEquals(cheapestRate([]), null);
});

Deno.test("US-2160: a price tie breaks on the earlier delivery estimate", () => {
  const best = cheapestRate([
    rate({ rateId: "slow", totalCostCents: 700, maxDeliveryDate: "2026-08-09" }),
    rate({ rateId: "fast", totalCostCents: 700, maxDeliveryDate: "2026-08-05" }),
  ]);
  assertEquals(best?.rateId, "fast");
});

Deno.test("US-2160: findRate only returns an id that was actually quoted", () => {
  const rates = [rate({ rateId: "a" }), rate({ rateId: "b" })];
  assertEquals(findRate(rates, "b")?.rateId, "b");
  assertEquals(findRate(rates, "nope"), null);
  assertEquals(findRate([], "a"), null);
});

// ── logisticsCapability (AC5, mirrors US-1967) ──────────────────────

Deno.test("US-2160: an unlicensed deployment must NOT tell sellers to reconnect", () => {
  // The US-1967 bug, not repeated: a reconnect prompt for a state no seller can
  // fix. The copy has to name the real workaround instead.
  const cap = logisticsCapability(false, false);
  assertEquals(cap.label_purchase_available, false);
  assertEquals(cap.code, "feature_unavailable");
  assert(cap.detail && !/reconnect/i.test(cap.detail), cap.detail ?? "");
  assert(cap.detail && /eBay/.test(cap.detail));

  // Still unavailable-not-reconnectable even when a stale denial flag is set —
  // the deployment scope is the stronger signal.
  assertEquals(logisticsCapability(false, true).code, "feature_unavailable");
});

Deno.test("US-2160: a token that predates the grant IS reconnectable", () => {
  const cap = logisticsCapability(true, true);
  assertEquals(cap.label_purchase_available, false);
  assertEquals(cap.code, "reconnect_required");
  assert(cap.detail && /reconnect/i.test(cap.detail), cap.detail ?? "");
});

Deno.test("US-2160: scope present and no denial → available, no copy", () => {
  assertEquals(logisticsCapability(true, false), {
    label_purchase_available: true,
    code: null,
    detail: null,
  });
});

// ── parseParcel ─────────────────────────────────────────────────────

Deno.test("US-2160: a parcel needs a real weight", () => {
  for (const bad of [{}, { weight_value: 0 }, { weight_value: -1 }, { weight_value: "2" }]) {
    const r = parseParcel(bad);
    assert("error" in r, `${JSON.stringify(bad)} must be rejected`);
  }
  const ok = parseParcel({ weight_value: 2.5 });
  assert(!("error" in ok));
  assertEquals(ok.weightValue, 2.5);
  assertEquals(ok.weightUnit, "POUND"); // US default
});

Deno.test("US-2160: a PARTIAL dimension set is dropped, not passed through", () => {
  // eBay rejects one-of-three with an opaque error; dropping it just prices by
  // weight, which is a working quote instead of a confusing failure.
  const r = parseParcel({ weight_value: 1, length_value: 10 });
  assert(!("error" in r));
  assertEquals(r.lengthValue, null);
  assertEquals(r.widthValue, null);
  assertEquals(r.heightValue, null);

  const full = parseParcel({
    weight_value: 1,
    length_value: 10,
    width_value: 8,
    height_value: 4,
    dimension_unit: "CENTIMETER",
  });
  assert(!("error" in full));
  assertEquals(full.lengthValue, 10);
  assertEquals(full.widthValue, 8);
  assertEquals(full.heightValue, 4);
  assertEquals(full.dimensionUnit, "CENTIMETER");
});

Deno.test("US-2160: an unknown weight unit falls back to POUND", () => {
  const r = parseParcel({ weight_value: 1, weight_unit: "STONE" });
  assert(!("error" in r));
  assertEquals(r.weightUnit, "POUND");
  const oz = parseParcel({ weight_value: 6, weight_unit: "OUNCE" });
  assert(!("error" in oz));
  assertEquals(oz.weightUnit, "OUNCE");
});

// ── toLogisticsAddress ──────────────────────────────────────────────

const FULL_ADDRESS = {
  line1: "1 Main St",
  line2: "Apt 2",
  city: "Provo",
  state: "UT",
  postal_code: "84601",
  country: "US",
};

Deno.test("US-2160: a complete ship-from maps to eBay's address shape", () => {
  const a = toLogisticsAddress(FULL_ADDRESS, "Pearson Media", "8015551234");
  assertEquals(a, {
    fullName: "Pearson Media",
    addressLine1: "1 Main St",
    addressLine2: "Apt 2",
    city: "Provo",
    stateOrProvince: "UT",
    postalCode: "84601",
    countryCode: "US",
    phoneNumber: "8015551234",
  });
});

Deno.test("US-2160: an INCOMPLETE ship-from is null so the route can say so", () => {
  // eBay answers a partial address with an opaque error; returning null lets the
  // route send the seller to Settings instead.
  assertEquals(toLogisticsAddress(null, null, null), null);
  assertEquals(toLogisticsAddress("nope", null, null), null);
  for (const missing of ["line1", "city", "state", "postal_code"]) {
    const partial = { ...FULL_ADDRESS, [missing]: "" };
    assertEquals(
      toLogisticsAddress(partial, null, null),
      null,
      `missing ${missing} must be rejected`,
    );
  }
  // A whitespace-only field is missing too.
  assertEquals(
    toLogisticsAddress({ ...FULL_ADDRESS, city: "   " }, null, null),
    null,
  );
});

Deno.test("US-2160: country defaults to US and line2 is optional", () => {
  const a = toLogisticsAddress(
    { line1: "1 Main St", city: "Provo", state: "UT", postal_code: "84601" },
    null,
    null,
  );
  assertEquals(a?.countryCode, "US");
  assertEquals(a?.addressLine2, null);
  assertEquals(a?.fullName, null);
});

// ── quoteCoversOrder — the binding that keeps postage on the right sale ──

Deno.test("US-2160: a quote may only be bought against an order it covers", () => {
  // The purchase takes a quote id and a rate id straight from the client. Without
  // this check a seller can buy against a quote created for a DIFFERENT one of
  // their own sales, and the postage lands on whichever sale is in the URL — the
  // exact mis-attribution the story exists to remove.
  assert(quoteCoversOrder(["12-3456-7890"], "12-3456-7890"));
  assert(!quoteCoversOrder(["12-3456-7890"], "99-9999-9999"));
  assert(quoteCoversOrder(["a", "b", "c"], "b"));
});

Deno.test("US-2160: an unbindable quote fails CLOSED", () => {
  // A quote we cannot tie to an order must not be chargeable against one.
  assert(!quoteCoversOrder([], "12-3456-7890"));
  // And an empty order id can never match, even against a populated quote.
  assert(!quoteCoversOrder(["12-3456-7890"], ""));
  assert(!quoteCoversOrder([], ""));
});

Deno.test("US-2160: order matching is exact, not fuzzy", () => {
  // A prefix or a substring is a different order, and buying against it would
  // charge the wrong sale.
  assert(!quoteCoversOrder(["12-3456-7890"], "12-3456"));
  assert(!quoteCoversOrder(["12-3456"], "12-3456-7890"));
});
