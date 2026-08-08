// US-2404: bulk resubmit — POST /listings/bulk-revise.
//
// The route needs a live eBay connection and a real Supabase, so this is a
// SOURCE guard in the style of cert-id-validation_test.ts: the properties that
// can regress here are structural, and every one of them is checkable without
// running the handler.
//
// The property that matters most is the one the story exists to protect: a bulk
// action must make the SAME refusals as the one-at-a-time path. It does that by
// calling the same function, so these assert that the shared call site is real
// and that nothing re-implemented the checks beside it.

import { assert } from "@std/assert";

// Line endings normalized to LF before anything reads these bytes. The blob is
// LF and a Windows working tree is CRLF, so the `[\s\S]{0,400}` windows below
// counted a byte per line that CI never sees — the "one row throwing does not
// abandon the rest" guard failed locally on untouched code (US-2429). Raising
// the numbers would have hidden it and made them mean nothing; normalizing
// keeps a window of 400 the same 400 characters everywhere.
const SRC = Deno.readTextFileSync(
  new URL("../routes/flipdesk-ebay.ts", import.meta.url),
).replace(/\r\n/g, "\n");

/** The body of the bulk-revise handler, bounded by the next route registration. */
function bulkHandler(): string {
  const at = SRC.indexOf('flipdeskEbayRoutes.post("/listings/bulk-revise"');
  assert(at > -1, "the bulk-revise route is gone");
  const next = SRC.indexOf("flipdeskEbayRoutes.", at + 40);
  return SRC.slice(at, next === -1 ? SRC.length : next);
}

Deno.test("US-2404: bulk-revise runs the SAME per-listing function as the single route", () => {
  // Not a copy of the revise logic. If someone inlines it here, every refusal
  // the single route makes has to be remembered a second time — which is the
  // failure this story was filed to avoid.
  const body = bulkHandler();
  assert(
    /reviseOneListing\(\s*listingId,\s*userId,/.test(body),
    "bulk-revise no longer calls reviseOneListing — it has grown its own copy " +
      "of the revise logic, and the two will drift",
  );
  // And the single route must still call it too, or the sharing is one-sided.
  const single = SRC.slice(SRC.indexOf('flipdeskEbayRoutes.post("/listings/:id/revise"'));
  assert(
    single.includes("await reviseOneListing(listingId, userId, {"),
    "the single-listing route stopped calling reviseOneListing",
  );
});

Deno.test("US-2404: it is tenant-scoped from the workspace owner, never the body", () => {
  const body = bulkHandler();
  assert(
    /const userId = c\.get\("workspaceOwnerId"\) \?\? c\.get\("userId"\);/.test(body),
    "bulk-revise no longer resolves the tenant from the request context (US-268)",
  );
  // The ids arrive in the BODY, so the ownership check cannot be skipped for
  // any of them: every id goes through reviseOneListing with that userId.
  assert(
    !/listing_ids[\s\S]{0,400}user_id/.test(body),
    "bulk-revise appears to take a user id from the request body",
  );
});

Deno.test("US-2404: Pro+ gated and capped, like the other bulk routes", () => {
  const body = bulkHandler();
  assert(
    /requireFlipdesk\(c, \{ feature: "bulkActions", userId \}\)/.test(body),
    "the bulkActions plan gate (US-208) is missing",
  );
  assert(
    /ids\.length > MAX_BULK_REVISE_ITEMS/.test(body),
    "the per-request cap is gone — a selection of any size would run in one request",
  );
  const cap = /const MAX_BULK_REVISE_ITEMS = (\d+);/.exec(SRC)?.[1];
  assert(cap && Number(cap) > 0 && Number(cap) <= 50, `cap is ${cap}`);
});

Deno.test("US-2404: results are per row, and a refusal is never reported as pushed", () => {
  const body = bulkHandler();
  // ok is derived from the row's own outcome, not assumed.
  assert(
    /const ok = outcome\.status === 200 && outcome\.body\.ok === true;/.test(body),
    "the per-row ok flag no longer reads the row's actual outcome — a refusal " +
      "could be counted as pushed, which is the exact defect bulk-price removed",
  );
  assert(
    /results\.push\(/.test(body) && /results,/.test(body),
    "per-row results are no longer returned; an aggregate count alone hides refusals",
  );
  assert(
    /pushed = results\.filter\(\(r\) => r\.ok\)\.length/.test(body),
    "the pushed count is no longer derived from the per-row results",
  );
});

Deno.test("US-2404: one row throwing does not abandon the rest of the selection", () => {
  const body = bulkHandler();
  assert(
    /catch \(err\)[\s\S]{0,400}continue;/.test(body),
    "a throw from one listing now aborts the loop — the seller would have no " +
      "way to tell which of the remaining ids ran",
  );
});
