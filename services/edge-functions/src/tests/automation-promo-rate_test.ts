// US-2232: the set_promo_rate automation must push the Promoted Listings bid to
// eBay before it is recorded. Previously it wrote listings.promo_rate_pct
// local-only and counted as applied, so a paid rule silently no-oped on the
// marketplace. promoRatePushable is the gate applyMatch checks: only a listing
// with a live eBay id AND a configured eBay client is pushable; anything else is
// skipped (retried next run), never recorded as a clean success.

import { assert } from "@std/assert";
import { promoRatePushable } from "../routes/flipdesk-automations.ts";

Deno.test("live eBay listing + eBay configured → pushable", () => {
  assert(promoRatePushable("v1|1234567890|0", true));
});

Deno.test("no live eBay listing → NOT pushable (skipped, not local-only)", () => {
  assert(!promoRatePushable(null, true));
  assert(!promoRatePushable(undefined, true));
  assert(!promoRatePushable("", true));
});

Deno.test("eBay not configured → NOT pushable", () => {
  assert(!promoRatePushable("v1|1234567890|0", false));
});
