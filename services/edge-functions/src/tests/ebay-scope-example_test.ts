// US-3042: the documented EBAY_SCOPES value must be the scope set we actually
// request.
//
// THE BUG THIS FILE EXISTS BECAUSE OF. `.env.example` pinned an EBAY_SCOPES
// value that had gone stale by two scopes: sell.analytics.readonly and
// sell.payment.dispute were both in getScopes()'s built-in default and neither
// was in the example. The variable is optional and production appears not to set
// it, so nothing was broken - it was a landmine. Scopes are baked into the token
// AT CONSENT, so an operator who pasted the example into Coolify would have
// dropped per-listing traffic reports and every payment-dispute read at the next
// reconnect, with no error: eBay just answers 403 and the connection picks up an
// analytics_access_denied / disputes_access_denied flag weeks later. US-3112
// already describes exactly that symptom on one production connection.
//
// Two files that must agree and can be edited independently is the same shape as
// ebay-retention_test.ts (the sweep and the privacy page), and it gets the same
// treatment: read both, require them to match.
//
// Asserted through buildConsentUrl rather than through getScopes, which is not
// exported - and which is the better question anyway. What matters is the scope
// string that reaches eBay's consent screen, not the value of a helper.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { buildConsentUrl } from "../lib/ebay-client.ts";

const ENV_EXAMPLE = new URL("../../.env.example", import.meta.url);

/** The `scope` parameter eBay's consent screen would receive right now. */
function consentScopes(): Set<string> {
  const url = new URL(buildConsentUrl("state"));
  const scope = url.searchParams.get("scope") ?? "";
  return new Set(scope.split(/\s+/).filter(Boolean));
}

/**
 * Run `fn` with these env vars set, restoring whatever was there before. The
 * scope list is read from the environment, so a test that leaked a value would
 * change the answer for every case after it in this file.
 */
function withEnv<T>(vars: Record<string, string | null>, fn: () => T): T {
  const before = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    before.set(k, Deno.env.get(k));
    if (v === null) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

/** EBAY_APP_ID and EBAY_RU_NAME are required by buildConsentUrl, not by us. */
const CONSENT_ENV = { EBAY_APP_ID: "test-app-id", EBAY_RU_NAME: "test-ru-name" };

/**
 * The value `.env.example` documents, whether it is a live assignment or (as it
 * should be, so a paste inherits the default) a commented one.
 *
 * Deliberately strict about the shape: `EBAY_SCOPES=` with the `=` adjoining, so
 * the paragraph further down the file that mentions the variable in prose is not
 * mistaken for an assignment. A scan that matched it would read the surrounding
 * sentence as a scope list and report an empty set, which looks the same as a
 * file with no EBAY_SCOPES line at all.
 */
async function documentedScopes(): Promise<Set<string>> {
  const src = await Deno.readTextFile(ENV_EXAMPLE);
  const lines = src.split(/\r?\n/).filter((l) => /^#?\s*EBAY_SCOPES=/.test(l));
  assertEquals(
    lines.length,
    1,
    `expected exactly one EBAY_SCOPES assignment in .env.example, found ` +
      `${lines.length}`,
  );
  const value = lines[0]!.replace(/^#?\s*EBAY_SCOPES=/, "").trim();
  return new Set(value.split(/\s+/).filter(Boolean));
}

Deno.test(".env.example documents the scope set we actually request", async () => {
  const documented = await documentedScopes();
  const requested = withEnv({ ...CONSENT_ENV, EBAY_SCOPES: null }, consentScopes);

  // Floors. Every comparison below is between two sets, and two empty sets are
  // equal - which is what this test would report if the example line stopped
  // parsing or buildConsentUrl stopped emitting a scope.
  assert(
    requested.size >= 6,
    `only ${requested.size} scopes in the built-in default - getScopes() is ` +
      `not being read`,
  );
  assert(
    documented.size >= 6,
    `only ${documented.size} scopes parsed out of .env.example`,
  );

  const missing = [...requested].filter((s) => !documented.has(s)).sort();
  const extra = [...documented].filter((s) => !requested.has(s)).sort();
  assertEquals(
    { missing, extra },
    { missing: [], extra: [] },
    `.env.example's EBAY_SCOPES has drifted from the built-in default. An ` +
      `operator who pastes it loses "missing" at the next consent and asks for ` +
      `"extra" the keyset may not be licensed for, which fails the WHOLE ` +
      `consent screen.`,
  );
});

Deno.test("pasting the documented value changes nothing", async () => {
  // The property stated the way an operator would experience it, rather than as
  // set arithmetic: set EBAY_SCOPES to exactly what the example says, and the
  // consent screen must ask for the same things it asked for unset.
  const documented = await documentedScopes();
  const unset = withEnv({ ...CONSENT_ENV, EBAY_SCOPES: null }, consentScopes);
  const pasted = withEnv(
    { ...CONSENT_ENV, EBAY_SCOPES: [...documented].join(" ") },
    consentScopes,
  );
  assertEquals([...pasted].sort(), [...unset].sort());
});

Deno.test("the restricted scopes stay out of both", async () => {
  // commerce.identity.readonly and sell.negotiation are gated by eBay and are
  // NOT on this keyset. Requesting one does not degrade a feature, it fails the
  // entire consent screen and blocks every connect and reconnect - so the
  // example carrying one would be a worse accident than the missing two it had.
  // sell.logistics is the same situation (US-2160).
  const documented = await documentedScopes();
  const requested = withEnv({ ...CONSENT_ENV, EBAY_SCOPES: null }, consentScopes);
  for (const restricted of [
    "commerce.identity.readonly",
    "sell.negotiation",
    "sell.logistics",
  ]) {
    const suffix = `api_scope/${restricted}`;
    assert(
      ![...requested].some((s) => s.endsWith(suffix)),
      `${restricted} is in the built-in default; consent will fail on this keyset`,
    );
    assert(
      ![...documented].some((s) => s.endsWith(suffix)),
      `${restricted} is in .env.example; an operator who pastes it breaks connect`,
    );
  }
});
