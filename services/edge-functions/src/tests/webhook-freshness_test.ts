// US-2326 AC2: the webhook replay window.
//
// A signature proves the provider signed a payload. It does not prove the
// payload is RECENT — a captured delivery stays validly signed forever, so
// anyone holding one can replay it indefinitely. Both receivers relied entirely
// on event-id dedupe, which is skipped when the id header is absent and fails
// OPEN on a database error, so replay protection had two holes in it.
//
// eBay and Shopify both already sent the timestamp needed and neither receiver
// read it. These pin the rule and, importantly, its two asymmetries.

import { assert, assertEquals } from "@std/assert";
import {
  checkFreshness,
  DEFAULT_FRESHNESS_WINDOW_MS,
} from "../lib/webhook-freshness.ts";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

Deno.test("US-2326: a recent notification is fresh", () => {
  const v = checkFreshness(iso(-30_000), NOW);
  assertEquals(v.fresh, true);
});

Deno.test("US-2326: an ABSENT timestamp is accepted, deliberately", () => {
  // The asymmetry that matters most. Rejecting on absence would turn any
  // provider header rename — or a topic that ships without the field — into an
  // outage on a path we do not control. The signature has already been
  // verified; freshness is a second line, and a second line that can take the
  // service down by itself is a worse trade than the replay risk it removes.
  for (const missing of [undefined, null, "", "   "]) {
    const v = checkFreshness(missing, NOW);
    assertEquals(v.fresh, true, `${JSON.stringify(missing)} should pass`);
    assertEquals(v.reason, "absent");
  }
});

Deno.test("US-2326: a PRESENT but unparseable timestamp is rejected", () => {
  // The other side of the same asymmetry. This is not a provider omitting a
  // field — it is a value that does not mean what it claims, which is the shape
  // a forged replay would have.
  // NB "0000" is NOT here: Date.parse accepts it as year zero, so it is a
  // valid-but-ancient timestamp caught by the staleness branch instead
  // (asserted below). Rejected either way — via the honest reason.
  for (const junk of ["not-a-date", "12:00", "Thurs", "yesterday"]) {
    const v = checkFreshness(junk, NOW);
    assertEquals(v.fresh, false, `${junk} should be rejected`);
    assertEquals(v.reason, "unparseable");
  }
});

Deno.test("US-2326: a stale delivery is rejected", () => {
  const v = checkFreshness(iso(-DEFAULT_FRESHNESS_WINDOW_MS - 1_000), NOW);
  assertEquals(v.fresh, false);
  assertEquals(v.reason, "too_old");
  assert((v as { ageMs: number }).ageMs > DEFAULT_FRESHNESS_WINDOW_MS);
});

Deno.test("US-2326: the window is SYMMETRIC, for clock skew", () => {
  // A provider clock a few minutes ahead is ordinary. Without the future side
  // of the window every one of its deliveries would be rejected, which looks
  // exactly like an outage and is not one.
  assertEquals(checkFreshness(iso(60_000), NOW).fresh, true);
  const tooNew = checkFreshness(iso(DEFAULT_FRESHNESS_WINDOW_MS + 1_000), NOW);
  assertEquals(tooNew.fresh, false);
  assertEquals(tooNew.reason, "too_new");
});

Deno.test("US-2326: the boundary is inclusive on both sides", () => {
  // Exactly at the window is accepted. An off-by-one here shows up as rare,
  // unreproducible rejections, which is the worst way to find it.
  assertEquals(checkFreshness(iso(-DEFAULT_FRESHNESS_WINDOW_MS), NOW).fresh, true);
  assertEquals(checkFreshness(iso(DEFAULT_FRESHNESS_WINDOW_MS), NOW).fresh, true);
});

Deno.test("US-2326: both receivers actually apply the window", async () => {
  // The rule is worthless unbound to a caller. Source-checked because driving
  // these receivers needs a signed payload from each provider.
  const src = await Deno.readTextFile(
    new URL("../routes/flipdesk-webhooks.ts", import.meta.url),
  );
  assert(
    /ebayNotif\.publishDate \?\? ebayNotif\.eventDate/.test(src),
    "the eBay receiver no longer checks publishDate",
  );
  assert(
    src.includes('c.req.header("x-shopify-triggered-at")'),
    "the Shopify receiver no longer reads X-Shopify-Triggered-At",
  );
  // Both must reject AFTER signature verification, so an unsigned request is
  // still reported as unsigned rather than as stale.
  const shopifyAt = src.indexOf('c.req.header("x-shopify-triggered-at")');
  const hmacAt = src.indexOf("verifyWebhookHmac(rawBody, hmacHeader)");
  assert(hmacAt > -1 && shopifyAt > hmacAt, "Shopify checks freshness before the HMAC");
});
