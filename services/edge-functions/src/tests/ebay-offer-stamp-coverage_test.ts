// US-3110: did the per-SKU offer stamp actually land?
//
// THE HOLE THIS CLOSES. US-3111 stopped the catalog pass re-reading every SKU
// by stamping inventory_items.ebay_offer_checked_at for each SKU it spent a
// call on. The stamp is
//
//     update(inventory_items).eq(user_id, u).in(sku, chunk)
//
// and an UPDATE that matches NO ROW is not an error. PostgREST answers 200 with
// an empty body, so a SKU eBay names that has no local inventory_items row -
// an orphan listing, a locally-deleted item, a SKU eBay minted when it migrated
// a Seller-Hub listing - costs a call on every pass, stamps nothing, never
// enters the skip set, and is re-read forever.
//
// US-3111 AC4 promised that a FAILED stamp write is logged rather than
// swallowed. A stamp that succeeds while matching zero rows is not a failed
// write, so that promise never covered the case that actually happens: prod
// measured roughly 1.7 offer reads per SKU per day against a 24h recheck
// window and four passes a day, which should be 1.0.
//
// unstampedOfferCoverage is pure so the arithmetic is provable without a
// database, and bounded so a catalog that stamps nothing cannot print a
// thousand SKUs into the container log every six hours.

// US-2379: flipdesk-ebay.ts reaches lib/supabase.ts through its static imports,
// which reads env at module load. This must come first.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  MAX_LOGGED_UNSTAMPED_SKUS,
  unstampedOfferCoverage,
} from "../routes/flipdesk-ebay.ts";

Deno.test("full coverage reports no gap and an empty sample", () => {
  const c = unstampedOfferCoverage(["a", "b", "c"], ["a", "b", "c"]);
  assertEquals(c.read, 3);
  assertEquals(c.stamped, 3);
  assertEquals(c.unstamped, 0);
  assertEquals(c.sample, []);
});

Deno.test("a SKU read but not stamped is named", () => {
  // "b" is the eBay-side SKU with no inventory_items row: the call was spent,
  // the update matched nothing, and no error was raised anywhere.
  const c = unstampedOfferCoverage(["a", "b", "c"], ["a", "c"]);
  assertEquals(c.read, 3);
  assertEquals(c.stamped, 2);
  assertEquals(c.unstamped, 1);
  assertEquals(c.sample, ["b"]);
});

Deno.test("nothing stamped at all is the whole read set", () => {
  // The regression that matters most: the column vanished, the schema cache
  // went stale, or the user_id filter stopped matching. Every read is a gap and
  // the old code could not tell this from complete success.
  const c = unstampedOfferCoverage(["a", "b"], []);
  assertEquals(c.read, 2);
  assertEquals(c.stamped, 0);
  assertEquals(c.unstamped, 2);
  assertEquals(c.sample, ["a", "b"]);
});

Deno.test("an empty pass reports zeros rather than a gap", () => {
  const c = unstampedOfferCoverage([], []);
  assertEquals(c.read, 0);
  assertEquals(c.stamped, 0);
  assertEquals(c.unstamped, 0);
  assertEquals(c.sample, []);
});

Deno.test("a SKU read twice counts once", () => {
  // listAllOffers pushes one entry per SKU it spends a call on; a duplicate in
  // eBay's inventory list must not inflate the read count and make a complete
  // pass look like a gap.
  const c = unstampedOfferCoverage(["a", "a", "b"], ["a", "b"]);
  assertEquals(c.read, 2);
  assertEquals(c.stamped, 2);
  assertEquals(c.unstamped, 0);
});

Deno.test("a stamp for a SKU this pass did not read cannot go negative", () => {
  // A concurrent pass (webhook-triggered while the scheduled one runs) can
  // stamp SKUs this pass never asked about. Subtracting counts instead of
  // comparing sets would report -1 unstamped and read as healthy.
  const c = unstampedOfferCoverage(["a"], ["a", "b", "c"]);
  assertEquals(c.read, 1);
  assertEquals(c.stamped, 1);
  assertEquals(c.unstamped, 0);
  assertEquals(c.sample, []);
});

Deno.test("the sample is bounded however large the gap", () => {
  const read = Array.from({ length: 500 }, (_, i) => `sku-${i}`);
  const c = unstampedOfferCoverage(read, []);
  assertEquals(c.read, 500);
  assertEquals(c.unstamped, 500);
  assertEquals(c.sample.length, MAX_LOGGED_UNSTAMPED_SKUS);
  assertEquals(c.sample[0], "sku-0");
});

Deno.test("the sample bound is a real bound, not a big number", () => {
  // A limit of a thousand would satisfy the test above and still flood the log.
  assertEquals(MAX_LOGGED_UNSTAMPED_SKUS > 0, true);
  assertEquals(MAX_LOGGED_UNSTAMPED_SKUS <= 25, true);
});

Deno.test("an explicit sample limit is honoured", () => {
  const c = unstampedOfferCoverage(["a", "b", "c", "d"], [], 2);
  assertEquals(c.unstamped, 4);
  assertEquals(c.sample, ["a", "b"]);
});

Deno.test("a zero sample limit still counts the gap", () => {
  // The count is the operator's number; the sample is a convenience. Turning
  // the sample off must not turn the measurement off.
  const c = unstampedOfferCoverage(["a", "b"], ["a"], 0);
  assertEquals(c.unstamped, 1);
  assertEquals(c.sample, []);
});

// - Wiring -
//
// The arithmetic above is provable in isolation and says NOTHING about whether
// the pass feeds it real data. The measurement depends on one clause: without
// `.select("sku")` PostgREST returns an empty body, every stamp reads as
// landing on nothing, and the function above would report a 100% gap on a
// perfectly healthy catalog. A source scan is the right instrument for that,
// because it is a question about where a call is wired.

/**
 * Block comments as blocks FIRST, then `//` lines. A comment that explains a
 * clause is otherwise indistinguishable from the clause itself, and the comment
 * next to a control is exactly where its tokens get quoted.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

Deno.test("the offer stamp asks PostgREST which rows it hit", async () => {
  const src = stripComments(
    await Deno.readTextFile(
      new URL("../routes/flipdesk-ebay.ts", import.meta.url),
    ),
  );
  // Scoped to the OFFER stamp. The specifics stamp a few lines below is a
  // sibling with the same shape, and a whole-file scan would pass on it.
  const start = src.indexOf(".update({ ebay_offer_checked_at:");
  assert(start >= 0, "the offer stamp write moved or was renamed");
  const end = src.indexOf("unstampedOfferCoverage(", start);
  assert(end > start, "the coverage check is no longer run after the stamp");
  const block = src.slice(start, end);
  // US-3362 rekeyed the stamp from `sku` to the resolved inventory_items.id,
  // which is the point of that story: keyed on `sku` the UPDATE matched zero
  // rows for a Minted, Renamed or Variant SKU and still answered 200. This
  // assertion used to pin the COLUMN and would have read that fix as the
  // regression it exists to catch, so it now pins the PROPERTY - the stamp asks
  // PostgREST which rows it hit - and accepts either key.
  assert(
    block.includes('.select("id")') || block.includes('.select("sku")'),
    "the offer stamp no longer returns the rows it updated, so the unstamped " +
      "count is meaningless",
  );
});
