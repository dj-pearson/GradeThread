// Brand-partner pitch landing (US-1788): /for-brands.
//
// Positions GradeThread as the neutral resale-condition + circularity STANDARD
// for brand-run resale programs (Worn Wear / trade-in style). Model A prerendered
// marketing page. PURE DATA: imports only the PublicRoute TYPE.

import type { PublicRoute } from "./public-routes";

export const FOR_BRANDS_PATH = "/for-brands";

export const FOR_BRANDS_META = {
  path: FOR_BRANDS_PATH,
  title: "Resale Condition & Circularity for Brands",
  description:
    "Run a resale or trade-in program on an objective condition grade buyers trust, with a circularity-impact export for your ESG reporting. GradeThread for brands.",
  h1: "The resale condition & circularity standard for brands",
  intro:
    "Brand-run resale and trade-in programs live or die on trust in condition. GradeThread gives your program one objective, published 1.0–10.0 condition grade — the same standard buyers already trust on the open market — plus an aggregate circularity-impact export that feeds your ESG reporting. Neutral, standardized, and built for scale.",
};

export function forBrandsRoute(): PublicRoute {
  return {
    path: FOR_BRANDS_PATH,
    title: FOR_BRANDS_META.title,
    description: FOR_BRANDS_META.description,
    changefreq: "monthly",
    priority: 0.7,
    // US-2044: jsonLdType must describe what is ACTUALLY prerendered — it is
    // now enforced by jsonld-parity.test.tsx, so a decorative value fails the
    // build rather than quietly misinforming the next reader.
    // No jsonLdType: the page passes no jsonLd, so it gets the generic
    // Organization + BreadcrumbList base. Declaring "WebPage" claimed markup
    // that was never emitted on either path. Wiring real markup here is a
    // worthwhile follow-up; asserting it exists when it does not is not.
  };
}
