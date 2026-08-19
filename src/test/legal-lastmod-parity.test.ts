// A legal page carries its date twice: the `effectiveDate` a reader sees, and
// the ROUTE_LAST_MODIFIED entry a crawler sees in the sitemap. The comment above
// those entries has always said to keep them in sync, and nothing checked it.
//
// Both had drifted by the time this was written. /privacy was updated on
// August 7 and its sitemap entry still said June 12; /subprocessors was updated
// on August 14 against a sitemap entry of April 1. The failure mode is quiet in
// the worst way: the page that changed is the page a crawler is told did not,
// and the subprocessor list is exactly the page people watch for changes.
//
// The mapping is DERIVED from each page's own canonicalPath rather than typed
// here, so a new legal page is covered the day it is added instead of the day
// somebody remembers to add it.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { lastModifiedFor } from "@/lib/seo/public-routes";

const LEGAL_DIR = resolve(process.cwd(), "src/pages/legal");

interface LegalPage {
  file: string;
  path: string;
  effective: string;
}

function legalPages(): LegalPage[] {
  return readdirSync(LEGAL_DIR)
    .filter((f) => f.endsWith(".tsx"))
    .flatMap((file) => {
      const src = readFileSync(join(LEGAL_DIR, file), "utf8");
      const path = /canonicalPath="([^"]+)"/.exec(src)?.[1];
      const effective = /effectiveDate="([^"]+)"/.exec(src)?.[1];
      return path && effective ? [{ file, path, effective }] : [];
    });
}

/** "August 19, 2026" -> "2026-08-19". UTC so a local timezone cannot shift it. */
function toIso(effective: string): string {
  const parsed = new Date(`${effective} UTC`);
  expect(Number.isNaN(parsed.getTime()), `unparseable effectiveDate: ${effective}`).toBe(false);
  return parsed.toISOString().slice(0, 10);
}

describe("legal pages: the date a reader sees and the date a crawler sees", () => {
  it("finds the legal pages at all", () => {
    // The scan is the whole test. A glob that quietly matches nothing turns
    // every assertion below into a tautology.
    const pages = legalPages();
    expect(pages.length).toBeGreaterThanOrEqual(10);
    expect(pages.map((p) => p.path)).toContain("/privacy");
    expect(pages.map((p) => p.path)).toContain("/terms");
  });

  it("every page's sitemap lastmod matches its rendered effective date", () => {
    const drifted = legalPages()
      .filter((p) => lastModifiedFor(p.path) !== toIso(p.effective))
      .map(
        (p) =>
          `${p.path} (${p.file}): page says ${p.effective} (${toIso(p.effective)}), ` +
          `ROUTE_LAST_MODIFIED says ${lastModifiedFor(p.path)}`,
      );
    expect(drifted, drifted.join("\n")).toEqual([]);
  });

  it("every legal page declares both dates", () => {
    // A page missing either prop drops out of legalPages() silently, which
    // would let it drift with the guard still green.
    const files = readdirSync(LEGAL_DIR).filter((f) => f.endsWith(".tsx"));
    const covered = new Set(legalPages().map((p) => p.file));
    expect(files.filter((f) => !covered.has(f))).toEqual([]);
  });
});
