// US-3015: the EasyPost provider's pure rules and its two money-safety
// properties, driven rather than described.
//
// Run alone:
//   deno test --allow-net --allow-env --allow-read src/tests/easypost_test.ts
//
// WHY THE HTTP CASES STUB globalThis.fetch RATHER THAN SCANNING THE SOURCE.
// The two properties that cost real money if they break -- a buy is never
// retried, and a buy never runs on the partner key -- are both about what went
// out on the wire. A grep for `retry: false` proves the literal is present, not
// that the request honoured it, and this file's own header would then be the
// only thing standing between a refactor and a double-billed seller.

import { assert, assertEquals } from "@std/assert";
import {
  buyEasyPostShipment,
  createEasyPostQuote,
  getEasyPostShipment,
  isEasyPostConfigured,
  isPaymentMethodError,
  normalizeEasyPostRates,
  normalizeEasyPostShipment,
  productionKeyOf,
  quoteCoversSale,
  rateToCents,
  shipmentWasPurchased,
  toEasyPostAddress,
  toEasyPostParcel,
  toOunces,
} from "../lib/easypost.ts";
import type { LogisticsAddress } from "../lib/logistics-types.ts";

// ── Money ───────────────────────────────────────────────────────────

Deno.test("rateToCents reads the digits rather than multiplying", () => {
  // Every one of these is a price Number(x) * 100 gets wrong by a fraction, and
  // a floor on that result loses a whole cent. 1.15 is the canonical case:
  // Number("1.15") * 100 === 114.99999999999999.
  assertEquals(rateToCents("1.15"), 115);
  assertEquals(rateToCents("4.35"), 435);
  assertEquals(rateToCents("2.03"), 203);
  assertEquals(rateToCents("19.99"), 1999);
  assertEquals(rateToCents("7.00"), 700);
  assertEquals(rateToCents("12"), 1200);
  assertEquals(rateToCents("0.5"), 50);
  assertEquals(rateToCents("-3.25"), -325);
});

Deno.test("rateToCents answers null for a value it cannot price", () => {
  // Null, not zero. A zero would win cheapestRate() and auto-select the one
  // rate whose cost we cannot record -- which is the manual-entry problem the
  // label work exists to remove.
  assertEquals(rateToCents(null), null);
  assertEquals(rateToCents(undefined), null);
  assertEquals(rateToCents(""), null);
  assertEquals(rateToCents({}), null);
});

// ── Units ───────────────────────────────────────────────────────────

Deno.test("toOunces converts every unit the route can hand it", () => {
  assertEquals(toOunces(12, "OUNCE"), 12);
  assertEquals(toOunces(2, "POUND"), 32);
  assert(Math.abs(toOunces(1000, "GRAM") - 35.27396) < 0.001);
  assert(Math.abs(toOunces(1, "KILOGRAM") - 35.27396) < 0.001);
});

Deno.test("a POUND weight is not sent to EasyPost as pounds", () => {
  // The failure this pins: EasyPost reads `weight` as ounces unconditionally,
  // so a 2 lb parcel sent as 2 prices a label at one sixteenth of the real
  // weight -- which buys postage the carrier then bills a reweigh on, weeks
  // later, against the seller's own card.
  const parcel = toEasyPostParcel({ weightValue: 2, weightUnit: "POUND" });
  assertEquals(parcel.weight, 32);
});

Deno.test("dimensions are all-or-nothing and convert from centimetres", () => {
  const partial = toEasyPostParcel({
    weightValue: 8,
    weightUnit: "OUNCE",
    lengthValue: 10,
    widthValue: 8,
    heightValue: null,
  });
  assertEquals(partial.length, undefined);
  assertEquals(partial.width, undefined);
  assertEquals(partial.height, undefined);

  const metric = toEasyPostParcel({
    weightValue: 8,
    weightUnit: "OUNCE",
    lengthValue: 25.4,
    widthValue: 25.4,
    heightValue: 5.08,
    dimensionUnit: "CENTIMETER",
  });
  assertEquals(metric.length, 10);
  assertEquals(metric.width, 10);
  assertEquals(metric.height, 2);
});

Deno.test("toEasyPostAddress maps every field EasyPost prints", () => {
  const addr: LogisticsAddress = {
    fullName: "Dj Pearson",
    addressLine1: "100 Main St",
    addressLine2: "Unit 4",
    city: "Austin",
    stateOrProvince: "TX",
    postalCode: "78701",
    countryCode: "US",
    phoneNumber: "5125550123",
  };
  assertEquals(toEasyPostAddress(addr), {
    name: "Dj Pearson",
    street1: "100 Main St",
    street2: "Unit 4",
    city: "Austin",
    state: "TX",
    zip: "78701",
    country: "US",
    phone: "5125550123",
  });
  // An empty country defaults rather than reaching EasyPost blank, which is a
  // 422 with an opaque message.
  assertEquals(toEasyPostAddress({ ...addr, countryCode: "" }).country, "US");
});

// ── Rate normalization ──────────────────────────────────────────────

const RAW_RATES = [
  {
    id: "rate_usps",
    carrier: "USPS",
    service: "GroundAdvantage",
    rate: "5.71",
    currency: "USD",
    delivery_date: "2026-09-25T00:00:00Z",
  },
  {
    id: "rate_ups",
    carrier: "UPS",
    service: "Ground",
    rate: "9.14",
    currency: "USD",
    delivery_date: null,
    delivery_date_guaranteed: true,
  },
  // No id: unbuyable, so showing it would be a price we then refuse.
  { carrier: "FedEx", service: "Ground", rate: "8.00" },
];

Deno.test("normalizeEasyPostRates drops what cannot be bought", () => {
  const rates = normalizeEasyPostRates(RAW_RATES);
  assertEquals(rates.length, 2);
  assertEquals(rates.map((r) => r.rateId), ["rate_usps", "rate_ups"]);
});

Deno.test("AC13: a normalized rate is the carrier rate, to the cent", () => {
  // The pass-through property, asserted rather than promised in a comment. If
  // anyone ever adds a fee, a percentage or a rounding step, this is what goes
  // red -- and it is the assertion to read before believing a markup was an
  // accident.
  const rates = normalizeEasyPostRates(RAW_RATES);
  assertEquals(rates[0]!.totalCostCents, 571);
  assertEquals(rates[1]!.totalCostCents, 914);
});

Deno.test("an estimate with no date reports null on both bounds", () => {
  const rates = normalizeEasyPostRates(RAW_RATES);
  assertEquals(rates[0]!.minDeliveryDate, "2026-09-25T00:00:00Z");
  assertEquals(rates[0]!.maxDeliveryDate, "2026-09-25T00:00:00Z");
  assertEquals(rates[1]!.minDeliveryDate, null);
  assertEquals(rates[1]!.maxDeliveryDate, null);
  assertEquals(rates[1]!.additionalOptions, ["GUARANTEED_DELIVERY"]);
});

Deno.test("normalizeEasyPostRates survives a shape it never expected", () => {
  assertEquals(normalizeEasyPostRates(null), []);
  assertEquals(normalizeEasyPostRates("rates"), []);
  assertEquals(normalizeEasyPostRates([null, undefined, 3]), []);
});

// ── The unclear-buy recovery (AC10) ─────────────────────────────────

Deno.test("shipmentWasPurchased keys off the label, not the status", () => {
  const bought = normalizeEasyPostShipment({
    id: "shp_1",
    tracking_code: "9400111",
    selected_rate: { carrier: "USPS", rate: "5.71", currency: "USD" },
    postage_label: { label_url: "https://easypost-files.test/label.pdf" },
  });
  assert(shipmentWasPurchased(bought));
  assertEquals(bought.totalCostCents, 571);
  assertEquals(bought.trackingNumber, "9400111");
  assertEquals(bought.carrier, "USPS");

  // A shipment that exists and has rates but was never bought. This is what a
  // timed-out buy leaves behind, and reading it is the ONLY correct way to
  // settle one -- re-posting bills a second label.
  const unbought = normalizeEasyPostShipment({ id: "shp_2", rates: RAW_RATES });
  assert(!shipmentWasPurchased(unbought));
  assertEquals(unbought.totalCostCents, null);
  assertEquals(unbought.shipmentId, "shp_2");
});

Deno.test("quoteCoversSale binds a shipment to the sale it was quoted for", () => {
  const saleId = "11111111-2222-3333-4444-555555555555";
  assert(quoteCoversSale(saleId, saleId));

  // The attack this stops: both ids on the buy come straight off the request,
  // and EasyPost will happily sell a label on a shipment the seller owns. So
  // without this, a seller could buy against a shipment quoted for a DIFFERENT
  // one of their own sales and the postage would land on whichever sale is in
  // the URL -- the exact mis-attribution the label work exists to remove.
  assert(!quoteCoversSale("66666666-7777-8888-9999-000000000000", saleId));

  // FAILS CLOSED on an empty reference, the way quoteCoversOrder does on an
  // empty order list. That also covers a shipment created before the reference
  // was stamped: re-quoting costs a second, buying the wrong one does not.
  assert(!quoteCoversSale(null, saleId));
  assert(!quoteCoversSale("", saleId));
  assert(!quoteCoversSale(saleId, ""));
});

// ── Referral customers (AC2) ────────────────────────────────────────

Deno.test("productionKeyOf never hands back a test key", () => {
  // A test key buys a label that never ships and never bills, and nothing in
  // the response distinguishes the two except this field. Returning null for a
  // test-only customer is recoverable (onboarding); returning the test key is
  // a seller whose parcels sit in a bin.
  assertEquals(
    productionKeyOf({ api_keys: [{ key: "test_abc", mode: "test" }] }),
    null,
  );
  assertEquals(
    productionKeyOf({
      api_keys: [
        { key: "test_abc", mode: "test" },
        { key: "prod_xyz", mode: "production" },
      ],
    }),
    "prod_xyz",
  );
  assertEquals(
    productionKeyOf({
      api_keys: [{ key: "prod_old", mode: "production", active: false }],
    }),
    null,
  );
  assertEquals(productionKeyOf({}), null);
  assertEquals(productionKeyOf(null), null);
});

Deno.test("isPaymentMethodError separates onboarding from an outage", () => {
  const noCard = Object.assign(new Error("no payment method on file"), {
    status: 422,
  });
  assert(isPaymentMethodError(noCard));

  const coded = Object.assign(new Error("something opaque"), {
    status: 422,
    easypostCode: "PAYMENT.NOT_FOUND",
  });
  assert(isPaymentMethodError(coded));

  // A 500 is EasyPost being down. Telling a seller to add a card they already
  // have is worse than telling them to try again.
  const outage = Object.assign(new Error("internal error"), { status: 500 });
  assert(!isPaymentMethodError(outage));
  assert(!isPaymentMethodError(new Error("plain")));
  assert(!isPaymentMethodError(null));
});

// ── Configuration (AC12) ────────────────────────────────────────────

Deno.test("isEasyPostConfigured reads the partner key and nothing else", () => {
  const before = Deno.env.get("EASYPOST_API_KEY");
  try {
    Deno.env.delete("EASYPOST_API_KEY");
    assert(!isEasyPostConfigured());
    // A whitespace-only value is not a key. It is what an empty Coolify field
    // produces, and reading it as configured turns a clean "unavailable" into
    // a 401 in the middle of a purchase.
    Deno.env.set("EASYPOST_API_KEY", "   ");
    assert(!isEasyPostConfigured());
    Deno.env.set("EASYPOST_API_KEY", "ep_partner_key");
    assert(isEasyPostConfigured());
  } finally {
    if (before == null) Deno.env.delete("EASYPOST_API_KEY");
    else Deno.env.set("EASYPOST_API_KEY", before);
  }
});

// ── What actually went out on the wire ──────────────────────────────

interface Sent {
  url: string;
  method: string;
  auth: string;
  body: unknown;
}

function stubFetch(
  responder: (call: number) => { status: number; body: unknown },
): { sent: Sent[]; restore: () => void } {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({
      url: String(input),
      method: init?.method ?? "GET",
      auth: headers.get("Authorization") ?? "",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const { status, body } = responder(sent.length);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = real; } };
}

Deno.test("AC10: a failed buy is sent EXACTLY once", async () => {
  const { sent, restore } = stubFetch(() => ({
    status: 500,
    body: { error: { message: "upstream timeout" } },
  }));
  try {
    let threw = false;
    try {
      await buyEasyPostShipment("ep_seller_key", "shp_1", "rate_usps");
    } catch {
      threw = true;
    }
    assert(threw, "a 500 on a buy must surface, never be swallowed");
    assertEquals(
      sent.length,
      1,
      `a retried buy bills a second label; ${sent.length} requests went out`,
    );
    assertEquals(sent[0]!.method, "POST");
    assert(sent[0]!.url.endsWith("/shipments/shp_1/buy"));
    assertEquals(sent[0]!.body, { rate: { id: "rate_usps" } });
  } finally {
    restore();
  }
});

Deno.test("a read DOES retry, because re-reading costs nothing", async () => {
  const { sent, restore } = stubFetch((call) =>
    call === 1
      ? { status: 503, body: { error: { message: "try again" } } }
      : {
        status: 200,
        body: {
          id: "shp_1",
          postage_label: { label_url: "https://easypost-files.test/l.pdf" },
          selected_rate: { carrier: "USPS", rate: "5.71", currency: "USD" },
        },
      }
  );
  try {
    const shipment = await getEasyPostShipment("ep_seller_key", "shp_1");
    assert(shipmentWasPurchased(shipment));
    assertEquals(sent.length, 2);
  } finally {
    restore();
  }
});

Deno.test("AC2: a buy runs on the SELLER's key, never the partner's", async () => {
  // The whole billing model is this header. On the partner key EasyPost bills
  // US for the postage, which is the float this design exists to not have --
  // and it would fail silently, as a correct label and a wrong invoice.
  const before = Deno.env.get("EASYPOST_API_KEY");
  Deno.env.set("EASYPOST_API_KEY", "ep_PARTNER");
  const { sent, restore } = stubFetch(() => ({
    status: 200,
    body: {
      id: "shp_1",
      tracking_code: "9400111",
      selected_rate: { carrier: "USPS", rate: "5.71", currency: "USD" },
      postage_label: { label_url: "https://easypost-files.test/l.pdf" },
    },
  }));
  try {
    await buyEasyPostShipment("ep_SELLER", "shp_1", "rate_usps");
    const expected = `Basic ${btoa("ep_SELLER:")}`;
    assertEquals(sent[0]!.auth, expected);
    assert(
      !sent[0]!.auth.includes(btoa("ep_PARTNER:")),
      "the partner key must never authorize a postage purchase",
    );
  } finally {
    restore();
    if (before == null) Deno.env.delete("EASYPOST_API_KEY");
    else Deno.env.set("EASYPOST_API_KEY", before);
  }
});

Deno.test("a quote sends both addresses and the converted parcel", async () => {
  const { sent, restore } = stubFetch(() => ({
    status: 200,
    body: { id: "shp_1", rates: RAW_RATES },
  }));
  try {
    const addr: LogisticsAddress = {
      addressLine1: "100 Main St",
      city: "Austin",
      stateOrProvince: "TX",
      postalCode: "78701",
      countryCode: "US",
    };
    const quote = await createEasyPostQuote("ep_seller_key", {
      shipFrom: addr,
      shipTo: { ...addr, city: "Denver", stateOrProvince: "CO", postalCode: "80202" },
      parcel: { weightValue: 1, weightUnit: "POUND" },
      reference: "SKU-J0042",
    });
    assertEquals(quote.shippingQuoteId, "shp_1");
    assertEquals(quote.rates.length, 2);
    // EasyPost rates go stale rather than expiring at a stated time. Null is
    // the honest answer; a made-up timestamp would render as a countdown.
    assertEquals(quote.expiresAt, null);
    const body = sent[0]!.body as { shipment: Record<string, unknown> };
    assertEquals(
      (body.shipment.parcel as Record<string, number>).weight,
      16,
      "the parcel must reach EasyPost in ounces",
    );
    assertEquals(
      (body.shipment.to_address as Record<string, string>).zip,
      "80202",
    );
    assertEquals(body.shipment.reference, "SKU-J0042");
  } finally {
    restore();
  }
});

// ── The money model, as a property of the source ────────────────────

Deno.test("AC2: nothing in this module holds a seller's postage money", async () => {
  // A scan, deliberately, and it is the one place a scan is the right tool:
  // the claim is about what does NOT exist. The day someone adds a wallet,
  // a balance or a top-up here, the billing model has changed and it should
  // take a decision rather than a commit.
  const src = await Deno.readTextFile(
    new URL("../lib/easypost.ts", import.meta.url),
  );
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
  for (const banned of ["balance", "wallet", "top_up", "topUp", "stripe"]) {
    assert(
      !new RegExp(banned, "i").test(code),
      `easypost.ts names "${banned}" in code: EasyPost-Managed Billing means the seller's card is charged by EasyPost and we hold nothing`,
    );
  }
});

// ── The Pro gate covers both providers (AC6) ────────────────────────

Deno.test("AC6: one gate flag serves both providers, and no second one exists", async () => {
  // The criterion is that the EXISTING shippingLabels gate covers EasyPost
  // unchanged -- no second flag, no plan-matrix migration. That is a claim
  // about what is absent, so the check is a scan of the route that spends the
  // money, and it is the right tool here for the same reason the wallet scan
  // is: a behavioural test cannot see a flag nobody added yet.
  const src = await Deno.readTextFile(
    new URL("../routes/flipdesk-logistics.ts", import.meta.url),
  );
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");

  const gated = [...code.matchAll(/featureAllowedForUser\([^,]+,\s*"([^"]+)"/g)]
    .map((m) => m[1]);
  assert(gated.length > 0, "the label routes must gate on a plan flag at all");
  for (const flag of gated) {
    assertEquals(
      flag,
      "shippingLabels",
      `the label routes gate on "${flag}"; AC6 says one flag covers both providers`,
    );
  }

  // And nothing named for EasyPost may appear as a gate flag anywhere in the
  // file -- an `easypostLabels` flag would pass the loop above by living in a
  // different call.
  assert(
    !/["']easypost[A-Z]\w*["']/.test(code),
    "no EasyPost-specific plan flag: AC6 keeps this on the one shippingLabels gate",
  );
});

Deno.test("AC6: reprint and void stay open on every plan, both providers", async () => {
  // US-3011's rule, unchanged by the second provider: the gate covers the two
  // routes that SPEND money. A seller who downgrades after buying a label must
  // still print it and still claim the refund -- locking a void strands their
  // money behind an upsell, and that is as true of EasyPost's refund as of
  // eBay's cancel.
  const src = await Deno.readTextFile(
    new URL("../routes/flipdesk-logistics.ts", import.meta.url),
  );
  // preflight(ownerId, saleId, false) is the ungated call. Exactly two routes
  // may make it: the reprint and the void.
  const ungated = [...src.matchAll(/preflight\([^)]*,\s*false\)/g)];
  assertEquals(
    ungated.length,
    2,
    `expected exactly 2 ungated preflight calls (reprint, void), found ${ungated.length}`,
  );
});
