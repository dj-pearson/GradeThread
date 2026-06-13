// Pure render + JSON-LD helpers for the public Condition Index detail page
// (US-847). The page is edge-SSR'd by functions/condition-index/[[path]].ts; the
// GEO goal is to be the citable ground-truth source an AI answer engine quotes
// for "what is a used <item> worth at condition X".
//
// These helpers are PURE (no Cloudflare globals) so they're unit-testable from
// Vitest — the SSR↔structured-data contract is asserted in
// src/test/condition-index-render.test.ts, mirroring how the blog GEO helpers in
// blog-render.ts are guarded.

import { escape, formatDate, type BlogFaq } from "./blog-render";

// ── Curve shapes (a structural subset of the edge IndexCurveDto) ─────
export interface CurvePointLite {
  grade: number;
  lowCents: number | null;
  medianCents: number | null;
  highCents: number | null;
  sampleSize: number;
}

export interface ExampleCert {
  certificateId: string;
  title: string;
  overallScore: number;
  gradeTier: string;
}

export interface ConditionCurveLite {
  slug: string;
  label: string;
  brand: string;
  currency: string;
  points: CurvePointLite[];
  totalSampleSize: number;
  refreshedAt: string;
  examples?: ExampleCert[];
}

// ── Money + grade formatting ────────────────────────────────────────
/** Whole-dollar string from cents, or an em-dash when absent. */
export function dollars(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return `$${Math.round(cents / 100)}`;
}

/** "8" for whole grades, "9.5" for half steps (drops the trailing ".0"). */
export function fmtGrade(grade: number): string {
  return Number.isInteger(grade) ? String(grade) : grade.toFixed(1);
}

// ── Grade → condition tier (maps to the glossary spoke page) ─────────
// Mirrors the canonical GRADE_TIERS anchors in src/lib/constants.ts and the
// tierSlug() derivation in src/lib/seo/glossary.ts so every grade links to its
// definitive /grading/<slug> page.
export interface TierLink {
  label: string;
  /** Glossary spoke path, e.g. "/grading/excellent". */
  path: string;
}

const TIER_BANDS: ReadonlyArray<{ min: number; label: string; slug: string }> = [
  { min: 10, label: "NWT", slug: "nwt" },
  { min: 9, label: "NWOT", slug: "nwot" },
  { min: 8, label: "Excellent", slug: "excellent" },
  { min: 7, label: "Very Good", slug: "very-good" },
  { min: 6, label: "Good", slug: "good" },
  { min: 5, label: "Fair", slug: "fair" },
  { min: 0, label: "Poor", slug: "poor" },
];

export function gradeTier(grade: number): TierLink {
  const band = TIER_BANDS.find((b) => grade >= b.min) ?? TIER_BANDS[TIER_BANDS.length - 1]!;
  return { label: band.label, path: `/grading/${band.slug}` };
}

// ── Grading-factor glossary spokes (the five weighted factors) ───────
// Mirrors GRADE_FACTORS + factorSlug() in src/lib/seo/glossary.ts.
export const GRADING_FACTOR_LINKS: ReadonlyArray<{ label: string; weight: string; path: string }> = [
  { label: "Fabric Condition", weight: "30%", path: "/grading/fabric-condition" },
  { label: "Structural Integrity", weight: "25%", path: "/grading/structural-integrity" },
  { label: "Cosmetic Appearance", weight: "20%", path: "/grading/cosmetic-appearance" },
  { label: "Functional Elements", weight: "15%", path: "/grading/functional-elements" },
  { label: "Odor & Cleanliness", weight: "10%", path: "/grading/odor-cleanliness" },
];

// ── Per-grade rows (published grades only, high → low) ───────────────
export interface GradeRow {
  grade: number;
  tier: TierLink;
  median: number | null;
  low: number | null;
  high: number | null;
  sampleSize: number;
}

/**
 * Published grade points (those that cleared suppression upstream — the edge DTO
 * already drops thin grades), highest first, each annotated with its tier link.
 * A grade WITHOUT a median is never surfaced, so no fabricated number renders.
 */
export function publishedGradeRows(curve: ConditionCurveLite): GradeRow[] {
  return [...curve.points]
    .filter((p) => p.medianCents != null)
    .sort((a, b) => b.grade - a.grade)
    .map((p) => ({
      grade: p.grade,
      tier: gradeTier(p.grade),
      median: p.medianCents,
      low: p.lowCents,
      high: p.highCents,
      sampleSize: p.sampleSize,
    }));
}

// ── Visible per-grade plain-language value summary ───────────────────
export function renderPerGradeSummary(curve: ConditionCurveLite): string {
  const rows = publishedGradeRows(curve);
  if (rows.length === 0) return "";
  const items = rows
    .map((r) => {
      const range =
        r.low != null && r.high != null && r.low !== r.high
          ? ` <span class="ci-range">(${dollars(r.low)}–${dollars(r.high)})</span>`
          : "";
      return `<li><a class="ci-grade" href="${r.tier.path}">Grade ${escape(
        fmtGrade(r.grade),
      )} · ${escape(r.tier.label)}</a> — typically <strong>${dollars(
        r.median,
      )}</strong>${range} <span class="muted">· ${r.sampleSize} comps</span></li>`;
    })
    .join("");
  return `<section class="ci-summary">
      <h2>Value at each condition grade</h2>
      <p>What a <strong>${escape(curve.label)}</strong> is typically worth at each GradeThread
      condition grade, from condition-matched resale comps. Click a grade to see what it means.</p>
      <ul>${items}</ul>
    </section>`;
}

// ── Methodology + comp-count + freshness line ────────────────────────
export function renderMethodology(curve: ConditionCurveLite): string {
  return `<section class="ci-method">
      <h2>Methodology</h2>
      <p class="muted">Each value is the <strong>median of ${curve.totalSampleSize}
      condition-matched resale listings</strong> for this item, bucketed by GradeThread's
      objective 1.0&ndash;10.0 condition grade and last refreshed
      <strong>${escape(formatDate(curve.refreshedAt))}</strong>. Ranges show the typical
      low&ndash;high. Grades that lack enough comps are omitted rather than estimated, so no
      number on this page is fabricated. Figures are resale estimates, not guaranteed sale prices.</p>
    </section>`;
}

// ── Internal links to the grading-factor glossary spokes ─────────────
export function renderGradingFactors(): string {
  const items = GRADING_FACTOR_LINKS.map(
    (f) =>
      `<li><a href="${f.path}">${escape(f.label)}</a> <span class="muted">(${f.weight})</span></li>`,
  ).join("");
  return `<section class="ci-factors">
      <h2>How GradeThread grades condition</h2>
      <p>Every grade combines five weighted factors on a transparent 1.0&ndash;10.0 scale:</p>
      <ul>${items}</ul>
    </section>`;
}

// ── Example public certificates of this item (internal links) ────────
export function renderExampleCertificates(curve: ConditionCurveLite): string {
  const examples = (curve.examples ?? []).filter((e) => e.certificateId && e.title);
  if (examples.length === 0) return "";
  const items = examples
    .map(
      (e) =>
        `<li><a href="/cert/${escape(e.certificateId)}">${escape(e.title)}</a> — ${escape(
          e.gradeTier,
        )} (${e.overallScore.toFixed(1)}/10)</li>`,
    )
    .join("");
  return `<section class="ci-examples">
      <h2>Example graded ${escape(curve.label)}s</h2>
      <p>Real, verifiable GradeThread certificates for this item:</p>
      <ul>${items}</ul>
    </section>`;
}

// ── FAQPage JSON-LD: one Q per published grade anchor ────────────────
/**
 * "What is a grade-8 (Excellent) <item> worth?" → the median from the curve.
 * Only published grades with a real median become questions, so the structured
 * data never asserts a fabricated number.
 */
export function conditionFaqs(curve: ConditionCurveLite): BlogFaq[] {
  const date = formatDate(curve.refreshedAt);
  return publishedGradeRows(curve).map((r) => ({
    q: `What is a grade-${fmtGrade(r.grade)} (${r.tier.label}) ${curve.label} worth?`,
    a: `A ${curve.label} in ${r.tier.label} condition (grade ${fmtGrade(r.grade)}) is typically worth about ${dollars(
      r.median,
    )}, based on ${r.sampleSize} condition-matched resale comps. Updated ${date}. This is a resale estimate, not a guaranteed sale price.`,
  }));
}

// ── Dataset JSON-LD (strengthened: variableMeasured + measurementTechnique) ──
export function conditionDatasetLd(
  curve: ConditionCurveLite,
  canonical: string,
  siteUrl: string,
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: `${curve.label} — condition value index`,
    description: `Price-vs-condition resale value for ${curve.label}, by GradeThread condition grade, from ${curve.totalSampleSize} condition-matched resale comparables.`,
    url: canonical,
    creator: { "@type": "Organization", name: "GradeThread", url: siteUrl },
    dateModified: curve.refreshedAt,
    isAccessibleForFree: true,
    measurementTechnique:
      "Aggregated condition-matched resale comparables, bucketed by GradeThread's objective 1.0–10.0 condition grade.",
    variableMeasured: [
      {
        "@type": "PropertyValue",
        name: "Resale value (USD)",
        description: "Median, low, and high condition-matched resale value at each grade.",
        unitText: curve.currency,
      },
      {
        "@type": "PropertyValue",
        name: "Condition grade",
        description: "GradeThread objective 1.0–10.0 condition grade.",
        minValue: 1,
        maxValue: 10,
      },
    ],
    keywords: [
      curve.label,
      curve.brand,
      "resale value",
      "condition grade",
      "used clothing value",
    ].filter(Boolean),
  };
}
