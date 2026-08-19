import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lastModifiedFor } from "@/lib/seo/public-routes";

// Two drifts that had already happened by the time this was written, both
// silent, both from the same cause: a legal page is edited and the things that
// MIRROR it are somewhere else.
//
//  1. privacy.tsx gained section 5 (the Claude connector, US-9127 AC4) on
//     2026-08-19 while still rendering an effective date of August 7 -- and the
//     policy's own changes clause promises that date moves on a material change.
//     Meanwhile ROUTE_LAST_MODIFIED still said 2026-06-12 for /privacy and
//     2026-04-01 for /subprocessors, so the sitemap advertised <lastmod> values
//     months older than the documents.
//  2. Inserting that section renumbered everything after it, and the AUP's
//     "Data handling for the extension is described in Section 6 of our Privacy
//     Policy" quietly started pointing at "Public grade certificates". The three
//     cross-references INSIDE privacy.tsx were fixed; the one from another page
//     was not visible from there.
//
// Both are the kind of wrong a reader trusts, so neither should depend on
// remembering.

const LEGAL_DIR = "src/pages/legal";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

function legalPages(): string[] {
  return readdirSync(resolve(process.cwd(), LEGAL_DIR))
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => `${LEGAL_DIR}/${f}`);
}

/** "August 19, 2026" -> "2026-08-19". Throws rather than guessing. */
function toIso(human: string): string {
  const m = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(human);
  if (!m) throw new Error(`unparseable effective date: ${human}`);
  const month = MONTHS.indexOf(m[1]!);
  if (month < 0) throw new Error(`unknown month: ${m[1]}`);
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

interface LegalPage {
  file: string;
  canonicalPath: string;
  effectiveDate: string;
}

function pagesWithDates(): LegalPage[] {
  const out: LegalPage[] = [];
  for (const file of legalPages()) {
    const src = read(file);
    const date = /effectiveDate="([^"]+)"/.exec(src)?.[1];
    const path = /canonicalPath="([^"]+)"/.exec(src)?.[1];
    if (!date || !path) continue; // tests and helpers live here too
    out.push({ file, canonicalPath: path, effectiveDate: date });
  }
  return out;
}

describe("a legal page's effective date is the date the sitemap advertises", () => {
  it("finds every legal page, so this cannot pass by finding none", () => {
    expect(pagesWithDates().length).toBeGreaterThanOrEqual(11);
  });

  it.each(pagesWithDates())(
    "$canonicalPath renders $effectiveDate and ROUTE_LAST_MODIFIED agrees",
    ({ canonicalPath, effectiveDate, file }) => {
      expect(
        lastModifiedFor(canonicalPath),
        `${file} renders "${effectiveDate}" but the sitemap's <lastmod> for ` +
          `${canonicalPath} says ${lastModifiedFor(canonicalPath)}. Update ` +
          "ROUTE_LAST_MODIFIED in src/lib/seo/public-routes.ts in the same commit.",
      ).toBe(toIso(effectiveDate));
    },
  );
});

describe("a cross-page 'Section N' reference resolves to the section it names", () => {
  /** The numbered <h2> headings of a legal page, by their rendered number. */
  function headings(file: string): Map<number, string> {
    const out = new Map<number, string>();
    for (const m of read(file).matchAll(/<h2 id="[a-z-]+">(\d+)\.\s*([^<]+)<\/h2>/g)) {
      out.set(Number(m[1]), m[2]!.trim());
    }
    return out;
  }

  it("privacy.tsx and terms.tsx number their sections contiguously from 1", () => {
    for (const file of [`${LEGAL_DIR}/privacy.tsx`, `${LEGAL_DIR}/terms.tsx`]) {
      const nums = [...headings(file).keys()].sort((a, b) => a - b);
      expect(nums.length, `${file} has no numbered headings`).toBeGreaterThan(5);
      expect(nums, `${file} skips or repeats a section number`).toEqual(
        nums.map((_, i) => i + 1),
      );
    }
  });

  // "... described in Section 7 of our <Link to="/privacy">Privacy Policy</Link>"
  const CROSS_REF =
    /Section (\d+) of\s+(?:our|the)\s+<Link to="\/(privacy|terms|acceptable-use)">/g;

  it("every cross-page reference points at a section that exists", () => {
    const target: Record<string, string> = {
      privacy: `${LEGAL_DIR}/privacy.tsx`,
      terms: `${LEGAL_DIR}/terms.tsx`,
      "acceptable-use": `${LEGAL_DIR}/acceptable-use.tsx`,
    };
    let checked = 0;
    for (const file of legalPages()) {
      // Collapse JSX line wrapping so a reference split across lines still matches.
      const src = read(file).replace(/\s+/g, " ");
      for (const m of src.matchAll(CROSS_REF)) {
        const n = Number(m[1]);
        const heads = headings(target[m[2]!]!);
        expect(
          heads.has(n),
          `${file} points at Section ${n} of /${m[2]} which has only ` +
            `${heads.size} sections`,
        ).toBe(true);
        checked++;
      }
    }
    // The AUP -> privacy extension reference is the one that broke. If the
    // pattern stops matching anything, this guard has gone quiet, not clean.
    expect(checked, "no cross-page section references matched at all").toBeGreaterThan(0);
  });

  it("the AUP points at the privacy section that actually covers the extension", () => {
    const src = read(`${LEGAL_DIR}/acceptable-use.tsx`).replace(/\s+/g, " ");
    const n = Number(
      /Data handling for the extension is described in Section (\d+)/.exec(src)?.[1],
    );
    expect(n, "the AUP no longer cross-references the privacy policy").toBeTruthy();
    expect(
      headings(`${LEGAL_DIR}/privacy.tsx`).get(n),
      "the AUP's extension reference does not land on the extension section",
    ).toMatch(/extension/i);
  });
});
