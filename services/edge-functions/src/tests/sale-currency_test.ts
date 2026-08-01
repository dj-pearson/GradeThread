// US-2292 [P1]: a non-USD sale must not pay out as if it were dollars.
//
// `sales.currency` exists (US-2031) and the consignor payout path already
// refuses a non-USD sale. The hole was upstream: only the eBay connector wrote
// the column. Shopify never parsed the currency at all; Etsy and Depop DID
// parse it — EtsyReceipt.currency, DepopOrder.currency — and then dropped it on
// the way into the sale row.
//
// The chain that turns a dropped field into wrong money: no currency written →
// column null → isPayableCurrency reads a blank as payable (deliberately, to
// avoid stranding legacy rows) → a 200 GBP sale pays the consignor their share
// as if the number were dollars. Every link is individually reasonable, which
// is why it survived.
//
// These pin the normalizer every connector now writes through, and assert each
// connector actually calls it — the defect was an absent write, so there is no
// wrong value to catch.

import { assert, assertEquals } from "@std/assert";
import {
  classifySaleCurrency,
  CURRENCY_RECORDED_SINCE_DEFAULT,
  isPayableCurrency,
  normalizeSaleCurrency,
} from "../lib/consignor-payout-math.ts";

Deno.test("US-2292: currencies normalize to one shape", () => {
  // The payout guard compares strings, so "GBP", "gbp" and " gbp " must not be
  // three different currencies.
  assertEquals(normalizeSaleCurrency("GBP"), "gbp");
  assertEquals(normalizeSaleCurrency(" gbp "), "gbp");
  assertEquals(normalizeSaleCurrency("usd"), "usd");
});

Deno.test("US-2292: junk is not a currency", () => {
  // ISO 4217 is three letters. Anything else is a parsing accident, and a
  // parsing accident stored in this column would read as a real currency to
  // every downstream guard.
  for (const junk of [null, undefined, "", "US", "USDD", "1234", "$", 42, {}]) {
    assertEquals(normalizeSaleCurrency(junk), null, `${String(junk)} must not parse`);
  }
});

Deno.test("US-2292: a missing currency stays NULL, never defaults to USD", () => {
  // Defaulting would be the bug itself, written down as a fact. A null says "we
  // do not know", which is true and which a backfill can resolve; "usd" would
  // be indistinguishable from a real reading forever after.
  assertEquals(normalizeSaleCurrency(undefined), null);
  assertEquals(normalizeSaleCurrency(""), null);
});

Deno.test("US-2292: the recorded currency reaches the payout guard", () => {
  // The whole point of writing the column: a GBP sale must now be refused.
  assertEquals(isPayableCurrency(normalizeSaleCurrency("GBP")), false);
  assertEquals(isPayableCurrency(normalizeSaleCurrency("USD")), true);
  // And the pre-existing legacy behaviour is unchanged — a null is still
  // payable, because tightening that without a backfill would strand every
  // sale recorded before this shipped.
  assertEquals(isPayableCurrency(normalizeSaleCurrency(null)), true);
});

// ── The other half of the AC: a MISSING currency ───────────────────────────
//
// "Refuses to compute across mixed or missing currencies rather than assuming
// USD." isPayableCurrency answers only "is this string USD" and reads a blank
// as yes — right for the legacy rows, wrong for everything ingested since the
// connectors gained the field. classifySaleCurrency is the decision that can
// tell those two blanks apart.

const SINCE = CURRENCY_RECORDED_SINCE_DEFAULT;
const BEFORE = "2026-07-01T00:00:00Z";
const AFTER = "2026-09-01T00:00:00Z";

Deno.test("US-2292: a recorded currency decides on its own, whenever the sale happened", () => {
  // The date only ever disambiguates a BLANK. A currency we actually have is
  // never overridden by when the row was written.
  for (const at of [BEFORE, AFTER]) {
    assertEquals(classifySaleCurrency("usd", at, SINCE), { payable: true, reason: "usd" });
    assertEquals(classifySaleCurrency("gbp", at, SINCE), { payable: false, reason: "not_usd" });
  }
});

Deno.test("US-2292: a blank on a legacy sale stays payable", () => {
  // Before the connectors recorded anything, EVERY row is blank. Refusing them
  // would stop consignor payouts for the whole history of the table — a worse
  // failure than the one being fixed, and one no backfill can undo.
  assertEquals(classifySaleCurrency(null, BEFORE, SINCE), {
    payable: true,
    reason: "legacy_unrecorded",
  });
  assertEquals(classifySaleCurrency("", BEFORE, SINCE), {
    payable: true,
    reason: "legacy_unrecorded",
  });
});

Deno.test("US-2292: a blank on a sale ingested SINCE the fix is refused", () => {
  // The connector had a currency field and wrote nothing, so the marketplace
  // genuinely did not say. Paying that out is the original bug: an amount in an
  // unknown unit, transferred as dollars.
  assertEquals(classifySaleCurrency(null, AFTER, SINCE), {
    payable: false,
    reason: "unrecorded",
  });
  // Exactly at the boundary counts as after — the cutoff is the first instant
  // the connectors were capable of recording one.
  assertEquals(classifySaleCurrency(null, SINCE, SINCE).payable, false);
});

Deno.test("US-2292: a sale we cannot date fails CLOSED", () => {
  // Holding costs a manual review. Paying costs whatever the exchange rate is.
  for (const bad of [null, undefined, "", "not-a-date"]) {
    assertEquals(
      classifySaleCurrency(null, bad, SINCE).payable,
      false,
      `${String(bad)} must not be assumed legacy`,
    );
  }
});

Deno.test("US-2292: the payout guard uses the dated decision, not the string test", async () => {
  // A source assertion: the old guard's mistake was not a wrong value but a
  // question it never asked. It also pins the column it needs — reading
  // created_at out of the select is what would silently return this to
  // fail-closed-on-everything.
  const src = await Deno.readTextFile(
    new URL("../lib/consignor-payout.ts", import.meta.url),
  );
  assert(src.includes("classifySaleCurrency("), "the guard must use the dated decision");
  assert(!src.includes("isPayableCurrency("), "the blank-is-USD test must not survive here");
  assert(src.includes("created_at, "), "created_at must be selected or every blank fails closed");
});

Deno.test("US-2292: every connector records the sale currency", async () => {
  // A source assertion because the defect was an ABSENT write. Per the AC, one
  // check per connector — a new marketplace that forgets this repeats the bug
  // silently, and its first symptom is a consignor paid the wrong amount.
  const connectors = [
    "shopify-orders.ts",
    "etsy-orders.ts",
    "depop-orders.ts",
  ];
  for (const file of connectors) {
    const src = await Deno.readTextFile(new URL(`../lib/${file}`, import.meta.url));
    assert(
      src.includes("currency: normalizeSaleCurrency("),
      `${file} must record the sale currency`,
    );
  }
  // Shopify additionally had to start PARSING it — the payload always carried
  // one, the client just never read it.
  const client = await Deno.readTextFile(
    new URL("../lib/shopify-client.ts", import.meta.url),
  );
  assert(client.includes("currency: normalizeSaleCurrency("));
  assert(client.includes("currency?: string;"), "the payload field must be declared");
});
