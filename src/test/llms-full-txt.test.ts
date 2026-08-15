// US-2106 AC4: guard /llms-full.txt, mirroring llms-txt.test.ts.
//
// This file is the single artifact an answer engine can fetch to get the WHOLE
// grading standard instead of crawling 40+ pages. Two things therefore have to
// stay true, and neither is visible by reading the renderer:
//
//   1. It is DERIVED. If a glossary term, flaw or tier is added to the
//      constants and silently missing here, the standard we hand to answer
//      engines is quietly narrower than the one on the site — and it will be
//      quoted as though complete.
//   2. It is COMPLETE or it is a 503. A partially-rendered standard served 200
//      and cached for an hour is worse than an outage (the US-2097 lesson).

import { describe, expect, it } from "vitest";
import { buildLlmsFullTxt, type LlmsFullData } from "../../functions/_shared/seo-config";
import {
  GRADETHREAD_SCALE_NAME,
  GRADETHREAD_SCALE_DEFINITION,
  scaleBands,
} from "@/lib/seo/grading-scale";
import { GLOSSARY_ENTRIES } from "@/lib/seo/glossary";
import { RESELLER_TERMS, RESELLER_GLOSSARY_HUB_PATH } from "@/lib/seo/reseller-glossary";
import { FLAW_ENTRIES, FLAW_LIBRARY_HUB_PATH } from "@/lib/seo/flaw-library";
import {
  PUBLISHED_FACTOR_WEIGHTS,
  PUBLISHED_SIZE_BUCKETS,
  PUBLISHED_SEVERITY_SCALE,
  PUBLISHED_FLAW_ROUTING,
} from "@/lib/grading-standard";
import { GRADING_REVIEW_CONFIDENCE_THRESHOLD } from "@/lib/constants";

const SITE = "https://gradethread.com";

// Built exactly as vite.config.ts's llmsFullDataPlugin builds it, so this test
// exercises the real payload shape rather than a convenient fixture.
const data: LlmsFullData = {
  generatedAt: "2026-07-19T00:00:00.000Z",
  scale: {
    name: GRADETHREAD_SCALE_NAME,
    definition: GRADETHREAD_SCALE_DEFINITION,
    bands: scaleBands(),
  },
  factorWeights: PUBLISHED_FACTOR_WEIGHTS,
  sizeBuckets: PUBLISHED_SIZE_BUCKETS,
  severityScale: PUBLISHED_SEVERITY_SCALE,
  flawRouting: PUBLISHED_FLAW_ROUTING,
  reviewConfidenceThreshold: GRADING_REVIEW_CONFIDENCE_THRESHOLD,
  glossary: GLOSSARY_ENTRIES.map((e) => ({
    term: e.term,
    expansion: e.expansion,
    path: e.path,
    definition: e.definition,
  })),
  resellerTerms: RESELLER_TERMS.map((t) => ({
    term: t.term,
    alternateNames: t.alternateNames,
    path: `${RESELLER_GLOSSARY_HUB_PATH}/${t.slug}`,
    definition: t.definition,
  })),
  flaws: FLAW_ENTRIES.map((f) => ({
    name: f.name,
    alternateNames: f.alternateNames,
    path: `${FLAW_LIBRARY_HUB_PATH}/${f.slug}`,
    definition: f.definition,
  })),
};

const txt = buildLlmsFullTxt(SITE, data);

describe("US-2106: /llms-full.txt carries the whole standard", () => {
  it("includes EVERY grade tier with its marketplace equivalent", () => {
    // The marketplace-equivalent column is the highest-value part for an answer
    // engine mapping "eBay: New with tags" onto our scale.
    for (const b of scaleBands()) {
      expect(txt, `tier ${b.term} missing`).toContain(b.label);
      expect(txt, `marketplace equivalent for ${b.term} missing`).toContain(
        b.marketplaceEquivalent,
      );
    }
  });

  it("includes every factor and its weight", () => {
    for (const f of PUBLISHED_FACTOR_WEIGHTS) {
      expect(txt).toContain(f.label);
      expect(txt).toContain(`${Math.round(f.weight * 100)}%`);
    }
  });

  it("includes the measurable tolerances, not just adjectives", () => {
    // This is what separates a citable spec from a rubric (US-2107).
    for (const b of PUBLISHED_SIZE_BUCKETS) {
      expect(txt, `size bucket ${b.bucket} missing`).toContain(b.range);
    }
    for (const s of PUBLISHED_SEVERITY_SCALE) {
      expect(txt).toContain(s.severity);
    }
    for (const r of PUBLISHED_FLAW_ROUTING) {
      expect(txt, `flaw routing for ${r.flaw} missing`).toContain(r.flaw);
    }
    expect(txt).toContain(GRADING_REVIEW_CONFIDENCE_THRESHOLD.toFixed(2));
  });

  it("includes EVERY glossary term, reseller term and flaw", () => {
    // The derivation guarantee: adding a term to the constants must reach this
    // file, or the standard we hand to engines is narrower than the site's.
    for (const g of GLOSSARY_ENTRIES) {
      expect(txt, `glossary term "${g.term}" missing`).toContain(g.definition);
    }
    for (const t of RESELLER_TERMS) {
      expect(txt, `reseller term "${t.term}" missing`).toContain(t.definition);
    }
    for (const f of FLAW_ENTRIES) {
      expect(txt, `flaw "${f.name}" missing`).toContain(f.definition);
    }
  });

  it("emits absolute URLs so a fetched copy stays navigable", () => {
    expect(txt).toContain(`${SITE}${GLOSSARY_ENTRIES[0]!.path}`);
    expect(txt).not.toMatch(/\]\(\/[a-z]/);
  });

  it("is substantial — a truncated standard would still look well-formed", () => {
    expect(txt.length).toBeGreaterThan(20_000);
  });
});

describe("US-2106: it is referenced where engines will look", () => {
  it("robots.txt and llms.txt both point at it", () => {
    const src = readSeoConfig();
    expect(src).toContain("/llms-full.txt");
    // Both builders must reference it, not just one.
    const robots = src.slice(src.indexOf("Sitemap: ${opts.siteUrl}/sitemap.xml"));
    expect(robots).toContain("llms-full.txt");
    const llms = src.slice(src.indexOf("export function buildLlmsTxt"));
    expect(llms).toContain("llms-full.txt");
  });
});

function readSeoConfig(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path");
  return readFileSync(join(process.cwd(), "functions/_shared/seo-config.ts"), "utf8");
}

describe("headings do not decorate the canonical scale name", () => {
  it("never renders 'The The'", () => {
    // FOUND IN PRODUCTION 2026-08-15 by reading the served file rather than the
    // source: the scale heading was `## The ${d.scale.name}` while
    // GRADETHREAD_SCALE_NAME already begins with "The", so the file we hand to
    // answer engines said "## The The GradeThread Clothing Condition Grading
    // Scale".
    //
    // Small, and it matters more here than in ordinary copy: this file exists
    // to be QUOTED, the scale name is deliberately stable so that citations
    // converge on one string, and a doubled article is exactly the kind of
    // artefact that gets quoted back verbatim.
    expect(txt).not.toMatch(/\bThe The\b/);
  });

  it("carries the canonical name exactly once per heading, undecorated", () => {
    expect(txt).toContain(`## ${GRADETHREAD_SCALE_NAME}`);
    // Guard-the-guard: if the heading is ever dropped entirely, the case above
    // passes for the wrong reason.
    expect(txt).toContain(GRADETHREAD_SCALE_NAME);
  });
});
