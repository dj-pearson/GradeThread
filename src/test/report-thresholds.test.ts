// US-2098: empty data reports must not present themselves as citable findings.
//
// /state-of-durability rendered a "GradeThread, The State of Secondhand
// Durability... CC BY 4.0" citation block over a dataset that is EMPTY, and
// /transparency rendered an MAE of "0.00" from 17 reviews — which reads as
// fabricated-perfect rather than low-sample, and 0.00 is exactly the value an
// answer engine would quote back at us.
//
// This is the one defect class in the audit that can actively DAMAGE
// credibility rather than merely underperform, which is why the assertions
// below are about refusing to publish rather than about rendering nicely.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MIN_QUALITY_REVIEWS,
  MIN_DURABILITY_COHORTS,
  hasSufficientSample,
  isPublishableReport,
} from "@/lib/report-thresholds";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("US-2098: publication thresholds", () => {
  it("an absent sample size is INSUFFICIENT, not permissive", () => {
    // Not knowing the sample is not the same as having one. Publishing a
    // statistic whose support is unknown is the exact failure being guarded.
    expect(hasSufficientSample(undefined, 30)).toBe(false);
    expect(hasSufficientSample(null, 30)).toBe(false);
    expect(hasSufficientSample(NaN, 30)).toBe(false);
  });

  it("gates on >= threshold", () => {
    expect(hasSufficientSample(29, 30)).toBe(false);
    expect(hasSufficientSample(30, 30)).toBe(true);
    expect(hasSufficientSample(31, 30)).toBe(true);
  });

  it("zero is never publishable — the live durability dataset's actual state", () => {
    expect(isPublishableReport(0, MIN_DURABILITY_COHORTS)).toBe(false);
  });

  it("mirrors the condition-index precedent for cohort count", () => {
    // AC4 asks for parity with MIN_INDEX_TOTAL_SAMPLE = 8, which the condition
    // index already enforces and never fabricates below.
    expect(MIN_DURABILITY_COHORTS).toBe(8);
    const engine = read("services/edge-functions/src/lib/condition-index.ts");
    expect(engine).toContain("export const MIN_INDEX_TOTAL_SAMPLE = 8");
  });
});

describe("US-2098: the report pages actually apply the gate", () => {
  it("/state-of-durability noindexes itself and drops the citation when thin", () => {
    const src = read("src/pages/marketing/state-of-durability.tsx");
    expect(src).toContain("isPublishableReport");
    expect(src, "must noindex an unpublishable report").toContain("noindex={!publishable}");
    // The citation block must be conditional, not unconditional prose.
    expect(src).toMatch(/publishable \?[\s\S]{0,200}Cite this report/);
    expect(src).toContain("Findings pending");
  });

  it("the two decisions are driven by ONE flag", () => {
    // A page that noindexes but still shows "cite this report" still invites
    // citation from anyone arriving by link; one that drops the citation but
    // stays indexed still advertises an empty report. They must not diverge.
    const src = read("src/pages/marketing/state-of-durability.tsx");
    const uses = (src.match(/publishable/g) ?? []).length;
    expect(uses, "noindex and the citation block must share one decision").toBeGreaterThanOrEqual(3);
  });

  it("/transparency gates derived statistics on sample size", () => {
    const src = read("src/pages/marketing/transparency.tsx");
    expect(src).toContain("MIN_QUALITY_REVIEWS");
    // AC2: n= must be rendered, not just used in a condition.
    expect(src, "sample size must be VISIBLE next to the figures").toMatch(/n&nbsp;=&nbsp;/);
    // AC3: the three derived rates run through the gate.
    const gated = (src.match(/gated\(n,/g) ?? []).length;
    expect(gated, "each derived statistic must be sample-gated").toBeGreaterThanOrEqual(3);
  });

  it("MIN_QUALITY_REVIEWS is a real floor, not a formality", () => {
    // The reported failure was an MAE computed from 17 reviews. Whatever the
    // threshold becomes, it must still exclude that.
    expect(MIN_QUALITY_REVIEWS).toBeGreaterThan(17);
  });
});

describe("US-2098: the noindex reaches CRAWLERS, not just the SPA", () => {
  it("head-builder emits noindex for an unpublishable report", async () => {
    // The trap this catches: react-helmet-async v3 renders no server-side head,
    // so a noindex set only in the page's <SEO> reaches humans and never
    // reaches a crawler — exactly backwards for a page we want OUT of the
    // index. Verified in the built HTML during development; asserted here so it
    // cannot regress to SPA-only.
    const { buildHeadTags } = await import("@/../src/prerender/head-builder");
    const { PUBLIC_ROUTES } = await import("@/lib/seo/public-routes");
    const route = PUBLIC_ROUTES.find((r) => r.path === "/state-of-durability")!;
    expect(route).toBeTruthy();

    // No seed is set in the test env, and reportIsUnpublishable fails CLOSED:
    // an unknown dataset must not be indexed as though it were a finding.
    const head = buildHeadTags(route);
    expect(head).toContain('name="robots" content="noindex, follow"');
    expect(head).not.toContain("max-image-preview");
  });

  it("an ordinary page still gets the full rich-result robots directive", () => {
    // Guards the blast radius: the gate must apply to the report page only.
    const src = readFileSync(
      join(process.cwd(), "src/prerender/head-builder.ts"),
      "utf8",
    );
    expect(src).toContain("reportIsUnpublishable(route.path)");
    expect(src).toContain("max-image-preview:large");
  });
});
