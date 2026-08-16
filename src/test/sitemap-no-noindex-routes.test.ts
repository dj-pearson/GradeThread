// US-2636: we never submit a page that tells crawlers not to index it.
//
// FOUND BY PROBING THE LIVE SITEMAP, not by reading code. Sampling every path
// family in https://gradethread.com/sitemap.xml turned up one contradiction:
// /state-of-durability returns 200 with `<meta name="robots" content="noindex,
// follow">` while the sitemap advertises it at priority 0.8, changefreq weekly.
//
// Both halves are individually correct. The durability report has
// `sufficient_cohorts: 0` against a floor of 8, so the page refuses to be
// indexed — US-2098 decided that inviting citation of a finding we do not have
// is worse than having no report page. And the sitemap is built from the static
// route registry, which knows nothing about runtime data. Nothing reconciled
// them, so we asked Google to crawl the page weekly and then told Google to drop
// it. In Search Console that surfaces as "Submitted URL marked 'noindex'", which
// reads to whoever opens that report as a bug in the page.
//
// `report-thresholds.ts` already says the citation-block and indexing decisions
// "must not diverge". The sitemap is the third decision in that set, and it did.
//
// WHY A SOURCE SWEEP RATHER THAN A CASE FOR THIS ONE ROUTE. Pinning
// /state-of-durability only stops /state-of-durability. The failure is that a
// page can start deciding its own indexability and the sitemap keeps advertising
// it unconditionally, which is silent in both directions.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const SITEMAP = "functions/_shared/sitemap.ts";
const REGISTRY = "src/lib/seo/public-routes.ts";
const ENTRY_SERVER = "src/prerender/entry-server.tsx";

const read = (p: string) => readFileSync(join(REPO, p), "utf8");

/** Component names that render a conditional `noindex={...}`. */
function conditionallyNoindexComponents(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!e.name.endsWith(".tsx")) continue;
      const src = readFileSync(join(REPO, rel), "utf8");
      // `noindex={someExpression}` — a literal `noindex` or `noindex={false}`
      // is an unconditional decision and not this hazard.
      if (!/noindex=\{(?!false\})/.test(src)) continue;
      for (const m of src.matchAll(/export function (\w+)\s*\(/g)) out.set(m[1]!, rel);
    }
  };
  walk("src/pages");
  return out;
}

/** Registry paths whose prerendered component is one of those. */
function conditionalRegistryPaths(): Array<{ path: string; component: string; file: string }> {
  const components = conditionallyNoindexComponents();
  const entry = read(ENTRY_SERVER);
  const registry = read(REGISTRY);
  const out: Array<{ path: string; component: string; file: string }> = [];
  // entry-server maps "/path": <ComponentName />
  for (const m of entry.matchAll(/"(\/[^"]*)":\s*<(\w+)\s*\/>/g)) {
    const [, path, component] = m;
    if (!components.has(component!)) continue;
    // Only registry routes reach the static half of the sitemap.
    if (!registry.includes(`"${path}"`)) continue;
    out.push({ path: path!, component: component!, file: components.get(component!)! });
  }
  return out;
}

/** Paths the sitemap treats as conditional. */
function handledBySitemap(): Set<string> {
  const src = read(SITEMAP);
  const start = src.indexOf("const CONDITIONALLY_INDEXED");
  expect(start, "CONDITIONALLY_INDEXED was renamed or removed").toBeGreaterThan(-1);
  const block = src.slice(start, src.indexOf("\n};", start));
  return new Set([...block.matchAll(/"(\/[^"]+)":/g)].map((m) => m[1]!));
}

describe("US-2636: the sitemap never advertises a page that may noindex itself", () => {
  it("every conditionally-indexed registry route is handled by the sitemap", () => {
    const handled = handledBySitemap();
    const unhandled = conditionalRegistryPaths().filter((r) => !handled.has(r.path));
    expect(
      unhandled.map((r) => `${r.path} (${r.component} in ${r.file})`),
      "this page decides at render time whether to be indexed, and the sitemap " +
        "advertises it unconditionally. Add it to CONDITIONALLY_INDEXED in " +
        `${SITEMAP} with the same question the page asks.`,
    ).toEqual([]);
  });

  it("the sitemap asks the page's question, not a restated copy of it", () => {
    // Two copies of the threshold is how the citation block and the noindex
    // would drift apart, which report-thresholds.ts exists to prevent. The
    // number must be imported, never written here.
    const src = read(SITEMAP);
    expect(src).toMatch(/from "\.\.\/\.\.\/src\/lib\/report-thresholds"/);
    expect(src).toMatch(/isPublishableReport\(/);
    expect(
      /sufficient_cohorts.*>=\s*\d|MIN_DURABILITY_COHORTS\s*=/.test(src),
      "the sitemap restates the threshold instead of importing it",
    ).toBe(false);
  });

  it("an unreachable upstream omits the URL rather than advertising it", () => {
    // Matching the page: it reads the same data through a prerender seed and
    // treats an absent seed as not-publishable. A catch that returned true
    // would advertise a noindex page on every transient blip.
    const src = read(SITEMAP);
    const fn = src.slice(src.indexOf("async function indexableConditionalPaths"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toMatch(/catch\s*\{\s*return false;/);
  });

  it("guard-the-guard: the sweep still finds the page it was built for", () => {
    // Every assertion above passes vacuously if the component scan stops
    // matching. /state-of-durability is the known instance; if it stops being
    // conditionally indexed, delete this case deliberately.
    const found = conditionalRegistryPaths().map((r) => r.path);
    expect(found, "the conditional-noindex scan found nothing").toContain(
      "/state-of-durability",
    );
  });
});
