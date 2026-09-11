import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parsePageParam } from "@/hooks/use-url-param-state";

const here = dirname(fileURLToPath(import.meta.url));
const LISTINGS = readFileSync(resolve(here, "../pages/flipdesk/listings.tsx"), "utf8");
const TABLE = readFileSync(resolve(here, "../pages/flipdesk/listings-table.tsx"), "utf8");
const ITEM = readFileSync(resolve(here, "../pages/flipdesk/item.tsx"), "utf8");
const GRID = readFileSync(resolve(here, "../pages/flipdesk/grid.tsx"), "utf8");

/**
 * Code lines only.
 *
 * Both of the not-to-match assertions below are about `setPage(`, and both
 * effects explain in a comment WHY they no longer call it. Without this the
 * guard reads its own documentation and fires on correct code.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

describe("parsePageParam", () => {
  it("reads a normal page", () => {
    expect(parsePageParam("3")).toBe(3);
    expect(parsePageParam("1")).toBe(1);
  });

  it("falls back to 1 for anything unusable", () => {
    // The value becomes an OFFSET in flipdesk_listing_page, so a negative or
    // non-numeric page is not cosmetic.
    for (const raw of [null, undefined, "", "   ", "abc", "0", "-4", "NaN", "1e9999"]) {
      expect(parsePageParam(raw), `raw ${JSON.stringify(raw)}`).toBeGreaterThanOrEqual(1);
    }
    expect(parsePageParam("-4")).toBe(1);
    expect(parsePageParam("0")).toBe(1);
    expect(parsePageParam("abc")).toBe(1);
  });

  it("takes the leading integer of a decimal rather than sending a fraction", () => {
    expect(parsePageParam("3.7")).toBe(3);
  });

  it("caps an absurd page instead of building an absurd offset", () => {
    expect(parsePageParam("99999999999")).toBe(100_000);
  });
});

describe("the page survives the round trip through an item", () => {
  it("the row click carries the full query string, page included", () => {
    // This is the mechanism the whole feature rides on: the page is in the URL
    // precisely so this existing line brings it back for free.
    expect(TABLE).toMatch(/state: \{ from: `\$\{location\.pathname\}\$\{location\.search\}` \}/);
  });

  it("the item page returns to state.from", () => {
    expect(ITEM).toMatch(/\(location\.state as \{ from\?: string \} \| null\)\?\.from/);
  });

  it("inventory reads its page from the URL, not useState", () => {
    expect(LISTINGS).toMatch(/const \[page, setPage\] = useUrlPageState\(\)/);
    expect(LISTINGS).not.toMatch(/const \[page, setPage\] = useState\(1\)/);
  });
});

describe("rows-per-page rides along, because the page number means nothing without it", () => {
  it("size lives in the URL too", () => {
    // Page 3 of 50-row pages is rows 100-150; page 3 of 100-row pages is rows
    // 200-300. Restoring the page without the size returns the seller to a
    // number that points somewhere else.
    expect(LISTINGS).toMatch(/useUrlParamState\("size"/);
    expect(LISTINGS).not.toMatch(/const \[pageSize, setPageSize\] = useState<number>\(100\)/);
  });

  it("only the three offered sizes are honoured", () => {
    // ?size= is seller-editable and becomes p_limit on flipdesk_listing_page,
    // so an unbounded value pulls the whole account in one request.
    const fn = LISTINGS.slice(
      LISTINGS.indexOf("function resolvePageSize"),
      LISTINGS.indexOf("function resolvePageSize") + 400,
    );
    expect(fn).toMatch(/PAGE_SIZE_OPTIONS as readonly number\[\]\)\.includes\(n\)/);
    expect(fn).toMatch(/: DEFAULT_PAGE_SIZE/);
  });
});

describe("the three things that would undo the restore", () => {
  // These pin the PROPERTY, not the spelling. The first version of this
  // block asserted the literal `if (tabMountedRef.current) { ... setPage(1)`,
  // which went red on the fix rather than on a regression: the page reset had
  // to STOP being a separate setPage call, because two setSearchParams writes
  // in one tick do not queue and the second overwrites the first. The
  // behavioural half lives in
  // src/pages/flipdesk/__tests__/inventory-page-restore.test.tsx.
  it("the tab effect resets the page only after the first run, in its own params write", () => {
    // On mount the tab is already whatever ?tab= said, so a reset here would
    // throw away the ?page= that arrived on the same URL.
    const start = LISTINGS.indexOf("const tabMountedRef");
    expect(start).toBeGreaterThan(-1);
    const effect = codeOnly(LISTINGS.slice(start, LISTINGS.indexOf("}, [tab]);", start)));
    // It can tell a mount from a real tab change...
    expect(effect).toMatch(/tabMountedRef\.current/);
    // ...and a real change drops the page, guarded rather than unconditional...
    expect(effect).toMatch(/if \(\w+\) next\.delete\("page"\);/);
    // ...in the SAME URLSearchParams it writes. A second navigation in the
    // same tick is not a second write, it is an overwrite of the first.
    expect(effect).not.toMatch(/setPage\(/);
  });

  it("the filter effect does the same, so the encoded filter is not written back stale", () => {
    const start = LISTINGS.indexOf("const filterMountedRef");
    expect(start).toBeGreaterThan(-1);
    const effect = codeOnly(LISTINGS.slice(start, LISTINGS.indexOf("}, [filterQuery]);", start)));
    expect(effect).toMatch(/filterMountedRef\.current/);
    expect(effect).toMatch(/if \(\w+\) next\.delete\("page"\);/);
    expect(effect).not.toMatch(/setPage\(/);
  });

  it("the criteria effect resets the page only after the first run", () => {
    const start = LISTINGS.indexOf("const criteriaMountedRef");
    expect(start).toBeGreaterThan(-1);
    const effect = LISTINGS.slice(start, LISTINGS.indexOf("setPage]);", start));
    expect(effect).toMatch(/if \(!criteriaMountedRef\.current\) \{/);
    expect(effect).toMatch(/criteriaMountedRef\.current = true;\s*\n\s*return;/);
    // And it must NOT own the two resets that now travel with their own params
    // write, or it re-introduces the overwrite from the other side.
    const deps = LISTINGS.slice(LISTINGS.indexOf("}, [search,", start), LISTINGS.indexOf("setPage]);", start));
    expect(deps).not.toMatch(/\bfilterQuery\b/);
    expect(deps).not.toMatch(/\btab\b/);
  });

  it("the sort request is memoized, or every render re-fires the reset", () => {
    // sortOptionsForTab builds fresh objects per call, so an unmemoized
    // `columnSort` never compares equal and the criteria effect fires on every
    // render. Harmless while setPage was useState (setting 1 over 1 does not
    // re-render); an infinite navigation loop once it writes the URL.
    expect(LISTINGS).toMatch(/useMemo\(\(\) => resolveSortOption\(sortParam, tab\), \[sortParam, tab\]\)/);
    expect(LISTINGS).toMatch(/useMemo\(\(\) => sortOptionsForTab\(tab\), \[tab\]\)/);
  });

  it("the clamp waits for the query to resolve", () => {
    // totalRows is `pageData?.total ?? 0`, so before the first fetch lands
    // totalPages is 1 and an ungated clamp rewrites ?page=3 to 1 while the
    // request for page 3 is still in flight.
    const start = LISTINGS.indexOf("if (page > totalPages) setPage(totalPages);");
    expect(start).toBeGreaterThan(-1);
    const effect = LISTINGS.slice(start - 200, start + 120);
    expect(effect).toMatch(/if \(!pageData\) return;/);
    // pageData must be a dep as well as a guard, or the clamp never re-runs
    // once the fetch lands and a genuinely out-of-range page stays out of range.
    expect(effect).toMatch(/\}, \[page, totalPages, pageData[,\]]/);
  });
});

describe("the grid pages the same way", () => {
  // The grid is the other paged view under /dashboard/flipdesk/inventory and it
  // shares the URL with the table, so leaving it on useState would mean a view
  // switch quietly moved the seller back to the top.
  it("reads its page from the URL", () => {
    expect(GRID).toMatch(/const \[page, setPage\] = useUrlPageState\(\)/);
    expect(GRID).not.toMatch(/const \[page, setPage\] = useState\(1\)/);
  });

  it("skips the reset on its first run", () => {
    expect(GRID).toMatch(/if \(!criteriaMountedRef\.current\) \{/);
  });

  it("waits for the query before clamping", () => {
    const start = GRID.indexOf("if (page > totalPages) setPage(totalPages);");
    expect(start).toBeGreaterThan(-1);
    expect(GRID.slice(start - 120, start + 120)).toMatch(/if \(!data\) return;/);
  });
});
