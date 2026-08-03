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

// US-2173 moved the five page-scoped reads into their own module. The scan
// follows the code: the per-row reads are asserted against the query module,
// the main items_full read against the page that still owns it. What is being
// guarded is unchanged — only the address is.
const QUERIES_FILE = "src/pages/flipdesk/listings-page-queries.ts";
const PAGE_FILE = "src/pages/flipdesk/listings.tsx";
// US-2173 AC3: the desktop table became its own component, so anything asserted
// about what a ROW renders now lives here. The page still owns the main read,
// the mutations and the hook-order constraint, which is why both are scanned.
const TABLE_FILE = "src/pages/flipdesk/listings-table.tsx";
/** Kept for the error messages below, which name the file a rename broke. */
const FILE = QUERIES_FILE;

function source(): string {
  return readFileSync(resolve(process.cwd(), QUERIES_FILE), "utf8");
}

function pageSource(): string {
  return readFileSync(resolve(process.cwd(), PAGE_FILE), "utf8");
}

function tableSource(): string {
  return readFileSync(resolve(process.cwd(), TABLE_FILE), "utf8");
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
    throw new Error(`No useQuery with queryKey ${expr} in ${PAGE_FILE}`);
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

  it("the main read asks the server for ONE page (US-2168 AC3)", () => {
    // Third form of this assertion, and the last one it should need. It began
    // as "the read is unbounded"; became "bounded per request, still the whole
    // tenant" when US-2167 wrapped it in the paging loop; and is now "one page,
    // selected server-side", which is what AC3 actually asked for.
    const block = queryBlockByKeyExpr(pageSource(), "listingsPageKey");
    expect(block).toContain('supabase.rpc("flipdesk_listing_page"');
    // The criteria must be IN the key. Without them every tab, search and page
    // shares one cache entry and the table shows the previous answer.
    const key = pageSource().slice(pageSource().indexOf("const listingsPageKey"));
    for (const part of ["tab", "search", "soldFilter", "sortPreset", "columnSort", "filterQuery", "page"]) {
      expect(key.slice(0, 400)).toContain(part);
    }
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
      // The chip renders inside a row, so it moved to the table component with
      // the rest of the row markup; the mapping is still the query module's.
      // All three files are checked for a re-derived band, since any of them
      // could grow one.
      expect(tableSource()).toContain("QualityScoreChip");
      expect(src).toContain("scoreMapFromRows");
      expect(src).not.toMatch(/function\s+\w*[sS]coreBand/);
      expect(pageSource()).not.toMatch(/function\s+\w*[sS]coreBand/);
      expect(tableSource()).not.toMatch(/function\s+\w*[sS]coreBand/);
    });
  });

  it("the page calls the detail reads BELOW its pageRowIds", () => {
    // Hook order is load-bearing: these queries close over pageRowIds, so the
    // call has to come after it. US-2173 moved the queries into a hook, which
    // moves the constraint from "where the queries sit" to "where the hook is
    // called" — the failure is the same (undefined ids at call time), so the
    // guard follows it rather than disappearing with the code.
    const page = pageSource();
    const anchor = page.indexOf("const pageRowIds = useMemo(");
    const call = page.indexOf("usePageRowDetails({");
    expect(anchor).toBeGreaterThan(-1);
    expect(call, "usePageRowDetails must be called after pageRowIds").toBeGreaterThan(
      anchor,
    );
  });

  it("the query module still derives pageListingIds after its inputs", () => {
    // The quality read keys on listing ids derived from pageRows, so the same
    // ordering rule applies one level down.
    const at = src.indexOf("const pageListingIds = useMemo(");
    expect(at).toBeGreaterThan(-1);
    expect(src.indexOf('queryKey: ["item_listing_quality"')).toBeGreaterThan(at);
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
  // The optimistic writes stayed in the page — US-2173 moved the READS out, not
  // the mutations, so this half still scans listings.tsx.
  const src = pageSource();

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

  it("every setQueryData in this file uses the key this page reads", () => {
    const calls = [...src.matchAll(/qc\.setQueryData[^(]*\(([^,]+),/g)].map(
      (m) => (m[1] ?? "").trim(),
    );
    // US-2168 collapsed eight hand-written calls into ONE writer, `patchRow`,
    // which is the durable form of this fix: US-2372 happened because the key
    // was spelled by hand at every site, and a page that moves its key or its
    // cache SHAPE (as this one just did, from ItemFullRow[] to a
    // {total, rows, …} document) would otherwise have to get all eight right
    // again. The count is 2 — the patch and its rollback.
    expect(calls.length).toBe(2);
    for (const arg of calls) {
      expect(arg).toContain("listingsPageKey");
    }
    // And the four handlers must still route through it, or the assertion above
    // passes while the edits write somewhere else.
    expect(src).toContain("function patchRow(");
    const uses = [...src.matchAll(/const rollback = patchRow\(/g)];
    expect(uses.length).toBe(4);
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

// ── US-2173 AC5: the constraints that only exist as comments ────────────────
//
// Two rules on this page are enforced by nothing but a comment, and both were
// learned the expensive way:
//
//   • US-419 — the page's items query uses a DISTINCT cache key from the shared
//     readers, because it projects a narrower column set. Share the key and a
//     partial-column entry wins, starving other surfaces of fields they read.
//   • US-1489 — three effects are keyed on ONE dependency on purpose, because
//     they WRITE searchParams; adding the obvious missing dep makes them loop.
//
// A refactor that moves code past them is exactly when a comment gets dropped,
// and neither loss has a symptom a test would otherwise catch — one is a subtle
// cache bug, the other is an infinite render loop nobody attributes to the
// deleted line. So the comments are asserted.

describe("the load-bearing comments survive a refactor (US-2173)", () => {
  const page = pageSource();

  it("keeps the US-419 distinct-cache-key rationale next to the query", () => {
    expect(page).toContain("US-419");
    const at = page.indexOf("US-419");
    // Widened from 1200: US-2168 added the paragraph explaining that US-419's
    // ORIGINAL reason (a narrower projection) no longer applies while its RULE
    // still does. Keeping that history is the point of this guard, so the
    // window has to fit it.
    const near = page.slice(at, at + 2400);
    // Not just the tag — the reason. A bare "US-419" left behind explains
    // nothing to the next reader.
    expect(near).toMatch(/DISTINCT|distinct/);
    // And it has to still sit with the query it constrains.
    expect(near).toContain("listingsPageKey");
  });

  it("keeps every US-1489 effect-dependency note", () => {
    // Three effects carry it; losing any one reintroduces a different loop.
    const hits = page.match(/US-1489/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps the US-733 virtualization threshold and its rationale", () => {
    // AC3's behaviour: below the threshold the table renders exactly as before,
    // so the common case carries zero regression risk.
    expect(page).toContain("VIRTUALIZE_ROW_THRESHOLD");
    expect(page).toContain("US-733");
  });

  it("carries the US-2168 page-scoping rationale with the moved reads", () => {
    // The reads moved; the reason they are page-scoped has to move with them,
    // or the next person reads five unexplained .in() calls.
    const mod = source();
    expect(mod).toContain("US-2168");
    expect(mod).toMatch(/VISIBLE PAGE/);
    // And the caller-ordering constraint, which is now the module's to state.
    expect(mod).toMatch(/hooks run in order/);
  });
});
