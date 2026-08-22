// US-2160 — the pure half of buying an eBay shipping label.
//
// Money lands in sales.shipping_cost from these functions, so the parsing is
// what the per-item P&L rests on. Everything here is network-free.

import "./_env.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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

// ── US-2417 AC6: the label path still gets a real address ───────────
//
// `users.ship_from_address` is now AES-GCM ciphertext, and the label quote is
// the one edge consumer that reads it. If the decrypt is ever dropped from that
// handler, `toLogisticsAddress` receives the envelope STRING instead of the
// object — so the two cases below pin what happens next, because the difference
// between them is the difference between a loud failure and a wrong package.

Deno.test("US-2417: an undecrypted envelope yields NO address, never a partial one", () => {
  // A string is not an object, so this returns null and the route answers its
  // 409 "add your ship-from address in Settings". Wrong message, but the label
  // is not bought — which is the correct direction to fail in.
  assertEquals(
    toLogisticsAddress("v2:test-k1:aBcD:eFgH", "Pearson Media", "8015551234"),
    null,
  );
});

Deno.test("US-2417: the label handler decrypts before it builds the address", () => {
  // A source guard, because the failure above is silent in the happy path: a
  // seller with no address and a seller whose address could not be decrypted
  // both see the same 409, so nothing in a normal test run would notice the
  // decrypt going missing.
  const source = Deno.readTextFileSync(
    new URL("../routes/flipdesk-logistics.ts", import.meta.url),
  );
  assert(
    source.includes("decryptShipFrom(") && source.includes("decryptBusinessPhone("),
    "flipdesk-logistics.ts must decrypt users.ship_from_address / business_phone " +
      "(US-2417) before calling toLogisticsAddress",
  );
  // And it must not hand the raw column straight in — that is the exact edit
  // this guard exists to catch.
  assert(
    !/toLogisticsAddress\(\s*u\?\.ship_from_address/.test(source),
    "flipdesk-logistics.ts is passing the raw (encrypted) column to toLogisticsAddress",
  );
});

// ── US-2790: the predicted weight fallback ─────────────────────────────────
//
// Before this, parseParcel refused without a weight in the body, so a seller
// retyped one on every sale — for a garment the system had already measured.

Deno.test("US-2790: a predicted weight is used when the body has none", () => {
  const r = parseParcel({}, 12.5);
  assertEquals("error" in r, false);
  const p = r as { weightValue: number; weightUnit: string };
  assertEquals(p.weightValue, 12.5);
  // Ounces by construction — the estimator's unit.
  assertEquals(p.weightUnit, "OUNCE");
});

Deno.test("US-2790: the body WINS over the prediction", () => {
  // A caller that names a weight is stating a fact about this parcel, very
  // possibly off a scale. A prediction must never overwrite it.
  const r = parseParcel({ weight_value: 3, weight_unit: "POUND" }, 99);
  const p = r as { weightValue: number; weightUnit: string };
  assertEquals(p.weightValue, 3);
  assertEquals(p.weightUnit, "POUND");
});

Deno.test("US-2790: a predicted weight ignores a stale unit in the body", () => {
  // The trap: a body carrying weight_unit POUND but no weight_value would have
  // turned 12 predicted OUNCES into 12 pounds — a 16x over-declaration, and
  // eBay prices it.
  const r = parseParcel({ weight_unit: "POUND" }, 12);
  const p = r as { weightValue: number; weightUnit: string };
  assertEquals(p.weightValue, 12);
  assertEquals(p.weightUnit, "OUNCE");
});

Deno.test("US-2790: no body weight and no prediction still refuses", () => {
  // The pre-existing behaviour, kept. A failed prediction must not invent one.
  for (const fallback of [null, undefined, 0, -1, Number.NaN]) {
    const r = parseParcel({}, fallback as number | null);
    assertEquals("error" in r, true, `fallback ${String(fallback)}`);
  }
});

Deno.test("US-2790: the prediction does not disturb dimensions", () => {
  // Dimensions are all-or-nothing for eBay and come only from the body. A
  // predicted WEIGHT must not cause a partial dimension set to slip through.
  const r = parseParcel({ length_value: 10 }, 8);
  const p = r as { lengthValue: number | null; widthValue: number | null };
  assertEquals(p.lengthValue, null);
  assertEquals(p.widthValue, null);
});

// ── US-2790 / US-268: the predicted-parcel read is owner-scoped ────────────
//
// A SOURCE assertion, deliberately. predictedParcel is not exported and its
// read goes through the service-role client, which BYPASSES RLS — so the
// property worth pinning is a WIRING one: does the query carry the owner
// filter. A sabotage confirmed the behavioural cases above cannot see this
// (they exercise the pure parser), and the real check lives in the Tenant
// Isolation lane, which needs the full stack.
//
// preflight already proves ownership of the SALE. That is not enough on its
// own: inventory_item_id comes off the joined row, and an id taken from a
// request-derived row is still an id from a request.
Deno.test("US-268: predictedParcel filters inventory_items by user_id", async () => {
  const src = await Deno.readTextFile(
    new URL("../routes/flipdesk-logistics.ts", import.meta.url),
  );
  const start = src.indexOf("async function predictedParcel(");
  assertEquals(start > -1, true, "predictedParcel was renamed or removed");
  const body = src.slice(start, start + 1200);

  assertStringIncludes(body, 'from("inventory_items")');
  assertStringIncludes(body, '.eq("user_id", ownerId)');
  // The item id must be constrained too, or the filter selects an arbitrary row.
  assertStringIncludes(body, '.eq("id", inventoryItemId)');
});

Deno.test("US-2790: a failed prediction degrades to asking, not to throwing", () => {
  // The route must not fail a rate call because a prediction could not be made.
  // Guarded as source because the catch is an ABSENCE of a throw — there is no
  // wrong value to assert on.
  const src = Deno.readTextFileSync(
    new URL("../routes/flipdesk-logistics.ts", import.meta.url),
  );
  const start = src.indexOf("async function predictedParcel(");
  const body = src.slice(start, src.indexOf("\n}", start));
  assertStringIncludes(body, "catch");
  assertStringIncludes(body, "return null");
});

// ── US-2790: recording what was predicted ─────────────────────────────────
//
// sales.predicted_parcel (migration 00649) is how a SEEDED estimator becomes a
// measured one: the payout sync already writes what the carrier charged, so the
// only missing half is what we said beforehand.
//
// Source assertions, for the same reason the tenant-scope case above is one —
// recordPrediction is not exported, it writes through the service-role client,
// and the properties worth pinning are WIRING: who it is scoped to, when it
// fires, and what it refuses to overwrite.

Deno.test("US-2790: the prediction is recorded only when it was USED", () => {
  // A body that named its own weight overrode the estimate. Storing our guess
  // beside a parcel it never described would measure the estimator against
  // shipments it did not predict — which biases the correction it exists to
  // inform, rather than merely adding noise.
  const src = Deno.readTextFileSync(
    new URL("../routes/flipdesk-logistics.ts", import.meta.url),
  );
  assertStringIncludes(src, "const usedPrediction =");
  assertStringIncludes(src, "if (usedPrediction) await recordPrediction(");
});

Deno.test("US-2790: the write is owner-scoped and first-write-wins", () => {
  const src = Deno.readTextFileSync(
    new URL("../routes/flipdesk-logistics.ts", import.meta.url),
  );
  const start = src.indexOf("async function recordPrediction");
  assertEquals(start > -1, true, "recordPrediction was renamed or removed");
  const body = src.slice(start, start + 1400);

  // US-268: the service-role client bypasses RLS, so the update carries the
  // owner as well as the row id.
  assertStringIncludes(body, '.eq("user_id", ownerId)');
  assertStringIncludes(body, '.eq("id", saleId)');

  // The value worth keeping is what we said when the seller was DECIDING. A
  // re-run of the rates call after they adjust something must not overwrite
  // the original claim, which is what makes this comparable later.
  assertStringIncludes(body, '.is("predicted_parcel", null)');
});

Deno.test("US-2790: the estimator table version is stored with the prediction", () => {
  // Without it, rows predicted under different multipliers are averaged
  // together and the error looks smaller than it is on both.
  const src = Deno.readTextFileSync(
    new URL("../routes/flipdesk-logistics.ts", import.meta.url),
  );
  assertStringIncludes(src, "tableVersion: PARCEL_TABLE_VERSION");
});

Deno.test("US-2790: a failed telemetry write never fails the seller's call", () => {
  // This measures OUR accuracy. A seller pricing a label must not see an error
  // because we could not write our own instrumentation.
  const src = Deno.readTextFileSync(
    new URL("../routes/flipdesk-logistics.ts", import.meta.url),
  );
  const start = src.indexOf("async function recordPrediction");
  const body = src.slice(start, src.indexOf("\n}", src.indexOf("catch", start)));
  assertStringIncludes(body, "catch");
  // No rethrow: the catch logs and returns.
  assertEquals(/catch[\s\S]*throw/.test(body), false, "recordPrediction must not rethrow");
});
