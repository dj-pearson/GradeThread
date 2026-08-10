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
// ── US-2117 AC1: the disclosure pointer ──────────────────────────────
//
// The row can vouch for the amount, interval and trial because those come from
// the Stripe subscription object. It cannot vouch for the WORDS, and "what was I
// told?" is what a subscription dispute turns on — so it carries a pointer to
// the archived copy the client reported rendering.

const KNOWN_VERSION = [...(await import("../lib/disclosure-versions.ts")).KNOWN_DISCLOSURE_VERSIONS][0];

Deno.test("US-2117: a known disclosure version reaches the terms", () => {
  const t = extractAgreedTerms(
    sub({ metadata: { disclosure_version: KNOWN_VERSION } }),
    "pro",
  );
  assertEquals(t?.disclosureVersion, KNOWN_VERSION);
  assertEquals(t?.rejectedDisclosureVersion, null);
});

Deno.test("US-2117: an UNKNOWN version is dropped from the record, not stored", () => {
  const t = extractAgreedTerms(
    sub({ metadata: { disclosure_version: "1999-01-01" } }),
    "pro",
  );
  assertEquals(t?.disclosureVersion, null, "a pointer to nothing must not be recorded");
  assertEquals(
    t?.rejectedDisclosureVersion,
    "1999-01-01",
    "but the disagreement has to be reportable — it means the web copy was " +
      "versioned without the edge, and a whole cohort is losing its pointer",
  );
});

Deno.test("US-2117: no metadata at all is the normal legacy case, silently", () => {
  const t = extractAgreedTerms(sub(), "pro");
  assertEquals(t?.disclosureVersion, null);
  assertEquals(t?.rejectedDisclosureVersion, null, "absence must not be reported");
});

Deno.test("US-2117: the column is actually written, and only when resolvable", () => {
  const fn = AGREED_SRC.slice(
    AGREED_SRC.indexOf("export async function recordAgreedTerms"),
  );
  assert(
    /disclosure_version: terms\.disclosureVersion/.test(fn),
    "the insert must carry the pointer, or all of this resolves to a null column",
  );
  assert(
    /rejectedDisclosureVersion/.test(fn),
    "an unresolvable version must be reported, not silently discarded",
  );
});

// The pointer is worthless if no purchase path sets it. Both subscription
// checkouts must put it on the SUBSCRIPTION — session metadata alone would not
// reach handleSubscriptionChange, which is what writes the agreement.
Deno.test("US-2117: both subscribe routes carry the version onto the subscription", async () => {
  const payments = await Deno.readTextFile(
    new URL("../routes/payments.ts", import.meta.url),
  );
  const occurrences = payments.match(/disclosure_version: disclosureVersion/g) ?? [];
  assert(
    occurrences.length >= 4,
    `expected the version on both checkout paths AND both in-place upgrade paths ` +
      `(4 sites), found ${occurrences.length}`,
  );
  assert(
    /sanitizeReportedDisclosureVersion/.test(payments),
    "a value straight off a request body must be bounded before Stripe stores it",
  );
});

// US-2117 AC1 for the OTHER paying population. applyBuyerSubscriptionChange
// returns before the seller path's recorder, so a buyer subscriber had no
// agreement row at all while a FlipDesk one did.
Deno.test("US-2117: buyer subscriptions record an agreement too", async () => {
  const webhooks = await Deno.readTextFile(
    new URL("../routes/webhooks.ts", import.meta.url),
  );
  const buyerFn = webhooks.slice(webhooks.indexOf("async function applyBuyerSubscriptionChange"));
  const end = buyerFn.indexOf("\nasync function ", 1);
  const body = end > 0 ? buyerFn.slice(0, end) : buyerFn;
  assert(
    /recordAgreedTerms\(/.test(body),
    "a Guard/Connoisseur subscriber must have the same evidentiary standing as a " +
      "FlipDesk one — this handler returns before the seller path's recorder",
  );
  assert(
    /plan !== "free"/.test(body),
    'the unmappable-price fallback ("free") must be skipped: subscription_agreements.plan ' +
      "is free text with no product column, so a buyer free and a seller free are " +
      "indistinguishable on the record",
  );
});

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

  // ⚠ THE ASSERTIONS ABOVE ASK WHETHER THE FILE CALLS IT, NOT WHETHER EACH
  // PRODUCT PATH DOES, and that difference hid a real gap until 2026-08-10:
  // appstore.ts sells TWO products, and its buyer_subscription branch returned
  // before both the audit row and the agreement. The seller branch a few lines
  // below satisfied every check here, so an App Store buyer had no record of
  // what they agreed to while an App Store seller and a Stripe buyer both did.
  //
  // Per-branch now. Each product's grant must be followed, inside its own
  // branch, by the agreement.
  const branches = [
    { label: "appstore buyer", start: 'if (mapping.kind === "buyer_subscription")', plan: "update.buyer_plan" },
    { label: "appstore seller", start: 'if (mapping.kind === "subscription")', plan: "update.flipdesk_plan" },
  ];
  for (const b of branches) {
    const at = appstore.indexOf(b.start);
    assert(at > -1, `${b.label}: branch not found — restructured?`);
    // Brace-matched, NOT sliced to the first `return c.json(`. The buyer branch
    // returns a 409 early when a Stripe subscription is already active, so
    // stopping at the first return cuts the slice before the grant — which made
    // this assertion fail against correct code and would have been "fixed" by
    // weakening it back to a file-wide check.
    const open = appstore.indexOf("{", at);
    let depth = 0;
    let close = appstore.length;
    for (let i = open; i < appstore.length; i++) {
      if (appstore[i] === "{") depth++;
      else if (appstore[i] === "}" && --depth === 0) {
        close = i;
        break;
      }
    }
    const body = appstore.slice(at, close);
    assert(
      body.includes("recordPlatformAgreement("),
      `${b.label}: the grant happens and no agreement is recorded. "What did ` +
        'this user agree to?" must be answerable for every product this route sells.',
    );
    // Scoped to the AGREEMENT CALL, not the branch. The branch also returns
    // `plan: update.buyer_plan` in its JSON response, so a branch-wide check
    // stayed green when the agreement itself was switched to the seller plan —
    // which is the version that files a record naming a plan the buyer never
    // bought.
    const call = body.slice(body.indexOf("recordPlatformAgreement("));
    const args = call.slice(0, call.indexOf("});") + 3);
    assert(
      args.includes(`plan: ${b.plan}`),
      `${b.label}: the agreement must name ${b.plan}, not the other product's plan`,
    );
    assert(
      body.includes("recordAppstoreEvent("),
      `${b.label}: the grant must leave an audit row`,
    );
  }
});
