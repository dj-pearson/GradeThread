// Free printable clothing condition chart (US-1678): /grading/condition-chart.
//
// A no-signup, shareable reference asset: the full 1.0–10.0 grade scale mapped to
// tier names, criteria, typical flaws, and marketplace condition wording, plus
// the five weighted factors. Carries the GradeThread name and links to
// /grading/scale so when it's shared in reseller threads it seeds the standard.
// Print-optimized (the SPA page hides chrome for print).
//
// No new content data — the chart renders from the SINGLE SOURCE OF TRUTH
// (scaleBands() + GRADE_FACTORS), so it can never drift from the scale.
//
// PURE DATA: imports only the PublicRoute TYPE.

import type { PublicRoute } from "./public-routes";

export const CONDITION_CHART_PATH = "/grading/condition-chart";

export function isConditionChartPath(path: string): boolean {
  return path.replace(/\/+$/, "") === CONDITION_CHART_PATH;
}

export const CONDITION_CHART_META = {
  path: CONDITION_CHART_PATH,
  title: "Free Printable Clothing Condition Chart",
  description:
    "A free printable clothing condition chart mapping the 1.0–10.0 grade scale to tier names, criteria, and marketplace wording. No signup — print or share.",
  h1: "Free printable clothing condition chart",
};

export function conditionChartRoute(): PublicRoute {
  return {
    path: CONDITION_CHART_PATH,
    title: CONDITION_CHART_META.title,
    description: CONDITION_CHART_META.description,
    changefreq: "yearly",
    priority: 0.6,
    jsonLdType: "Article",
  };
}
