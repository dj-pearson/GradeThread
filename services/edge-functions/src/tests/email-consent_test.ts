// US-911: canonical marketing-consent model. Pure (no DB/env), so this runs
// directly. The headline regression (AC1): an unsubscribe must actually suppress
// a broadcast send — before US-911 the unsubscribe link wrote `product_updates`
// while the send gate read `marketing`, so the opt-out had no effect.

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  applyCategoryConsent,
  applyUnsubscribeAll,
  isMarketingCategoryEnabled,
  isMarketingOptedOut,
  marketingConsentDenied,
  WEEKLY_NEWSLETTER_KEY,
} from "../lib/email-consent.ts";
// The broadcast/drip send gates delegate to the same model — assert the real
// readers agree with the writer, end to end.
import { marketingOptedOutEmail } from "../lib/drip-graph.ts";

Deno.test("AC1: unsubscribe-all suppresses a broadcast/drip send on the canonical key", () => {
  // The exact write the no-login unsubscribe link performs.
  const prefs = applyUnsubscribeAll({});
  // Master umbrella reader (coordinator) denies for EVERY source.
  assert(marketingConsentDenied(prefs, "weekly_newsletter"));
  assert(marketingConsentDenied(prefs, "trial_drip"));
  assert(marketingConsentDenied(prefs, "journey"));
  // The drip entry filter (a separate reader) agrees.
  assert(marketingOptedOutEmail(prefs));
  assert(isMarketingOptedOut(prefs));
});

Deno.test("AC1: the OLD product_updates key would NOT suppress (documents the fixed bug)", () => {
  // Simulate the pre-US-911 broken write: product_updates.email=false only.
  const stalePrefs = { product_updates: { email: false } };
  // The send gate reads `marketing`, so the stale opt-out leaks a send.
  assertFalse(marketingConsentDenied(stalePrefs, "weekly_newsletter"));
  assertFalse(marketingOptedOutEmail(stalePrefs));
});

Deno.test("AC2: weekly_newsletter category gates ONLY the newsletter source", () => {
  const prefs = applyCategoryConsent({}, WEEKLY_NEWSLETTER_KEY, false);
  // Newsletter is suppressed by its granular category…
  assert(marketingConsentDenied(prefs, "weekly_newsletter"));
  // …but other marketing still flows (the umbrella is still on).
  assertFalse(marketingConsentDenied(prefs, "trial_drip"));
  assertFalse(marketingConsentDenied(prefs, "journey"));
  assertFalse(isMarketingOptedOut(prefs));
});

Deno.test("opt-out model: absent prefs ⇒ everything enabled", () => {
  assertFalse(marketingConsentDenied(null, "weekly_newsletter"));
  assertFalse(marketingConsentDenied({}, "trial_drip"));
  assert(isMarketingCategoryEnabled({}, WEEKLY_NEWSLETTER_KEY));
});

Deno.test("re-subscribing a category turns it back on without touching others", () => {
  let prefs: Record<string, unknown> = applyCategoryConsent({}, WEEKLY_NEWSLETTER_KEY, false);
  assertFalse(isMarketingCategoryEnabled(prefs, WEEKLY_NEWSLETTER_KEY));
  prefs = applyCategoryConsent(prefs, WEEKLY_NEWSLETTER_KEY, true);
  assert(isMarketingCategoryEnabled(prefs, WEEKLY_NEWSLETTER_KEY));
  // Untouched master umbrella stays on.
  assertEquals(isMarketingOptedOut(prefs), false);
});
