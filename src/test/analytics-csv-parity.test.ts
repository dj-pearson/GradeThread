import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2829 AC1/AC6: every analytics view a seller can look at, they can also take
// away.
//
// "My data is mine and not trapped in a chart" is the story's own framing, and
// the gap was six views wide: the analytics page mounts twelve lazy modules and
// only three of them offered a CSV.
//
// ── WHY THERE IS NO ALLOWLIST HERE ────────────────────────────────────────────
//
// The obvious shape is a list of views that need an export and a list of
// exemptions, and both rot. This repo has the scars: a hand-written allowlist is
// the easiest thing to widen when a guard complains (see
// vault/70-agent/guards-that-cannot-fail.md shape 16), and a hand-listed set of
// views stops growing the day someone adds a thirteenth (shape 3).
//
// The rule derives instead, from a split that is already clean in the source:
//
//   OWNS ITS DATA    calls useQuery, so it fetched rows nobody else has.
//                    Measured: the six report sections and price-curve-report
//                    have 2-4 useQuery calls each.
//   RENDERS SOMEONE  takes data as props and fetches nothing. Measured:
//   ELSE'S DATA      analytics-bar-chart, analytics-trend-chart and
//                    sell-through-chart have ZERO. Their parent owns the rows
//                    and the parent's export covers them.
//
// So: a view that fetches its own data must let the seller export it. No list to
// maintain, and a new report is covered the moment it is mounted.

const ROOT = process.cwd();
const PAGE = "src/pages/flipdesk/analytics.tsx";

const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8").replace(/\r\n?/g, "\n");

/** Every module the analytics page lazy-mounts, as a repo-relative path. */
function mountedViews(): string[] {
  const src = read(PAGE);
  const specs = [...src.matchAll(/lazy\(\s*\(\)\s*=>\s*\n?\s*import\("(@\/[^"]+)"/g)].map(
    (m) => m[1]!,
  );
  return [...new Set(specs)].map((s) => s.replace(/^@\//, "src/")).sort();
}

function resolveFile(rel: string): string | null {
  for (const ext of [".tsx", ".ts"]) {
    if (existsSync(resolve(ROOT, rel + ext))) return rel + ext;
  }
  return null;
}

const ownsData = (src: string) => /\buseQuery\s*[(<]/.test(src);
const exportsCsv = (src: string) => /\bdownloadCsv\s*\(/.test(src);

describe("US-2829: a seller can take away every analytics view they can see", () => {
  const views = mountedViews();

  it("the page's mounted views parsed", () => {
    // Guards the guard. Every assertion below is vacuous against an empty list,
    // and the lazy-import regex is exactly the kind of thing that silently stops
    // matching when someone reformats the file.
    expect(views.length, "no lazy-mounted views parsed from the analytics page").toBeGreaterThan(8);
    expect(views, "the price curve is no longer mounted").toContain(
      "src/components/flipdesk/price-curve-report",
    );
    for (const v of views) {
      expect(resolveFile(v), `${v} does not resolve to a file`).not.toBeNull();
    }
  });

  it("the owns-data split is real, not assumed", () => {
    // The rule rests on this being a genuine split rather than a coincidence. If
    // every mounted module started fetching, the exemption would silently cover
    // nothing; if none did, the requirement would.
    const withData: string[] = [];
    const without: string[] = [];
    for (const v of views) {
      const src = read(resolveFile(v)!);
      (ownsData(src) ? withData : without).push(v);
    }
    expect(withData.length, "no mounted view fetches its own data").toBeGreaterThan(3);
    expect(
      without.length,
      "every mounted view now fetches its own data, so the presentational " +
        "exemption covers nothing. Re-read the rule before trusting it.",
    ).toBeGreaterThan(0);
  });

  it("every view that fetches its own data offers a CSV", () => {
    const missing = views.filter((v) => {
      const src = read(resolveFile(v)!);
      return ownsData(src) && !exportsCsv(src);
    });
    expect(
      missing,
      "an analytics view fetches rows the seller cannot export. Either add a " +
        "downloadCsv handler with headers matching the on-screen column labels " +
        "(AC6), or — if it genuinely renders someone else's data — take the " +
        "useQuery out and let its parent own the fetch.",
    ).toEqual([]);
  });

  it("a presentational view is not required to export", () => {
    // The other direction, so the rule is a coupling rather than a blanket
    // demand. A chart that takes rows as props has nothing of its own to give.
    const chartsExporting = views.filter((v) => {
      const src = read(resolveFile(v)!);
      return !ownsData(src) && exportsCsv(src);
    });
    expect(
      chartsExporting,
      "a presentational view exports a CSV of data it does not own. That is not " +
        "wrong, but it means the owns-data split no longer describes this page, " +
        "and the rule above is weaker than it reads.",
    ).toEqual([]);
  });
});
