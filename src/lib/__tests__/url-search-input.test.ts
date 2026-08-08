// A URL-backed search box drops characters when the input is bound straight to
// the router param: `setSearchParams` is a navigation, not a synchronous state
// write, so typing faster than the round trip re-renders the controlled input
// with the PREVIOUS value and discards everything typed in between. Typing
// "Chiara Boni" into Inventory landed `?q=i`.
//
// The fix splits the value in two — a local draft for the box, the param for
// the query — and the failure mode of the fix is that someone re-merges them.
// Either direction is a silent regression: bind the input to the param and the
// characters drop again; bind the query to the draft and every keystroke hits
// the server. Neither throws, and neither is visible unless you type quickly.
//
// The hook's own behaviour is React-coupled (state + effect + refs) and this
// repo has no React test renderer, so what is asserted here is the WIRING, the
// way photo-manager-seams.test.ts and composer-dirty-guard.test.ts do.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const hook = read("src/hooks/use-url-param-state.ts");

// Every surface with a URL-backed search box. All three share `?q=` so the
// value carries across Inventory's view-mode switches (US-958) — which is also
// why all three had the same bug.
const PAGES = [
  "src/pages/flipdesk/listings.tsx",
  "src/pages/flipdesk/grid.tsx",
  "src/pages/flipdesk/pipeline.tsx",
];

describe("URL-backed search inputs", () => {
  for (const path of PAGES) {
    const src = read(path);

    it(`${path}: types into a local draft, not the URL param`, () => {
      expect(src).toContain("useUrlSearchInput(");
      // The raw param hook is what drops characters when a text input is bound
      // to it. It stays legitimate for selects (listings' `sort`), so this
      // asserts it is not used for `q` rather than banning it outright.
      expect(src).not.toMatch(/useUrlParamState\(\s*"q"/);
    });

    it(`${path}: binds the box to the draft`, () => {
      expect(src).toContain("value={searchDraft}");
      // The old binding, and the whole bug.
      expect(src).not.toContain("value={search}");
    });

    it(`${path}: keeps the settled value for everything downstream`, () => {
      // `search` stays the committed value, so queries and filters are not
      // re-run per keystroke. Renaming it to the draft is the other half of
      // the regression this file exists to catch.
      expect(src).toMatch(/value:\s*search,/);
      expect(src).toMatch(/draft:\s*searchDraft,/);
    });
  }

  it("stamps the pushed value BEFORE writing the param", () => {
    // The hook ignores param changes it caused itself. If the write landed
    // first, its own echo would read as an external change and reset the box
    // mid-word — the original bug, reintroduced through the fix.
    const commit = hook.slice(
      hook.indexOf("timerRef.current = setTimeout("),
      hook.indexOf("}, delayMs);"),
    );
    expect(commit.length).toBeGreaterThan(20);
    expect(commit.indexOf("pushedRef.current = next")).toBeGreaterThan(-1);
    expect(commit.indexOf("pushedRef.current = next")).toBeLessThan(
      commit.indexOf("setValue(next)"),
    );
  });

  it("still lets an external param change win", () => {
    // Back/forward, a saved view, and a tab switch that rewrites the query
    // string all have to reach the box. Only self-writes are ignored.
    expect(hook).toMatch(/if \(value === pushedRef\.current\) return;/);
    expect(hook).toContain("setDraft(value);");
  });

  it("cancels a pending commit on unmount", () => {
    // Otherwise a debounced write fires against a page that is gone.
    expect(hook).toMatch(/if \(timerRef\.current\) clearTimeout\(timerRef\.current\);/);
  });
});
