// Single source of truth for every INDEXABLE static public route.
//
// This registry is the engine of the SEO machine (PRD: tasks/prd-seo-hardening.md,
// US-291). It is consumed by:
//   - the build-time SEO manifest (vite.config.ts → dist/seo-manifest.json)
//   - the dynamic sitemap Pages Function (functions/sitemap.xml.ts, US-293)
//   - the llms.txt Pages Function (functions/llms.txt.ts, US-295)
//   - the deploy-time IndexNow submitter (US-297)
//   - the CI guard test (./__tests__/public-routes.test.ts) which fails the
//     build if a public router path is missing here, so you CANNOT ship a
//     public page that isn't indexable.
//
// Dynamic collections (blog posts, certificates) are NOT listed here — they
// enter the sitemap via the edge API, which already knows them.
//
// Keep this file dependency-light: it is imported by the Vite config in a plain
// Node context as well as by the browser bundle. It may import other PURE-DATA
// modules via RELATIVE paths (the `@/` alias is not resolved in the Vite config
// context) — e.g. ./glossary, which derives its routes from src/lib/constants.

import { glossaryRoutes } from "./glossary";

export const SITE_URL = "https://gradethread.com";

export type ChangeFreq =
  | "always"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "never";

export interface PublicRoute {
  /** Absolute path, no trailing slash (except "/"). */
  path: string;
  /** <title> (without the " | GradeThread" suffix the SEO component adds). */
  title: string;
  /** Meta description. */
  description: string;
  changefreq: ChangeFreq;
  /** Sitemap priority 0.0–1.0. */
  priority: number;
  /** Primary JSON-LD type rendered on the page (for documentation/audit). */
  jsonLdType?: string;
}

// US-429: per-route content-change date (YYYY-MM-DD) for the sitemap <lastmod>.
// HAND-MAINTAINED and stable across deploys — NEVER the build timestamp — so an
// unchanged route keeps the same lastmod every deploy (crawlers stop re-fetching
// pages that didn't change). Bump a route's date ONLY when its rendered content
// meaningfully changes. Routes not listed (e.g. generated glossary spokes) fall
// back to DEFAULT_LAST_MODIFIED.
export const DEFAULT_LAST_MODIFIED = "2026-06-01";
const ROUTE_LAST_MODIFIED: Record<string, string> = {
  "/": "2026-06-01",
  "/how-it-works": "2026-06-01",
  "/pricing": "2026-06-01",
  "/for-resellers": "2026-06-01",
  "/faq": "2026-06-01",
  "/condition-grading": "2026-06-01",
  "/grading-standard": "2026-06-01",
  "/transparency": "2026-06-01",
  // Legal pages mirror their rendered effectiveDate ("April 1, 2026").
  "/privacy": "2026-04-01",
  "/terms": "2026-04-01",
  "/cookies": "2026-04-01",
  "/acceptable-use": "2026-04-01",
  "/dpa": "2026-04-01",
  "/subprocessors": "2026-04-01",
  "/dmca": "2026-04-01",
  "/accessibility": "2026-04-01",
};

/** Stable content-change date for a route's sitemap <lastmod>. */
export function lastModifiedFor(path: string): string {
  return ROUTE_LAST_MODIFIED[normalizePath(path)] ?? DEFAULT_LAST_MODIFIED;
}

export const PUBLIC_ROUTES: PublicRoute[] = [
  {
    path: "/",
    title: "The Standard for Clothing Condition Grading",
    description:
      "The trusted standard for pre-owned clothing condition grading: get an objective 1.0–10.0 grade and a shareable certificate buyers trust, then sell faster.",
    changefreq: "weekly",
    priority: 1.0,
    jsonLdType: "WebSite",
  },
  {
    path: "/how-it-works",
    title: "How It Works",
    description:
      "How GradeThread's AI grades pre-owned clothing: upload photos, get a 1.0–10.0 condition grade across 5 weighted factors, and share a verified certificate.",
    changefreq: "monthly",
    priority: 0.9,
    jsonLdType: "HowTo",
  },
  {
    path: "/pricing",
    title: "Pricing",
    description:
      "GradeThread pricing: a free plan with 3 grades/month, pay-per-grade tiers from $2.99, credit packs, and FlipDesk reseller subscriptions.",
    changefreq: "weekly",
    priority: 0.9,
    jsonLdType: "FAQPage",
  },
  {
    path: "/for-resellers",
    title: "For Resellers",
    description:
      "Standardized condition grades that build buyer trust, cut returns, and speed up sales for eBay, Poshmark, Mercari, Depop, and Grailed sellers.",
    changefreq: "monthly",
    priority: 0.8,
  },
  {
    path: "/faq",
    title: "Frequently Asked Questions",
    description:
      "Answers about AI clothing grading, the 1.0–10.0 condition scale, disputes, certificates, pricing, credits, and the GradeThread API.",
    changefreq: "monthly",
    priority: 0.7,
    jsonLdType: "FAQPage",
  },
  {
    path: "/condition-grading",
    title: "What Is Clothing Condition Grading?",
    description:
      "A complete guide to pre-owned clothing condition grading: the 1.0–10.0 scale, the 7 tiers (NWT to Poor), and the 5 weighted factors graders assess.",
    changefreq: "monthly",
    priority: 0.9,
  },
  {
    path: "/grading-standard",
    title: "The GradeThread Grading Standard",
    description:
      "The objective methodology behind every GradeThread grade: a published 1.0–10.0 rubric, five weighted factors, half-point precision, and confidence scoring.",
    changefreq: "monthly",
    priority: 0.8,
    jsonLdType: "FAQPage",
  },
  {
    path: "/transparency",
    title: "Grading Accuracy & Transparency Report",
    description:
      "GradeThread's published grading accuracy versus expert reviewers: AI-vs-human agreement, mean error, model confidence, and buyer dispute rate.",
    changefreq: "weekly",
    priority: 0.8,
    jsonLdType: "Dataset",
  },
  {
    path: "/privacy",
    title: "Privacy Policy",
    description:
      "How GradeThread (Pearson Media LLC) collects, uses, and protects your data.",
    changefreq: "yearly",
    priority: 0.3,
  },
  {
    path: "/terms",
    title: "Terms of Service",
    description:
      "The terms governing your use of GradeThread's AI clothing-grading and FlipDesk reseller services.",
    changefreq: "yearly",
    priority: 0.3,
  },
  {
    path: "/cookies",
    title: "Cookie Policy",
    description:
      "How GradeThread uses cookies and similar technologies, and how to manage your cookie preferences.",
    changefreq: "yearly",
    priority: 0.3,
  },
  {
    path: "/acceptable-use",
    title: "Acceptable Use Policy",
    description:
      "What is and isn't allowed when using GradeThread's clothing-grading and reseller platform.",
    changefreq: "yearly",
    priority: 0.3,
  },
  {
    path: "/dpa",
    title: "Data Processing Addendum",
    description: "GradeThread's DPA for customers with GDPR/CCPA data-processing obligations.",
    changefreq: "yearly",
    priority: 0.3,
  },
  {
    path: "/subprocessors",
    title: "Subprocessors",
    description: "The third-party subprocessors GradeThread uses to process personal data.",
    changefreq: "monthly",
    priority: 0.3,
  },
  {
    path: "/dmca",
    title: "Copyright & Content Takedown (DMCA)",
    description: "How to report infringing or abusive content and our DMCA designated-agent info.",
    changefreq: "yearly",
    priority: 0.3,
  },
  {
    path: "/accessibility",
    title: "Accessibility Statement",
    description: "GradeThread's commitment to WCAG 2.1 AA accessibility and how to report barriers.",
    changefreq: "yearly",
    priority: 0.3,
  },
  // Condition-grading glossary hub (US-303): one page per grade tier + factor,
  // generated from src/lib/constants.ts. Spokes off the /condition-grading
  // pillar; auto-flow into the manifest/sitemap/IndexNow/prerender.
  ...glossaryRoutes(),
];

/** Normalize a pathname for lookup (strip trailing slash, keep root as "/"). */
export function normalizePath(path: string): string {
  if (path === "/" || path === "") return "/";
  return path.replace(/\/+$/, "");
}

/** Registry entry for a path, or undefined if the route is not registered. */
export function getRouteMeta(path: string): PublicRoute | undefined {
  const norm = normalizePath(path);
  return PUBLIC_ROUTES.find((r) => r.path === norm);
}

/** Absolute canonical URL for a registry path. */
export function absoluteUrl(path: string): string {
  const norm = normalizePath(path);
  return norm === "/" ? `${SITE_URL}/` : `${SITE_URL}${norm}`;
}
