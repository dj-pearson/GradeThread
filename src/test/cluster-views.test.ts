import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PUBLIC_ROUTES } from "@/lib/seo/public-routes";

// US-9016. The measurement note documents a Search Console regex per cluster.
// Those regexes are hand-typed into GSC and nothing in the codebase has ever
// checked they match a real path.
//
// The failure mode is not theoretical and it happened this week: US-9012 moved
// the flaw library from /grading/flaws to /care. A saved view built on the old
// regex keeps working, reads zero, and looks exactly like the cluster
// collapsing. Someone would then prune a cluster that was fine.
//
// So: every documented regex must match at least one registered route, and the
// thresholds must name a date.

const NOTE = readFileSync(
  resolve(process.cwd(), "vault/40-growth/seo-distribution-and-measurement.md"),
  "utf8",
);

/**
 * The page-path regexes in the cluster-views table.
 *
 * Line-based rather than sliced on a blank line. A slice boundary is one
 * markdown edit away from silently dropping the last row, and the test then
 * passes while checking one fewer cluster than it claims to. That is exactly
 * what it did on the first attempt: it read 8 of 9 rows and reported the table
 * as short rather than reporting the extractor as broken.
 */
function documentedRegexes(): string[] {
  const lines = NOTE.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith("| Cluster | Page-path regex"));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("|")) break;
    const m = line.match(/`(\^[^`]+)`/);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

describe("every documented cluster regex matches a real route (US-9016)", () => {
  const regexes = documentedRegexes();

  it("finds the table", () => {
    expect(regexes.length).toBeGreaterThanOrEqual(9);
  });

  /**
   * Clusters whose URLs are NOT in PUBLIC_ROUTES, with the reason.
   *
   * A named list rather than a loosened assertion: the point of this test is
   * that an unmatched regex is a broken saved view, and the only way to keep
   * that meaning is to say out loud which ones are legitimately unmatched.
   */
  const DYNAMIC_SURFACES: Record<string, string> = {
    "^/(cert|c)/":
      "Certificates are per-submission URLs served by an edge Pages Function " +
      "and entered into the sitemap by the edge API, so they are deliberately " +
      "absent from the static registry. The cluster view is still valid.",
  };

  it("matches at least one registered public route each", () => {
    const paths = PUBLIC_ROUTES.map((r) => r.path);
    const dead: string[] = [];
    for (const source of regexes) {
      // GSC uses RE2; the alternation in the note is markdown-escaped.
      const unescaped = source.split("\\|").join("|");
      if (unescaped in DYNAMIC_SURFACES) continue;
      const re = new RegExp(unescaped);
      if (!paths.some((p) => re.test(p))) dead.push(source);
    }
    expect(
      dead,
      "these cluster regexes match no registered route, so their saved view " +
        "reads zero and looks like a collapse:\n  " +
        dead.join("\n  "),
    ).toEqual([]);
  });

  it("watches the three clusters this rebuild shipped", () => {
    expect(regexes).toContain("^/tools/");
    expect(regexes).toContain("^/care/");
    expect(regexes).toContain("^/care/[^/]+/[^/]+$");
  });

  it("no longer points at the flaw library's old home", () => {
    // The move that motivated this whole test. Scoped to the TABLE rather than
    // the whole note: the prose under it deliberately names the old path to
    // explain why the row changed, and asserting on the note caught that
    // sentence instead of a stale regex.
    expect(regexes.some((r) => r.includes("/grading/flaws"))).toBe(false);
  });
});

describe("the thresholds are falsifiable (US-9016)", () => {
  it("records the July 2026 grading criterion as FIRED", () => {
    // A kill criterion that gets deleted when it fires is not a kill criterion.
    expect(NOTE).toMatch(/FIRED/);
  });

  it("gives every threshold a due date, not just a month number", () => {
    // "month 4" is unfalsifiable without a start date. These are real dates.
    for (const due of ["2026-12-18", "2027-02-18"]) {
      expect(NOTE, due).toContain(due);
    }
  });

  it("states the depth test as a ratio with a floor", () => {
    expect(NOTE).toMatch(/55% of a path's submitted terms/);
    expect(NOTE).toMatch(/minimum of 12 terms/);
  });

  it("judges the FlipDesk landings on conversion, not impressions", () => {
    expect(NOTE).toMatch(/not judged on impressions/);
    expect(NOTE).toContain("signup_started_from_tool");
  });

  it("schedules the quarterly re-pull with dates", () => {
    for (const d of ["2026-11-18", "2027-05-18"]) {
      expect(NOTE, d).toContain(d);
    }
  });
});
