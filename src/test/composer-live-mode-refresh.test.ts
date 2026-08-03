// The composer offers "Save & Publish to eBay" or "Save & resubmit to eBay"
// depending on ONE thing: the cached listings row. Publishing is what makes that
// row live (listing_status → active, platform_offer_id assigned), and it happens
// on the SERVER — so the only way the button changes is a cache invalidation.
//
// THE DEFECT THIS EXISTS FOR. The publish mutation invalidated items_full,
// item_photos and inventory_item_ebay, but never the ["listing", …] query it had
// just made stale. So a seller published, watched it succeed, and was still
// looking at a button offering to publish the listing that was already live —
// until they reloaded the page. Nothing was broken enough to fail: every query
// in the list refreshed, just not the one that decides the mode.
//
// Asserted against source text because the wiring is a query key, and a mounted
// test would need Supabase, the eBay taxonomy and a query client to reach it
// (the repo convention — see composer-source.ts).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composerPage as composer } from "@/lib/__tests__/helpers/composer-source";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const useEbay = read("src/hooks/use-ebay.ts");
const crossListing = read("src/hooks/use-cross-listing.ts");

/** The body of a mutation's onSuccess block, from its hook declaration on. */
function onSuccessOf(source: string, hook: string): string {
  const start = source.indexOf(`export function ${hook}(`);
  expect(start, `${hook} not found`).toBeGreaterThan(-1);
  const from = source.indexOf("onSuccess", start);
  expect(from, `${hook} has no onSuccess`).toBeGreaterThan(-1);
  return source.slice(from, source.indexOf("\n  });", from));
}

describe("publish flips the composer into live mode without a reload", () => {
  it("the mode really does hang on the cached listing row", () => {
    // If this stops being true, the invalidations below stop being the fix.
    expect(composer).toMatch(/queryKey: \["listing", item\?\.listing_id\]/);
    expect(composer).toMatch(
      /listing\.listing_status === "active"[\s\S]{0,80}platform_offer_id/,
    );
  });

  it("usePublishToEbay invalidates the listing query", () => {
    expect(onSuccessOf(useEbay, "usePublishToEbay")).toMatch(
      /queryKey: \["listing"\]/,
    );
  });

  it("useCrossPush invalidates it too", () => {
    // Cross-push writes one listings row per platform, eBay included.
    expect(onSuccessOf(crossListing, "useCrossPush")).toMatch(
      /queryKey: \["listing"\]/,
    );
  });

  it("invalidates by prefix, not by a listing id the response does not carry", () => {
    // The push response returns eBay's item id, NOT our listings row id. A
    // ["listing", res.listing_id] invalidation would look right, match nothing,
    // and put the bug straight back.
    expect(onSuccessOf(useEbay, "usePublishToEbay")).not.toMatch(
      /queryKey: \["listing", /,
    );
  });
});
