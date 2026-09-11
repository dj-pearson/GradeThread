// US-3367 B2. The extension writeback points a Poshmark row's draft_id at the
// eBay draft, but the eBay draft's own draft_id is null unless a cross-push
// ever ran ensureCrossListingGroup. A filter on draft_id alone therefore
// misses the anchor, and a Poshmark sale left eBay live.

import { assertEquals, assertMatch } from "@std/assert";
import { siblingSelector } from "../lib/cross-listings.ts";

Deno.test("the sibling filter matches members AND the anchor", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  assertEquals(siblingSelector(id), `draft_id.eq.${id},id.eq.${id}`);
});

Deno.test("the filter is a PostgREST or-list with exactly two clauses", () => {
  assertMatch(siblingSelector("abc"), /^draft_id\.eq\.[^,]+,id\.eq\.[^,]+$/);
});
