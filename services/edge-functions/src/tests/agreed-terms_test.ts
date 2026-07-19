// US-2117: the agreed-terms snapshot.
//
// This is EVIDENTIARY data — its only job is to be trusted later, when someone
// asks what a user was actually shown. So the interesting cases are all the ones
// where we must REFUSE to write rather than write something plausible: a record
// with a guessed amount proves nothing while looking authoritative, which is
// worse than a visible gap.
//
//   deno test --allow-env src/tests/agreed-terms_test.ts

import { assert, assertEquals } from "@std/assert";

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

// ── US-2116 AC6: which PLATFORM captured the consent ─────────────────
//
// Apple and Google collect the affirmative agreement natively. Duplicating it
// would be dishonest — we did not take that consent and cannot attest to its
// wording. What was missing is any server-side record that it happened AT ALL,
// which left "what did this user agree to?" answerable for Stripe subscribers
// and unanswerable for IAP/Play ones.

const AGREED_SRC = await Deno.readTextFile(
  new URL("../lib/agreed-terms.ts", import.meta.url),
);

Deno.test("US-2116: the platform recorder does NOT invent a price", () => {
  const fn = AGREED_SRC.slice(AGREED_SRC.indexOf("export async function recordPlatformAgreement"));
  assert(
    /amount_cents: 0/.test(fn),
    "the platform owns and localises the price — inventing a figure here is the " +
      "same error US-2117 refuses on the Stripe path",
  );
  assert(
    /NOT a real price/.test(fn),
    "the zero must be explained in place, or a later reader will treat it as a " +
      "real amount the user agreed to",
  );
});

// A platform transaction id must not be able to collide with a Stripe
// subscription id in the uniqueness index.
Deno.test("US-2116: the external id is namespaced by platform", () => {
  const fn = AGREED_SRC.slice(AGREED_SRC.indexOf("export async function recordPlatformAgreement"));
  assert(
    /\$\{args\.source\}:\$\{args\.externalId\}/.test(fn),
    "stripe_subscription_id must be namespaced as <source>:<id> so an Apple " +
      "transaction id cannot collide with a Stripe subscription id",
  );
});

Deno.test("US-2116: a duplicate platform agreement is not an error", () => {
  const fn = AGREED_SRC.slice(AGREED_SRC.indexOf("export async function recordPlatformAgreement"));
  assert(
    /23505/.test(fn),
    "a replayed IAP verify or a repeated RTDN must not report a failure — the " +
      "uniqueness index firing IS the idempotency working",
  );
});

// Both platform paths must actually call it, or the gap this closes reopens on
// one side while looking closed on the other.
Deno.test("US-2116: both platform purchase paths record an agreement", async () => {
  const appstore = await Deno.readTextFile(
    new URL("../routes/appstore.ts", import.meta.url),
  );
  const play = await Deno.readTextFile(
    new URL("../routes/google-play-rtdn.ts", import.meta.url),
  );
  assert(/recordPlatformAgreement\(/.test(appstore), "appstore verify must record");
  assert(/recordPlatformAgreement\(/.test(play), "play RTDN reverify must record");
  assert(/source: "appstore"/.test(appstore));
  assert(/source: "google_play"/.test(play));
});
