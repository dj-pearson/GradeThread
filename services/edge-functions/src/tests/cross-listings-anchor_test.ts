// US-3367 B2. The extension writeback points a Poshmark row's draft_id at the
// eBay draft, but the eBay draft's own draft_id is null unless a cross-push
// ever ran ensureCrossListingGroup. A filter on draft_id alone therefore
// misses the anchor, and a Poshmark sale left eBay live.

import "./_env.ts";
import { assert, assertEquals, assertMatch } from "@std/assert";
import { siblingSelector } from "../lib/cross-listings.ts";

Deno.test("the sibling filter matches members AND the anchor", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  assertEquals(siblingSelector(id), `draft_id.eq.${id},id.eq.${id}`);
});

Deno.test("the filter is a PostgREST or-list with exactly two clauses", () => {
  assertMatch(siblingSelector("abc"), /^draft_id\.eq\.[^,]+,id\.eq\.[^,]+$/);
});

// The two cases above prove the STRING. They do not prove anyone uses it, and
// for a while nobody did: the merge in 40e95fadc resurrected an older
// autoEndCrossListings, and the only call to siblingSelector left in the file
// sat inside a query whose result was thrown away. Both cases above stayed
// green the whole time, while a Poshmark sale left the eBay anchor live.
Deno.test("the query that actually runs uses the anchor filter", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/cross-listings.ts", import.meta.url),
  );
  const from = src.indexOf("export async function endOtherListings");
  assert(from > -1, "endOtherListings is gone; this guard needs repointing");
  const body = src.slice(from, src.indexOf("\n}\n", from));

  assert(
    body.includes("siblingSelector("),
    "endOtherListings builds its sibling filter without siblingSelector. The " +
      "anchor row (id.eq.<draftId>) is the eBay draft a Poshmark row points " +
      "at, and a filter on draft_id alone misses it.",
  );
  assert(
    !/\bq\.eq\("draft_id"/.test(body),
    "endOtherListings still filters draft_id on its own somewhere. Every " +
      "draft_id branch has to go through siblingSelector or it drops the anchor.",
  );
});
