import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

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

// The rendered half of this lives in flipdesk-search-page.test.tsx (the page)
// and components/flipdesk/__tests__/palette-submission-search-outage.test.tsx
// (the palette): both mock supabase.rpc resolving { data: null, error } and
// assert the outage copy and the absence of "No matches". Those replaced the
// regexes that used to sit here, which pinned one spelling of the fix rather
// than the behaviour.

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "test") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe("a failed search says it failed (US-2517)", () => {
  it("no source file destructures only `data` from an awaited rpc", () => {
    // The exact shape that caused it, anywhere in src/: `const { data } =
    // await ...rpc(`. supabase-js resolves with { data: null, error }, so the
    // error is gone and an outage reads as an empty answer.
    const offenders = walk(resolve(process.cwd(), "src")).filter((f) =>
      /const \{ data \} = await [^;]*?\.rpc\(/s.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("neither search surface casts its way around the typed search call", () => {
    for (const rel of [SEARCH_PAGE, PALETTE]) {
      expect(read(rel), rel).not.toContain('"flipdesk_search"');
    }
    expect(read("src/lib/flipdesk-search-fetch.ts")).not.toMatch(
      /as unknown as[^;]*flipdesk_search/s,
    );
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
});

// ---------------------------------------------------------------------------
// US-2867 AC4. The story asked for `search-outage-not-empty` to cover the third
// case, and the reason it was worth asking for turned up while checking: three
// surfaces that had just been given a careful zero-data / zero-matches split
// still rendered the ZERO-DATA state when the fetch failed.
//
//   bulk-pricing.tsx        queryFn threw, `rows = []` fallback, so an outage
//                           told a seller with live listings "No active eBay
//                           listings" and offered to help them publish one.
//   autolister-drafts.tsx   same shape via `draftsRead?.rows ?? []`.
//   use-flipdesk-demand.ts  returned only { demand, isLoading }, so demand.tsx
//                           could not tell a quiet market from a 500.
//
// Two of the four US-2867 surfaces are NOT here on purpose: autolister.tsx and
// autolister-queue.tsx filter local component state (staged photo groups, and
// in-memory generation jobs), so there is no read to fail.
//
// The rule this pins is US-436's, applied to the branch ORDER: the error branch
// must be reachable before the empty branch, or the empty branch wins and the
// outage is disguised as an answer.

describe("the third case: a failed read is neither empty state (US-2867)", () => {
  const FETCHED_LISTS: Array<[file: string, errorIdent: string]> = [
    ["src/pages/flipdesk/bulk-pricing.tsx", "error"],
    ["src/pages/flipdesk/autolister-drafts.tsx", "draftsError"],
    ["src/pages/flipdesk/demand.tsx", "error"],
  ];

  for (const [rel, ident] of FETCHED_LISTS) {
    it(`${rel} renders the failure before the empty state`, () => {
      const src = read(rel);
      const errAt = src.indexOf("<ErrorState");
      const emptyAt = src.indexOf("<EmptyState");
      expect(errAt, `${rel} has no <ErrorState>; a failed fetch falls through ` +
        "to the empty state and reads as an answer").toBeGreaterThan(-1);
      expect(emptyAt).toBeGreaterThan(-1);
      expect(
        errAt,
        `${rel}: <EmptyState> is reachable before <ErrorState>, so the outage ` +
          "renders as 'you have none'",
      ).toBeLessThan(emptyAt);
      // And the CONDITION on the branch has to be the error, not merely a
      // binding somewhere above it. Searching the whole file above the tag
      // let a sabotage through: swapping the branch condition to a constant
      // false still passed, because the useQuery destructure that names the
      // variable sits higher up the file and satisfied the search.
      const condition = src.slice(Math.max(0, errAt - 160), errAt);
      expect(
        new RegExp(`\\b${ident}\\b`).test(condition),
        `${rel}: the branch that renders <ErrorState> is not conditioned on ` +
          `${ident}. Something else decides whether the failure is shown.`,
      ).toBe(true);
    });

    it(`${rel} gives the failure a retry`, () => {
      // An error state with no way to try again is a nicer-looking dead end.
      const src = read(rel);
      const at = src.indexOf("<ErrorState");
      const block = src.slice(at, at + 400);
      expect(block, rel).toMatch(/onRetry=\{/);
      expect(block, rel).toMatch(/refetch/);
    });
  }

  it("the demand hook hands the page its error", () => {
    // The page cannot branch on something the hook never returns, and this hook
    // returned exactly { demand, isLoading }.
    const src = read("src/hooks/use-flipdesk-demand.ts");
    expect(src).toMatch(/error: query\.error/);
    expect(src).toMatch(/refetch: query\.refetch/);
  });
});
