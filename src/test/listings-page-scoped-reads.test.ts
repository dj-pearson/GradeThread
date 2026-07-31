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

/**
 * Same, but located by the RAW queryKey expression rather than a leading
 * literal — for the main read, whose key is now the shared `listingsItemsKey`
 * constant (US-2372) instead of an inline array.
 */
function queryBlockByKeyExpr(src: string, expr: string): string {
  const keyIdx = src.indexOf(`queryKey: ${expr}`);
  if (keyIdx === -1) {
    throw new Error(`No useQuery with queryKey ${expr} in ${FILE}`);
  }
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
    const block = queryBlockByKeyExpr(src, "listingsItemsKey");
    expect(block).toContain("LISTINGS_COLUMNS");
    expect(block).not.toContain(".range(");
  });

  describe("the quality-score read (US-2170)", () => {
    const block = queryBlock(src, '"item_listing_quality"');

    it("scopes to the page and chunks", () => {
      expect(block).toContain('from("listings")');
      expect(block).toContain('.in("id", chunk)');
      expect(block).toContain("fetchInChunks");
      expect(block).toContain("pageListingIds");
    });

    it("keys by LISTING id, not item id", () => {
      // items_full lateral-joins ONE listing per item and exposes it as
      // listing_id; every other listing-derived cell in the row (price, status,
      // days listed) comes from that same row. Scoring a different listing than
      // the one the row displays would put two listings' facts on one line.
      expect(block).toContain("pageListingIds");
      expect(block).not.toContain('.in("inventory_item_id"');
    });

    it("falls back to an empty map instead of taking the query down", () => {
      // If this ever runs against a database without 00476's column, PostgREST
      // answers 42703. An empty map means "nothing scored" — which is true —
      // whereas an unhandled error would blank the whole table.
      expect(block).toContain("catch");
      expect(block).toContain("return {}");
    });

    it("reuses the shared chip and mapping rather than re-deriving a score", () => {
      // The weights live server-side (lib/listing-quality-score.ts). A second
      // client-side derivation would drift from the number the server persists.
      expect(src).toContain("QualityScoreChip");
      expect(src).toContain("scoreMapFromRows");
      expect(src).not.toMatch(/function\s+\w*[sS]coreBand/);
    });
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

// ── US-2372: optimistic writes must target the cache this page READS ────────
//
// This page runs its own narrower query under ["items_full","listings",user.id]
// — deliberately distinct from the bare ["items_full", user.id] the shared
// readers use. All four inline edits nonetheless wrote their optimistic patch
// to the BARE key, which this page never reads. Two consequences, one of them
// user-visible the whole time:
//
//   - the optimistic patch landed in a cache entry nothing on screen consumes,
//     so an inline edit appeared not to take effect behind a success toast;
//   - the rollback captured `prev = items` — this page's narrower rows — and
//     wrote them into the FULL-row cache, which before US-2188 was read by
//     pipeline/overview/prep and would render with missing columns.
//
// A source scan is the right shape: both halves still type-check, both still
// "work", and nothing at runtime complains. The failure is a wrong string.

describe("optimistic writes target this page's own cache (US-2372)", () => {
  const src = source();

  it("defines the page's items key exactly once", () => {
    // The whole fix is one definition. Nine hand-spelled copies is how it
    // drifted, so a second inline spelling of the same key is a regression.
    const definition = src.match(
      /const listingsItemsKey = \["items_full", "listings", user\?\.id\] as const;/g,
    );
    expect(definition?.length).toBe(1);
  });

  it("no setQueryData in this file targets the bare full-row key", () => {
    // The exact defect. Any reintroduction fails here naming the story.
    const offenders = [...src.matchAll(/setQueryData[^\n]*\n?[^\n]*/g)]
      .map((m) => m[0])
      .filter((line) => /\["items_full", user\?\.id\]/.test(line));
    expect(offenders).toEqual([]);
  });

  it("every setQueryData in this file uses the shared key", () => {
    const calls = [...src.matchAll(/qc\.setQueryData[^(]*\(([^,]+),/g)].map(
      (m) => (m[1] ?? "").trim(),
    );
    // Guards the guard: if the edits are ever removed this test would pass
    // vacuously, so assert they are still here and still all four pairs.
    expect(calls.length).toBe(8);
    for (const arg of calls) {
      expect(arg).toContain("listingsItemsKey");
    }
  });

  it("each inline edit reconciles with the server on success", () => {
    // An optimistic value that is never re-read from the server is a claim, not
    // a fact — updateTracking and updateListingPrice both used to stop at the
    // toast, so a value the server rejected kept reading as saved for up to the
    // 15-minute staleTime.
    for (
      const fn of [
        "async function updateTracking",
        "async function markDelivered",
        "async function updateListingPrice",
        "async function patchItemColumn",
      ]
    ) {
      const at = src.indexOf(fn);
      expect(at, `${fn} not found`).toBeGreaterThan(-1);
      const body = src.slice(at, src.indexOf("\n  }", at));
      expect(
        body.includes('invalidateQueries({ queryKey: ["items_full"] })'),
        `${fn} must invalidate on success`,
      ).toBe(true);
    }
  });
});
