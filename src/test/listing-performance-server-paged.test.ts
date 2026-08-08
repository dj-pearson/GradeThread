// US-2233 AC3/AC4: Listing Performance reads ONE page from the database.
//
// The page used to fetch every active eBay listing (fetchAllPages), then a
// second chunked query for titles, then filter/sort/slice in JavaScript. That
// was bounded — US-2169 saw to that — but it pulled a whole catalog into the
// browser to render fifty rows, and its search was WRONG: it matched
// listing_title only, so any listing whose displayed title came from the
// inventory item was invisible to search.
//
// Migration 00560 moved all of it into SQL. This guard exists because the old
// shape is the easy shape: `fetchAllPages` is one import away, and a reviewer
// looking at a diff that adds it sees a bounded read, which is the thing this
// codebase normally asks for. Here it would be a regression.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/pages/flipdesk/listing-performance.tsx";
const MIGRATION = "supabase/migrations/00560_listing_performance_rpcs.sql";

/** Source with comments stripped — a comment must never satisfy an assertion. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("US-2233: Listing Performance is server-paged", () => {
  it("calls both RPCs and no longer reads the listings table directly", () => {
    const src = code(PAGE);
    expect(src).toMatch(/supabase\.rpc\(\s*"flipdesk_listing_performance_page"/);
    expect(src).toContain('"flipdesk_listing_performance_summary"');
    // The whole-catalog read and the chunked titles query are the two things
    // that must not come back.
    expect(src).not.toContain("fetchAllPages");
    expect(src).not.toMatch(/\.from\(\s*"listings"\s*\)/);
    expect(src).not.toMatch(/\.from\(\s*"inventory_items"\s*\)/);
  });

  it("the query key carries every input that changes the result", () => {
    // Server paging with a key that omits an input serves the previous page's
    // cache for the next page. It looks like "paging is broken" and it is
    // really "the key is wrong", which is a much harder thing to find.
    const src = code(PAGE);
    const at = src.search(/queryKey: \[\s*"listing_performance",/);
    expect(at, "could not find the query key — this check would prove nothing").toBeGreaterThan(-1);
    const firstKey = src.slice(at, src.indexOf("]", at));
    for (const input of ["search", "noViewDays", "sortKey", "sortDir", "page"]) {
      expect(firstKey, `queryKey is missing ${input}`).toContain(input);
    }
  });

  it("changing search, filter or sort resets to page 1", () => {
    // Without this a seller deep in the pager who narrows the search lands on
    // an empty page and reads it as "no results".
    const src = code(PAGE);
    expect(src).toMatch(
      /useEffect\(\s*\(\)\s*=>\s*\{\s*setPage\(0\);\s*\},\s*\[search, noViewDays, sortKey, sortDir\]\)/,
    );
  });

  it("days_listed inverts the sort direction it sends", () => {
    // `days_listed` is derived: more days listed means an OLDER listed_at. Send
    // the direction through unchanged and the one sort a seller uses to find
    // stale stock silently runs backwards — a wrong answer that still looks
    // like a sorted table.
    const src = code(PAGE);
    expect(src).toContain('p_sort: sortKey === "days_listed" ? "listed_at" : sortKey');
    expect(src).toMatch(
      /p_desc: sortKey === "days_listed"\s*\?\s*sortDir === "asc"\s*:\s*sortDir === "desc"/,
    );
  });

  it("counts come from the server total, never from the rendered page", () => {
    // `pageRows.length` caps at PAGE_SIZE, so any count taken from it reads
    // "50" forever on a catalog bigger than one page.
    const src = code(PAGE);
    expect(src).not.toMatch(/\{pageRows\.length\}/);
    expect(src).toContain("Math.ceil(total / PAGE_SIZE)");
  });

  it("the stale 'first 1,000' notice is gone", () => {
    // It was true under `.limit(1000)` and survived the change to fetchAllPages,
    // so every seller with 1000+ listings was told their report was cut short
    // and pointed at a workaround for a problem that no longer existed.
    const raw = readFileSync(PAGE, "utf8");
    expect(raw).not.toContain("Showing the first 1,000 active listings");
    expect(code(PAGE)).not.toContain("truncated");
  });

  it("the migration keeps both functions SECURITY INVOKER and closed to anon", () => {
    // These read multi-tenant tables. SECURITY INVOKER is what makes RLS scope
    // them; SECURITY DEFINER would need a tenant filter inside, and the whole
    // point is not to have one to forget (US-268, US-2282).
    const sql = readFileSync(MIGRATION, "utf8");
    const sqlCode = sql.replace(/^\s*--.*$/gm, "");
    expect(sqlCode).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.flipdesk_listing_performance_summary\(\) FROM PUBLIC, anon;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.flipdesk_listing_performance_page\([^)]*\) TO authenticated, service_role;/);
    // Re-runnable: the summary changed return type during development, and
    // CREATE OR REPLACE cannot do that.
    expect(sql).toContain("DROP FUNCTION IF EXISTS public.flipdesk_listing_performance_summary();");
    expect(sql).toContain("insert into public.applied_migrations (version) values ('00560')");
  });
});
