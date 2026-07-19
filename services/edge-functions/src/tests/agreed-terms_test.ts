// US-2117: the agreed-terms snapshot.
//
// This is EVIDENTIARY data — its only job is to be trusted later, when someone
// asks what a user was actually shown. So the interesting cases are all the ones
// where we must REFUSE to write rather than write something plausible: a record
// with a guessed amount proves nothing while looking authoritative, which is
// worse than a visible gap.
//
//   deno test --allow-env src/tests/agreed-terms_test.ts

import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { extractAgreedTerms, normalizeInterval, trialDaysBetween } = await import(
  "../lib/agreed-terms.ts"
);

function sub(over: Record<string, unknown> = {}) {
  return {
    id: "sub_123",
    currency: "usd",
    items: {
      data: [{
        price: {
          id: "price_abc",
          currency: "usd",
          unit_amount: 4900,
          recurring: { interval: "month" },
        },
      }],
    },
    ...over,
  };
}

Deno.test("captures the terms as Stripe actually applied them", () => {
  const t = extractAgreedTerms(sub(), "pro");
  assertEquals(t?.plan, "pro");
  assertEquals(t?.billingInterval, "monthly");
  assertEquals(t?.amountCents, 4900);
  assertEquals(t?.currency, "usd");
  assertEquals(t?.stripePriceId, "price_abc");
  assertEquals(t?.stripeSubscriptionId, "sub_123");
});

Deno.test("maps every interval spelling Stripe uses", () => {
  for (const raw of ["month", "monthly", "MONTH", " Month "]) {
    assertEquals(normalizeInterval(raw), "monthly", raw);
  }
  for (const raw of ["year", "yearly", "annual", "YEAR"]) {
    assertEquals(normalizeInterval(raw), "yearly", raw);
  }
});

// Stripe also emits day/week. We don't sell those, so seeing one means something
// is wrong upstream — guessing would put a false term on a compliance record.
Deno.test("an interval we do not sell yields NO record, not a guess", () => {
  for (const raw of ["day", "week", "", null, undefined, "fortnight"]) {
    assertEquals(normalizeInterval(raw as string), null, String(raw));
  }
  const t = extractAgreedTerms(
    sub({
      items: {
        data: [{
          price: { id: "p", currency: "usd", unit_amount: 100, recurring: { interval: "week" } },
        }],
      },
    }),
    "pro",
  );
  assertEquals(t, null, "a weekly interval must produce no agreement at all");
});

// THE CASE THAT MATTERS MOST: a missing amount must not become 0. Zero is a
// LEGITIMATE agreed price (comped/fully-discounted), so defaulting absence to 0
// would be indistinguishable from a real free agreement on the record.
Deno.test("a MISSING amount yields no record, but a REAL zero is kept", () => {
  const missing = extractAgreedTerms(
    sub({
      items: {
        data: [{
          price: { id: "p", currency: "usd", unit_amount: null, recurring: { interval: "month" } },
        }],
      },
    }),
    "pro",
  );
  assertEquals(missing, null, "absence must not be recorded as zero");

  const free = extractAgreedTerms(
    sub({
      items: {
        data: [{
          price: { id: "p", currency: "usd", unit_amount: 0, recurring: { interval: "month" } },
        }],
      },
    }),
    "pro",
  );
  assertEquals(free?.amountCents, 0, "a genuine 0 is a real agreed price");
});

Deno.test("no price object at all yields no record", () => {
  assertEquals(extractAgreedTerms(sub({ items: { data: [] } }), "pro"), null);
  assertEquals(extractAgreedTerms(sub({ items: null }), "pro"), null);
});

// ── trial terms ─────────────────────────────────────────────────────

Deno.test("trial days are whole days between start and end", () => {
  const start = 1_700_000_000;
  assertEquals(trialDaysBetween(start, start + 14 * 86_400), 14);
  assertEquals(trialDaysBetween(start, start + 86_400 * 7 + 3600), 7, "floors partial days");
});

Deno.test("an absent or non-positive trial window is null, not 0", () => {
  // 0 would read as "a trial of zero days was offered", which is a different
  // claim from "no trial was offered".
  assertEquals(trialDaysBetween(null, 123), null);
  assertEquals(trialDaysBetween(123, null), null);
  assertEquals(trialDaysBetween(500, 500), null);
  assertEquals(trialDaysBetween(500, 100), null);
});

Deno.test("a trial subscription records both the days and the end date", () => {
  const start = 1_700_000_000;
  const end = start + 14 * 86_400;
  const t = extractAgreedTerms(sub({ trial_start: start, trial_end: end }), "pro");
  assertEquals(t?.trialDays, 14);
  assertEquals(t?.trialEndsAt, new Date(end * 1000).toISOString());
});

Deno.test("a non-trial subscription records null trial terms", () => {
  const t = extractAgreedTerms(sub(), "pro");
  assertEquals(t?.trialDays, null);
  assertEquals(t?.trialEndsAt, null);
});
