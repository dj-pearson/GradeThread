import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2517. The FlipDesk search page ran the flipdesk_search RPC, destructured
// only `data`, and rendered the "No matches" empty state when it came back
// null. supabase-js does not throw on a Postgres error — it RESOLVES with
// { data: null, error } — so the catch block almost never ran and a dead search
// index told the seller they own no matching inventory. The command palette
// dropped `error` from the same RPC in the same way.
//
// US-436 already settled the rule: a failed read renders <ErrorState>, never
// <EmptyState>. This pins it for both search surfaces.

const SEARCH_PAGE = "src/pages/flipdesk/search.tsx";
const PALETTE = "src/components/flipdesk/command-palette.tsx";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("a failed search says it failed (US-2517)", () => {
  it("the search page reads `error` off the RPC result", () => {
    const src = read(SEARCH_PAGE);
    expect(src).toMatch(/const \{ data, error \} = await \(/);
    expect(src).toMatch(/if \(error\) \{/);
  });

  it("the search page renders ErrorState with a retry, not an empty state", () => {
    const src = read(SEARCH_PAGE);
    expect(src).toContain("<ErrorState");
    expect(src).toMatch(/onRetry=\{\(\) => setRetryToken/);
    // The failure branch must come FIRST, or the empty state wins.
    const failedAt = src.indexOf("{failed && !loading ?");
    const emptyAt = src.indexOf('title="No matches"');
    expect(failedAt).toBeGreaterThan(-1);
    expect(failedAt).toBeLessThan(emptyAt);
  });

  it("the palette reads `error` too and warns the list is short", () => {
    const src = read(PALETTE);
    expect(src).toMatch(/const \{ data, error \} = await \(/);
    expect(src).toMatch(/setDeepFailed\(Boolean\(error\)\)/);
    expect(src).toContain("Search is unavailable right now.");
  });

  it("neither surface silently drops the RPC error any more", () => {
    // The exact shape that caused it: destructuring only `data` from an awaited
    // supabase.rpc cast. If it comes back, this fails.
    for (const rel of [SEARCH_PAGE, PALETTE]) {
      expect(read(rel), rel).not.toMatch(/const \{ data \} = await \(/);
    }
  });
});

describe("search parity with iOS GlobalSearchView (US-2517)", () => {
  it("recent searches are offered when the field is empty", () => {
    const src = read(SEARCH_PAGE);
    expect(src).toMatch(/fetchRecentSearches\(/);
    expect(src).toContain("Recent searches");
  });

  it("recents come from the shared helper, not a second copy of the RPC", () => {
    // The palette and the page must agree on the history they show.
    const helper = read("src/lib/recent-searches.ts");
    expect(helper).toContain("recent_searches");
    expect(helper).toContain("record_search");
    for (const rel of [SEARCH_PAGE, PALETTE]) {
      expect(read(rel), rel).toMatch(/from "@\/lib\/recent-searches"/);
      // No inline re-implementation of either RPC outside the helper.
      expect(read(rel), rel).not.toContain('"record_search"');
    }
  });

  it("the result list is keyboard-navigable, matching its return-key glyph", () => {
    const src = read(SEARCH_PAGE);
    expect(src).toContain('e.key === "ArrowDown"');
    expect(src).toContain('e.key === "ArrowUp"');
    expect(src).toContain('e.key === "Enter"');
    // Enter must open the row under the cursor.
    expect(src).toMatch(/const hit = results\[activeIdx\]/);
    expect(src).toMatch(/void navigate\(hit\.link\)/);
    // And the cursor has to be announced, not just painted.
    expect(src).toMatch(/aria-activedescendant/);
    expect(src).toMatch(/aria-selected=\{i === activeIdx\}/);
  });
});
