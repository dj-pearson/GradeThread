import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// US-2850 AC4: a comp read is not a grade, and a listing is not a sale.
//
// WHY THIS IS A TEST AND NOT A STYLE NOTE. Both errors had already shipped and
// both read as perfectly ordinary product copy:
//
//   /grade-checker  "from 12 recent comparable sales"      -> active listings
//   /condition-index "Medians are drawn from completed
//                     sales of graded items."              -> neither
//   /condition-index table header "Sales"                  -> listings
//
// Nothing about those sentences looks wrong. They only look wrong if you know
// EBAY_MARKETPLACE_INSIGHTS has never been granted, which is exactly the sort
// of fact that copy edits are made without.
//
// TWO CLAIMS ARE BANNED, and they are different claims:
//
//   "sold"  overstates the DATA. Asking prices are the right number for a
//           sourcing ceiling and the wrong one for how fast a thing sells.
//   "grade" about a comp overstates the CLAIM. We read other people's listings
//           for condition; we do not grade them. A grade is a certificate with
//           a number a buyer can look up, and it is what customers pay us for.
//
// SCOPE. Only surfaces that render a condition-adjusted value from the comp
// pipeline. The sold-comps engine (getRealizedComps) genuinely does use
// realized sales, and its copy is allowed to say so.

const ROOT = process.cwd();

// Files that render or describe a comp-derived value. Kept explicit rather than
// globbed: a wide scan would sweep in the realized-sales surfaces, where "sold"
// is true, and a test that has to be argued with gets disabled.
const SCANNED = [
  "src/pages/marketing/condition-index.tsx",
  "src/pages/marketing/whats-it-worth.tsx",
  "src/pages/tools/grade-checker.tsx",
  "src/pages/flipdesk/scout.tsx",
  "src/pages/flipdesk/scout-buy.tsx",
  "src/components/value/value-basis-note.tsx",
  "src/components/flipdesk/condition-index-value-hint.tsx",
  "src/lib/seo/grade-checker.ts",
  "functions/condition-index/[[path]].ts",
  "functions/_shared/condition-index-render.ts",
];

// Each rule is (pattern, what it would be claiming). Case-insensitive.
const BANNED: Array<{ re: RegExp; claim: string }> = [
  { re: /\bgraded (listing|comp|item|sale)s?\b/i, claim: "calls a comp read a grade" },
  { re: /\bcomps? we graded\b/i, claim: "calls a comp read a grade" },
  { re: /\blistings? we graded\b/i, claim: "calls a comp read a grade" },
  { re: /\bgrades? of other (listing|seller)s/i, claim: "calls a comp read a grade" },
  { re: /\bcomparable sales\b/i, claim: "calls an active listing a sale" },
  { re: /\bcompleted sales\b/i, claim: "calls an active listing a sale" },
  { re: /\brecent sales\b/i, claim: "calls an active listing a sale" },
  { re: /\bsold comps\b/i, claim: "calls an active listing a sale" },
];

/**
 * Strip comments before scanning, keeping line numbers intact.
 *
 * COMMENTS ARE NOT USER-FACING, and the fixes in these very files quote the old
 * wrong sentences on purpose so the next reader knows why the new ones are
 * worded as they are. Scanning those would make the guard fire on its own
 * evidence, and a guard that flags the explanation for the bug is a guard
 * somebody deletes.
 *
 * Blank-fills rather than deletes, so an offence reports the line it is on.
 * The `//` rule skips a match preceded by a colon, so an https:// URL does not
 * swallow the rest of its line.
 */
function stripComments(src: string): string[] {
  const blockless = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return blockless.split("\n").map((line) => {
    const i = line.search(/(^|[^:])\/\//);
    return i === -1 ? line : line.slice(0, i);
  });
}

function read(rel: string): string[] {
  return stripComments(readFileSync(join(ROOT, rel), "utf8"));
}

describe("US-2850: comp-derived value copy", () => {
  it("never calls a comp read a grade, and never calls a listing a sale", () => {
    const offences: string[] = [];
    for (const rel of SCANNED) {
      read(rel).forEach((line, i) => {
        for (const { re, claim } of BANNED) {
          if (re.test(line)) {
            offences.push(`${rel}:${i + 1} ${claim}: ${line.trim().slice(0, 120)}`);
          }
        }
      });
    }
    expect(offences).toEqual([]);
  });

  it("scans files that still exist", () => {
    // A renamed file would silently drop out of the scan above and the suite
    // would stay green while the guard covered nothing.
    for (const rel of SCANNED) {
      expect(statSync(join(ROOT, rel)).isFile(), `${rel} is not a file`).toBe(true);
    }
  });

  it("the banned patterns actually fire", () => {
    // A guard nobody has seen fail is a guard nobody knows is wired up.
    const samples = [
      "from 12 recent comparable sales",
      "Medians are drawn from completed sales of graded items.",
      "based on sold comps",
    ];
    for (const s of samples) {
      expect(BANNED.some((b) => b.re.test(s)), `nothing caught: ${s}`).toBe(true);
    }
  });
});

describe("US-2850: every comp-value surface renders the basis", () => {
  it("each value surface imports the shared note", () => {
    // The wording lives in ONE place on the edge. A surface that shows a
    // condition-adjusted value and does not render ValueBasisNote is a surface
    // showing a price with no provenance, which is the whole story.
    const mustRender = [
      "src/pages/marketing/condition-index.tsx",
      "src/pages/marketing/whats-it-worth.tsx",
      "src/pages/tools/grade-checker.tsx",
      "src/pages/flipdesk/scout.tsx",
      "src/pages/flipdesk/scout-buy.tsx",
      "src/components/flipdesk/condition-index-value-hint.tsx",
      "src/components/flipdesk/sold-comp-recommendation.tsx",
    ];
    for (const rel of mustRender) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      expect(src, `${rel} does not render ValueBasisNote`).toContain("<ValueBasisNote");
    }
  });

  it("the SSR twin renders the same disclosure the SPA does", () => {
    // /condition-index has two renderers. If only one says what the numbers
    // are, a crawler and a human get different claims about one curve.
    const ssr = readFileSync(join(ROOT, "functions/_shared/condition-index-render.ts"), "utf8");
    expect(ssr).toContain("curve.disclosure");
    const spa = readFileSync(join(ROOT, "src/pages/marketing/condition-index.tsx"), "utf8");
    expect(spa).toContain("curve.disclosure");
  });
});

// Keeps the unused import honest if the list above ever shrinks to nothing.
void readdirSync;
void relative;
void resolve;
