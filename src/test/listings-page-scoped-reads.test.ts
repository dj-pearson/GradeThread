import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2168: the listings table's per-row detail reads must stay scoped to the
// VISIBLE PAGE.
//
// All five used to fetch the whole tenant and then get looked up by id during
// render. The cover query was the worst: no filter and no limit on item_photos,
// so a 500-item seller with 8 photos each transferred ~4,000 rows to draw 50
// thumbnails. The regression is silent — the page still works, just slower and
// slower as an account grows — which is exactly the kind that survives review.
//
// This is a source-scan guard (same style as grid-image-lazy.test.ts). It can't
// prove the runtime query shape, but it does catch the two ways this decays:
// dropping the `.in("inventory_item_id", …)` scope, or dropping pageRowIds from
// the query key so the read stops re-running per page.

const FILE = "src/pages/flipdesk/listings.tsx";

function source(): string {
  return readFileSync(resolve(process.cwd(), FILE), "utf8");
}

/**
 * Extract one `useQuery({...})` block by the queryKey's leading literal.
 * Throws when absent, so a rename fails loudly instead of silently passing.
 */
function queryBlock(src: string, keyLiteral: string): string {
  const keyIdx = src.indexOf(`queryKey: [${keyLiteral}`);
  if (keyIdx === -1) {
    throw new Error(`No useQuery with queryKey starting ${keyLiteral} in ${FILE}`);
  }
  // From the key to the end of that hook — the next `});` at hook indentation.
  const rest = src.slice(keyIdx);
  const end = rest.indexOf("\n  });");
  return end === -1 ? rest : rest.slice(0, end);
}

// Each entry: [label, the queryKey's leading literal, the table it reads].
const PAGE_SCOPED_READS: ReadonlyArray<readonly [string, string, string]> = [
  ["platform chips", '"item_listing_platforms"', "listings"],
  ["draft metadata", '"item_draft_meta"', "listings"],
  ["publish issues", '"items_full", "listings", "publish_issues"', "listings"],
  ["cover thumbnails", '"items_full", "listings", "covers"', "item_photos"],
  ["impressions / CTR", '"item_listing_metrics"', "listings"],
];

describe("listings table per-row reads are page-scoped (US-2168)", () => {
  const src = source();

  for (const [label, keyLiteral, table] of PAGE_SCOPED_READS) {
    it(`${label}: scopes to the rendered page's item ids`, () => {
      const block = queryBlock(src, keyLiteral);
      expect(block).toContain(`from("${table}")`);
      // The scope itself. Without this the read spans the whole tenant.
      expect(block).toContain('.in("inventory_item_id", chunk)');
    });

    it(`${label}: keys on pageRowIds so it re-runs per page`, () => {
      const block = queryBlock(src, keyLiteral);
      // If pageRowIds leaves the key, the first page's result is served for
      // every subsequent page — rows render with another page's chips/covers.
      expect(block).toContain("pageRowIds");
    });

    it(`${label}: chunks the id list`, () => {
      const block = queryBlock(src, keyLiteral);
      // pageSize goes up to 200; a bare .in() would put ~7.4KB of UUIDs in the
      // query string and risk a URL-length rejection at the proxy.
      expect(block).toContain("fetchInChunks");
    });
  }

  it("declares the one read that is still tenant-wide", () => {
    // The main items_full read still loads the whole inventory — that is
    // US-2167, and it needs a column projection + server-side paging across all
    // 11 consumers of useItemsFull, not a change confined to this file.
    //
    // Asserted rather than ignored so the remaining gap is visible and counted.
    // When US-2167 lands, this expectation flips and the comment goes.
    const block = queryBlock(src, '"items_full", "listings"');
    expect(block).toContain("LISTINGS_COLUMNS");
    expect(block).not.toContain(".range(");
  });

  it("the five page-scoped reads sit below pageRowIds", () => {
    // Hook order is load-bearing here: these queries close over pageRowIds, so
    // they must be declared after it. Moving them back above would make the ids
    // undefined at call time.
    const anchor = src.indexOf("const pageRowIds = useMemo(");
    expect(anchor).toBeGreaterThan(-1);
    for (const [label, keyLiteral] of PAGE_SCOPED_READS) {
      const at = src.indexOf(`queryKey: [${keyLiteral}`);
      expect(at, `${label} must be declared after pageRowIds`).toBeGreaterThan(anchor);
    }
  });
});
