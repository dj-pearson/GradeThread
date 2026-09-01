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
import { resellerGlossaryRoutes } from "./reseller-glossary";
import { flipdeskLandingRoutes } from "./flipdesk-landing";
import { resellingRoutes } from "./reselling-guides";
import { flawLibraryRoutes } from "./flaw-library";
import { careMatrixRoutes } from "./care-matrix";
import { garmentGuideRoutes } from "./garment-guides";
import { comparisonRoutes } from "./comparison-guides";
import { opportunistRoutes } from "./opportunist-guides";
import { returnsSpineRoute } from "./returns-spine";
import { platformStandardsRoutes } from "./platform-standards";
import { whereToSellRoute } from "./where-to-sell";
import { crosslistAppsRoute } from "./crosslisting-apps";
import { competitorAlternativeRoutes } from "./competitor-alternatives";
import { switchFromRoutes } from "./switch-from";
import { crosslistPairRoutes } from "./crosslist-pairs";
import { conditionChartRoute } from "./condition-chart";
import { changelogRoute } from "./changelog";
import { gradeCheckerRoute } from "./grade-checker";
import { rnLookupRoute } from "./rn-lookup";
import { authenticityCheckRoute } from "./authenticity-check";
import { fitCheckerRoute } from "./fit-checker";
import { calculatorRoutes } from "./calculators";
import { forBrandsRoute } from "./for-brands";
import {
  SITE_URL,
  DEFAULT_OG_IMAGE_PATH,
  DEFAULT_OG_IMAGE_ALT,
  normalizePath,
} from "./site";

// Re-exported so the 66 existing registry consumers keep working unchanged.
// Prefer importing these from "@/lib/seo/site" directly — importing them from
// HERE pulls the whole 213-route registry and its prose into your chunk, which
// is the bundle problem the split exists to fix. See the note in ./site.ts.
export {
  SITE_URL,
  OG_IMAGE_WIDTH,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_TYPE,
  DEFAULT_OG_IMAGE_PATH,
  DEFAULT_OG_IMAGE_ALT,
  normalizePath,
  absoluteUrl,
} from "./site";

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
  /**
   * Points the canonical somewhere OTHER than this route's own path, for the
   * case where two URLs serve one intent and we have decided which one wins.
   *
   * A route with this set is deliberately kept live and reachable — it is not
   * a redirect and not a 404 — but it is dropped from the sitemap, because
   * listing a URL you have just told Google to ignore is a contradictory
   * signal. US-9008 is the first and so far only use.
   */
  canonicalPath?: string;
}

// US-429: per-route content-change date (YYYY-MM-DD) for the sitemap <lastmod>.
// HAND-MAINTAINED and stable across deploys — NEVER the build timestamp — so an
// unchanged route keeps the same lastmod every deploy (crawlers stop re-fetching
// pages that didn't change). Bump a route's date ONLY when its rendered content
// meaningfully changes. Routes not listed (e.g. generated glossary spokes) fall
// back to DEFAULT_LAST_MODIFIED.
const DEFAULT_LAST_MODIFIED = "2026-06-01";
const ROUTE_LAST_MODIFIED: Record<string, string> = {
  "/": "2026-06-26",
  "/how-it-works": "2026-06-01",
  "/pricing": "2026-06-01",
  "/for-resellers": "2026-06-01",
  "/flipdesk": "2026-06-27",
  "/sell-used-clothes-ebay": "2026-06-27",
  "/faq": "2026-06-01",
  "/condition-grading": "2026-06-01",
  "/grading-standard": "2026-06-26",
  "/grading/scale": "2026-07-06",
  "/grading/methodology": "2026-07-06",
  "/grading/graded-clothing-meaning": "2026-07-06",
  "/grading/vs-authentication": "2026-07-06",
  "/transparency": "2026-06-01",
  // US-1691 revised the asset (grading half + "by the numbers"). Keep in step
  // with RESALE_REPORT_MODIFIED in src/pages/marketing/marketing-jsonld.ts.
  "/resale-condition-report": "2026-08-07",
  "/state-of-durability": "2026-07-09",
  "/verify": "2026-06-12",
  "/scan": "2026-06-19",
  "/verified": "2026-06-13",
  "/developers": "2026-06-12",
  "/whats-it-worth": "2026-06-13",
  "/buyer-guarantee": "2026-06-13",
  "/about": "2026-06-26",
  // US-855 cornerstone pillar pages.
  "/reduce-returns": "2026-06-13",
  "/reseller-grading-guide": "2026-06-13",
  "/design-vs-damage": "2026-06-13",
  "/resale-value-by-condition": "2026-06-13",
  "/grading-by-category": "2026-06-13",
  // Marketplace comparisons (US-1667/1685) — bump on the annual refresh (US-1694).
  "/compare": "2026-07-06",
  "/compare/mercari-vs-ebay": "2026-07-06",
  "/compare/poshmark-vs-mercari": "2026-07-06",
  "/compare/depop-vs-poshmark": "2026-07-06",
  "/compare/ebay-vs-poshmark": "2026-07-06",
  "/compare/ebay-vs-depop": "2026-07-06",
  "/compare/mercari-vs-depop": "2026-07-06",
  "/compare/grailed-vs-ebay": "2026-07-06",
  "/compare/grailed-vs-depop": "2026-07-06",
  "/compare/grailed-vs-poshmark": "2026-07-06",
  "/compare/vinted-vs-poshmark": "2026-07-06",
  "/compare/vinted-vs-depop": "2026-07-06",
  "/compare/vinted-vs-mercari": "2026-07-06",
  "/compare/vinted-vs-ebay": "2026-07-06",
  "/compare/whatnot-vs-ebay": "2026-07-06",
  "/compare/whatnot-vs-poshmark": "2026-07-06",
  "/compare/mercari-vs-grailed": "2026-07-06",
  // Opportunist mid-tail eBay guides (US-1668).
  "/reselling/ebay-item-specifics": "2026-07-06",
  "/reselling/comps/ebay-sold-comps": "2026-07-06",
  // The returns spine (US-1673).
  "/reselling/reduce-ebay-returns": "2026-07-06",
  // Platform condition-standard pages (US-1672) — bump on the quarterly re-check.
  "/grading/platform-standards": "2026-07-06",
  "/grading/platform-standards/ebay": "2026-07-06",
  "/grading/platform-standards/poshmark": "2026-07-06",
  "/grading/platform-standards/mercari": "2026-07-06",
  "/grading/platform-standards/depop": "2026-07-06",
  "/grading/platform-standards/grailed": "2026-07-06",
  "/grading/platform-standards/vinted": "2026-07-06",
  "/grading/platform-standards/whatnot": "2026-07-06",
  "/grading/platform-standards/thredup": "2026-07-06",
  "/grading/platform-standards/therealreal": "2026-07-06",
  // Consumer where-to-sell mega-guide (US-1693).
  "/where-to-sell-used-clothes": "2026-07-06",
  // Best crosslisting apps listicle (US-1686).
  "/reselling/best-crosslisting-apps": "2026-07-06",
  "/reselling/vendoo-alternative": "2026-07-20",
  "/reselling/list-perfectly-alternative": "2026-07-20",
  "/reselling/crosslist-alternative": "2026-07-20",
  "/reselling/switch-from-vendoo": "2026-09-01",
  "/reselling/crosslist/mercari-to-grailed": "2026-09-01",
  "/reselling/crosslist/grailed-to-mercari": "2026-09-01",
  "/reselling/crosslist/grailed-to-poshmark": "2026-09-01",
  "/reselling/crosslist/ebay-to-grailed": "2026-09-01",
  "/reselling/crosslist/whatnot-to-poshmark": "2026-09-01",
  "/reselling/crosslist/mercari-to-vinted": "2026-09-01",
  "/reselling/crosslist/poshmark-to-whatnot": "2026-09-01",
  "/reselling/crosslist/poshmark-to-grailed": "2026-09-01",
  "/reselling/crosslist/grailed-to-ebay": "2026-09-01",
  "/reselling/crosslist/vinted-to-mercari": "2026-09-01",
  "/reselling/crosslist/mercari-to-poshmark": "2026-09-01",
  "/reselling/crosslist/whatnot-to-ebay": "2026-09-01",
  "/reselling/crosslist/vinted-to-poshmark": "2026-09-01",
  "/reselling/crosslist/depop-to-poshmark": "2026-09-01",
  "/reselling/switch-from-list-perfectly": "2026-09-01",
  // Free printable condition chart (US-1678).
  "/grading/condition-chart": "2026-07-06",
  "/changelog": "2026-08-23",
  // Free grade-checker tool (US-1687).
  "/tools/grade-checker": "2026-07-06",
  // Free RN number lookup (US-9033).
  "/tools/rn-lookup": "2026-08-31",
  // Free authenticity-check tool (US-1771).
  "/tools/authenticity-check": "2026-07-09",
  // Free fit-checker tool (US-1780).
  "/tools/fit-checker": "2026-07-09",
  // Brand-partner pitch landing (US-1788).
  "/for-brands": "2026-07-09",
  // Legal pages mirror their rendered effectiveDate. Keep each entry in sync
  // with the `effectiveDate` prop on the corresponding page in src/pages/legal/.
  "/privacy": "2026-08-19",
  "/terms": "2026-08-19",
  "/cookies": "2026-04-01",
  "/acceptable-use": "2026-08-19",
  "/refund": "2026-07-02",
  "/account-deletion": "2026-08-21",
  "/imprint": "2026-07-02",
  "/dpa": "2026-06-12",
  "/subprocessors": "2026-08-14",
  "/dmca": "2026-04-01",
  "/trademarks": "2026-08-10",
  "/accessibility": "2026-04-01",
  "/status": "2026-06-12",
  "/leaderboard": "2026-06-13",
  // US-291: human HTML sitemap (long-tail internal-link discovery surface).
  "/sitemap": "2026-07-14",
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
    // US-2105 AC4: the page now emits Product/Offer as well as FAQPage. A route
    // declares ONE primary type, and Product is the commercially meaningful one
    // here — it is what a search engine renders a price from. FAQPage did not
    // lose its prerender guarantee: pricing-offer-jsonld.test.ts asserts BOTH
    // types survive the jsonLdForRoute() prerender path, which is the property
    // the parity guard provides.
    jsonLdType: "Product",
  },
  {
    path: "/for-resellers",
    jsonLdType: "Service",
    title: "For Resellers",
    description:
      "Standardized condition grades that build buyer trust, cut returns, and speed up sales for eBay, Poshmark, Mercari, Depop, and Grailed sellers.",
    changefreq: "monthly",
    priority: 0.8,
  },
  {
    path: "/flipdesk",
    // US-2105: the markup was already prerendered; it simply was not DECLARED,
    // so the US-2044 parity guard could not see it.
    jsonLdType: "SoftwareApplication",
    title: "FlipDesk — Management for eBay Resellers",
    description:
      "FlipDesk is GradeThread's reseller suite and works with eBay: grade, comp, list, reprice and reconcile in one place, with a verifiable grade per listing.",
    changefreq: "monthly",
    // US-9211: 0.9, level with /condition-grading and /pricing. It sat at 0.8
    // while the grading pillar sat at 0.9, which told crawlers the opposite of
    // the Path 7 decision — the reseller workflow is the capture leg.
    priority: 0.9,
  },
  {
    path: "/sell-used-clothes-ebay",
    jsonLdType: "Article",
    title: "How to Sell Used Clothes on eBay",
    description:
      "A condition-first guide to selling used clothes on eBay: grade the condition, map it to eBay's fields, price to sold comps, and cut returns.",
    changefreq: "monthly",
    priority: 0.7,
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
    jsonLdType: "DefinedTermSet",
    title: "How to Grade Used Clothing Condition, 1-10",
    description:
      "Clothing condition grading on a 1.0–10.0 scale: 5 weighted factors, 7 tiers from NWT to Poor, and the criteria graders actually apply, with worked examples.",
    changefreq: "monthly",
    priority: 0.9,
  },
  {
    path: "/grading-standard",
    title: "The GradeThread Grading Standard",
    description:
      "The published, objective methodology behind every grade: a fixed 1.0–10.0 rubric of five weighted factors — reproducible and independently verifiable.",
    changefreq: "monthly",
    priority: 0.8,
    jsonLdType: "FAQPage",
  },
  {
    // US-1664 (SEO 2.0 keystone): the named 1.0–10.0 standard itself — a
    // canonical, table-structured, DefinedTermSet-marked-up, printable page that
    // defines the GradeThread Scale. Category-defining GEO (zero KP volume by
    // design); every certificate links here.
    path: "/grading/scale",
    title: "Clothing Condition Grading Scale (1–10)",
    description:
      "The GradeThread Scale is the canonical 1.0–10.0 standard for pre-owned clothing condition — every grade defined, plus a free printable chart.",
    changefreq: "monthly",
    priority: 0.9,
    jsonLdType: "DefinedTermSet",
  },
  {
    // US-1677 (E-E-A-T): the methodology page — how the model is trained +
    // evaluated, what a grade claims, error handling, human review.
    path: "/grading/methodology",
    title: "How GradeThread Grades: Methodology",
    description:
      "What produces a GradeThread condition grade, how each rubric version is evaluated before it can serve, what a grade claims, and where human review fits.",
    changefreq: "monthly",
    priority: 0.7,
    jsonLdType: "Article",
  },
  {
    // US-1684: the "graded clothing" false-friend disambiguation page.
    path: "/grading/graded-clothing-meaning",
    title: "What Does Graded Clothing Mean?",
    description:
      "'Graded clothing' means two different things: wholesale Grade A/B/C bales, and per-item condition grading. Here's the difference and which one you mean.",
    changefreq: "monthly",
    priority: 0.6,
    jsonLdType: "Article",
  },
  {
    // US-1684: the single condition-vs-authentication bridge page (NOT a cluster).
    path: "/grading/vs-authentication",
    title: "Condition Grading vs Authentication",
    description:
      "Condition grading and authentication are distinct trust services: grading rates a garment's condition, authentication verifies it's genuine — how they differ.",
    changefreq: "monthly",
    priority: 0.6,
    jsonLdType: "Article",
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
    // US-976: public "State of Resale Condition" data report — proprietary,
    // citable aggregate stats (return rate / sell-through / resale value by
    // grade band). The strongest GEO lever (LLMs disproportionately quote
    // original data). Figures load client-side from the aggregate-only edge
    // endpoint; the prerendered shell carries the methodology + Dataset JSON-LD.
    path: "/resale-condition-report",
    title: "State of Resale Condition Report",
    description:
      "Original GradeThread data: average condition grade by garment type, the most common flaws in used clothing, and how grade drives returns and resale value.",
    changefreq: "weekly",
    priority: 0.8,
    jsonLdType: "Dataset",
  },
  {
    // US-1775: "State of Secondhand Durability" data report — original brand
    // durability findings (grade retention + factor decay) from the aggregate
    // table. Figures load client-side from the aggregate-only edge endpoint;
    // the prerendered shell carries the methodology + Dataset JSON-LD.
    path: "/state-of-durability",
    title: "State of Secondhand Durability Report",
    description:
      "Original GradeThread data on which pre-owned clothing brands hold their condition best, and which condition factors decay fastest, across regraded garments.",
    changefreq: "weekly",
    priority: 0.8,
    jsonLdType: "Dataset",
  },
  {
    // US-593: buyer-facing "verify this grade" entry point — a no-login lookup
    // that resolves a scanned QR / pasted certificate code to the certificate.
    // US-2750: the reseller-facing style-code lookup. The pSEO surface is the
    // per-code pages (US-2747); this is their hub and the page that explains
    // where the code is printed, which is the half a reseller actually needs.
    path: "/style",
    title: "Lululemon Style Code Lookup",
    description:
      "Type the style code from a Lululemon size dot and find out which product it is. Free, no account, and every answer shows where it came from.",
    changefreq: "weekly",
    priority: 0.8,
  },
  {
    path: "/verify",
    title: "Verify a Condition Grade",
    description:
      "Scan the QR code or enter a GradeThread certificate number to verify a pre-owned clothing condition grade before you buy — free, no account needed.",
    changefreq: "monthly",
    priority: 0.8,
    jsonLdType: "HowTo",
  },
  {
    // US-1106: buyer-facing "scan before you buy" Garment Passport entry — a
    // no-login lookup that resolves a scanned tag QR / pasted passport slug /
    // printed tag code to the public passport timeline (US-1093) or tag resolver
    // (US-1096). Demand-side wedge that grows passport coverage.
    path: "/scan",
    title: "Scan a Garment Passport Before You Buy",
    description:
      "Scan the passport QR or enter the code to see a pre-owned garment's full grade, listing, and ownership history before you buy — free, no account needed.",
    changefreq: "monthly",
    priority: 0.8,
    jsonLdType: "HowTo",
  },
  {
    // US-863: public verified-seller directory + leaderboard. Indexable
    // authority surface; the ranked seller list loads client-side from the
    // public sellers feed (/api/content/public/sellers.json).
    path: "/verified",
    jsonLdType: "CollectionPage",
    title: "Verified Seller Directory",
    description:
      "Browse trusted GradeThread Verified sellers, ranked by graded volume and average condition grade. Every item is independently AI condition-graded.",
    changefreq: "weekly",
    priority: 0.7,
  },
  {
    // US-849: public "what's my item worth?" condition-value tool — a
    // top-of-funnel lead magnet that reads the published Condition Index curve.
    path: "/whats-it-worth",
    title: "What's My Used Clothing Worth?",
    description:
      "Estimate what your used clothing is worth by brand, item, and condition grade — from real eBay sold-comp data in the GradeThread Condition Index.",
    changefreq: "weekly",
    priority: 0.8,
    jsonLdType: "FAQPage",
  },
  {
    // US-867: condition-backed buyer trust guarantee + mediation policy. The
    // public policy page; the claim intake form (/buyer-guarantee/claim) is a
    // dynamic form and is NOT registered here.
    path: "/buyer-guarantee",
    title: "Buyer Trust Guarantee",
    description:
      "GradeThread's condition-backed buyer guarantee: what 'materially not as graded' means, eligibility, and how to file a mediation claim against a certified grade.",
    changefreq: "monthly",
    priority: 0.7,
    jsonLdType: "Article",
  },
  {
    // US-868: company/about page — entity-level authority surface (E-E-A-T):
    // mission, published methodology, and who runs GradeThread (Pearson Media
    // LLC). Emits AboutPage + FAQPage JSON-LD (head-builder MARKETING_LD).
    path: "/about",
    title: "About",
    description:
      "GradeThread, built by Pearson Media LLC, is the standard for pre-owned clothing condition grading — our mission, our methodology, and how we keep grades honest.",
    changefreq: "monthly",
    priority: 0.6,
    jsonLdType: "AboutPage",
  },
  // US-855: cornerstone pillar pages — durable, hand-curated authority content
  // on the queries GradeThread uniquely owns. Each emits Article + FAQPage
  // JSON-LD (head-builder MARKETING_LD) and cross-links to the glossary spokes,
  // Condition Index, and transparency report via <CornerstoneLinks>.
  {
    path: "/reduce-returns",
    title: "Reduce Returns with Condition Proof",
    description:
      "Most pre-owned clothing returns are 'not as described.' A standardized condition grade and a verifiable certificate close the gap before the buyer pays.",
    changefreq: "monthly",
    priority: 0.8,
    jsonLdType: "Article",
  },
  {
    path: "/reseller-grading-guide",
    title: "A Reseller's Guide to Condition Grading",
    description:
      "What to grade, how to shoot it, and how to turn a standardized condition grade into faster sales and fewer disputes across eBay, Poshmark, Mercari, and Depop.",
    changefreq: "monthly",
    priority: 0.8,
    jsonLdType: "Article",
  },
  {
    path: "/design-vs-damage",
    title: "Intentional Design vs. Damage",
    description:
      "Factory distressing, raw hems, and acid washes are design, not flaws. How to tell intentional design from real damage so you don't underprice or earn a return.",
    changefreq: "monthly",
    priority: 0.7,
    jsonLdType: "Article",
  },
  {
    path: "/resale-value-by-condition",
    title: "Resale Value by Condition Grade",
    description:
      "Condition is one of the biggest levers on what used clothing sells for. See how resale value moves with each grade, from real eBay comps in the Condition Index.",
    changefreq: "monthly",
    priority: 0.8,
    jsonLdType: "Article",
  },
  {
    path: "/grading-by-category",
    title: "Condition Grading by Category",
    description:
      "The 1.0–10.0 scale is universal, but wear isn't. How grading plays out for denim, knits, leather, shoes, and vintage — and what to photograph for each.",
    changefreq: "monthly",
    priority: 0.7,
    jsonLdType: "Article",
  },
  {
    // US-596: developer docs for the Grade-as-a-Service API (SDK, sandbox, rate
    // limits, quotas, pricing, white-label).
    path: "/developers",
    jsonLdType: "APIReference",
    title: "Grading API for Developers",
    description:
      "Embed GradeThread AI clothing condition grading via a REST API and JavaScript SDK — free sandbox, white-label embeds, documented rate limits and pricing.",
    changefreq: "monthly",
    priority: 0.7,
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
    path: "/account-deletion",
    title: "Delete your account",
    description:
      "How to permanently delete your GradeThread or FlipDesk account and what happens to your data — the deletion URL Google Play requires.",
    changefreq: "yearly",
    priority: 0.3,
  },
  {
    path: "/refund",
    title: "Refund & Cancellation Policy",
    description:
      "How GradeThread and FlipDesk subscriptions, per-grade purchases, and credits are billed, cancelled, and refunded — including EU/UK consumer rights.",
    changefreq: "yearly",
    priority: 0.3,
  },
  {
    path: "/imprint",
    title: "Imprint / Legal Notice",
    description:
      "Provider identification and legal notice for GradeThread, operated by Pearson Media LLC (Impressum).",
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
    path: "/trademarks",
    title: "Trademarks & Third-Party Notices",
    description:
      "Trademark attribution and non-endorsement notices for the marketplaces named in GradeThread and FlipDesk, and the platforms we reach via a licensed API.",
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
  {
    // US-500: live component health is probed client-side after mount; the
    // prerendered shell just carries the page chrome + metadata.
    path: "/status",
    title: "System Status",
    description:
      "Live operational status of GradeThread's web app, grading API, database and authentication.",
    changefreq: "always",
    priority: 0.3,
  },
  {
    // US-864: public opt-in top-referrers leaderboard. The ranked list loads
    // client-side from the public feed; the prerendered shell carries the chrome
    // + metadata (like /status and /verified).
    path: "/leaderboard",
    title: "Top Referrers Leaderboard",
    description:
      "The GradeThread top-referrers leaderboard — members who share GradeThread and earn grade credits when friends join and qualify.",
    changefreq: "daily",
    priority: 0.3,
  },
  {
    // US-291: human-readable HTML sitemap — one in-site hop to every public page,
    // so the long programmatic tail (glossary spokes, comparisons, platform
    // standards, guides) is reachable by crawlers via internal links, not only
    // the XML sitemap. Derives its links from this same registry.
    path: "/sitemap",
    title: "Sitemap",
    description:
      "Every public GradeThread page in one place — the grading standard and glossary, marketplace comparisons, reselling guides, free tools, and data reports.",
    changefreq: "weekly",
    priority: 0.3,
  },
  // Condition-grading glossary hub (US-303): one page per grade tier + factor,
  // generated from src/lib/constants.ts. Spokes off the /condition-grading
  // pillar; auto-flow into the manifest/sitemap/IndexNow/prerender.
  ...glossaryRoutes(),
  // Reseller condition-vocabulary glossary (US-1671): hub + one DefinedTerm page
  // per term (EUC, VGUC, NWT vs NWOT, death pile, comps, SNAD…). Auto-flow into
  // the manifest/sitemap/IndexNow/prerender like the tier/factor spokes above.
  ...resellerGlossaryRoutes(),
  // FlipDesk conversion landing pages (US-1675 money + US-1676 feature):
  // /flipdesk/{inventory-management,autolister,crosslisting,comps,bookkeeping}.
  ...flipdeskLandingRoutes(),
  // Reselling pillar + TOFU guides (US-1688): /reselling + /reselling/<slug>.
  ...resellingRoutes(),
  // Flaw library pSEO (US-1683), moved to /care by US-9012: hub + /care/<flaw>.
  ...flawLibraryRoutes(),
  // US-9014: the flaw-crossed-with-fabric matrix, /care/<flaw>/<fabric>. 18
  // pages out of a possible 192, because a combination only earns a URL when
  // the procedure genuinely differs from the parent's.
  ...careMatrixRoutes(),
  // Garment-type grading guides pSEO (US-1682): /grading/guides hub + per garment.
  ...garmentGuideRoutes(),
  // Marketplace comparison hub + pages (US-1667): /compare + /compare/{a}-vs-{b}.
  ...comparisonRoutes(),
  // Opportunist mid-tail eBay guides (US-1668).
  ...opportunistRoutes(),
  // The returns spine (US-1673): the reselling↔grading crossover page.
  returnsSpineRoute(),
  // Platform condition-standard pages (US-1672): hub + per-marketplace spokes.
  ...platformStandardsRoutes(),
  // Consumer where-to-sell mega-guide (US-1693).
  whereToSellRoute(),
  // Best crosslisting apps listicle (US-1686).
  crosslistAppsRoute(),
  // Bottom-funnel competitor alternative pages: /reselling/{competitor}-alternative.
  // Brand-modifier queries ("vendoo alternative") are the highest commercial
  // intent available to us and the roundup above does not rank for them.
  ...competitorAlternativeRoutes(),
  // US-9209: what a switch from Vendoo or List Perfectly actually moves.
  ...switchFromRoutes(),
  // US-9214: one page per marketplace pair that earned impressions.
  ...crosslistPairRoutes(),
  // Free printable condition chart (US-1678).
  conditionChartRoute(),
  changelogRoute(),
  // Free grade-checker tool (US-1687).
  gradeCheckerRoute(),
  // Free RN number lookup + tag reader (US-9033). A named tool noun, which the
  // 2026-08-28 SERP audit found is the query shape that still returns links.
  rnLookupRoute(),
  // Free authenticity-check tool (US-1771).
  authenticityCheckRoute(),
  // Free fit-checker tool (US-1780).
  fitCheckerRoute(),
  // The calculator family (US-9002): the hub, plus every calculator whose
  // compute has shipped. Tool pages are the highest-converting surface on the
  // site by an order of magnitude -- see the note at the top of calculators.ts.
  ...calculatorRoutes(),
  // Brand-partner pitch landing (US-1788).
  forBrandsRoute(),
];

// US-427: per-route social share image (Open Graph / Twitter). High-value
// marketing routes get a DISTINCT 1200×630 PNG with a route-specific headline,
// built at deploy time by scripts/generate-og-image.mjs into public/social/<name>.png.
// They live under /social/ (NOT /og/, which is the Functions-routed namespace for
// the dynamic cert/blog/verified OG images) so they're always served as plain
// static assets. Every entry's `file` MUST exist under public/ — enforced by
// src/lib/seo/__tests__/og-images.test.ts so we never emit an og:image that 404s.
// Routes not listed fall back to the site-wide /og-image.png. ALL images are
// 1200×630, so OG_IMAGE_WIDTH/HEIGHT below apply to every variant.
// OG_IMAGE_WIDTH/HEIGHT/TYPE and the DEFAULT_OG_IMAGE_* pair now live in
// ./site.ts (re-exported above).

export const ROUTE_OG_IMAGES: Record<string, { file: string; alt: string }> = {
  // US-9211: the product page shares as itself rather than as the site
  // default, which is what every grading pillar already did.
  "/flipdesk": {
    file: "/social/flipdesk.png",
    alt: "FlipDesk by GradeThread — list everywhere from one place, with a verifiable condition grade on every listing.",
  },
  "/how-it-works": {
    file: "/social/how-it-works.png",
    alt: "How GradeThread grades pre-owned clothing across five weighted factors.",
  },
  "/pricing": {
    file: "/social/pricing.png",
    alt: "GradeThread pricing — a free plan, pay-per-grade tiers, and FlipDesk subscriptions.",
  },
  "/for-resellers": {
    file: "/social/for-resellers.png",
    alt: "GradeThread for resellers — standardized condition grades that build buyer trust.",
  },
  "/condition-grading": {
    file: "/social/condition-grading.png",
    alt: "A guide to clothing condition grading: the 1.0–10.0 scale, seven tiers, five factors.",
  },
  "/grading-standard": {
    file: "/social/grading-standard.png",
    alt: "The GradeThread grading standard — a published 1.0–10.0 rubric with confidence scoring.",
  },
  "/transparency": {
    file: "/social/transparency.png",
    alt: "GradeThread's published grading accuracy and AI-vs-human agreement report.",
  },
  "/faq": {
    file: "/social/faq.png",
    alt: "GradeThread FAQ — AI grading, the 1.0–10.0 scale, disputes, certificates, and the API.",
  },
};

/** Absolute og:image URL + alt for a route (per-route image, else site default). */
export function ogImageForRoute(path: string): { url: string; alt: string } {
  const entry = ROUTE_OG_IMAGES[normalizePath(path)];
  return entry
    ? { url: `${SITE_URL}${entry.file}`, alt: entry.alt }
    : { url: `${SITE_URL}${DEFAULT_OG_IMAGE_PATH}`, alt: DEFAULT_OG_IMAGE_ALT };
}


/** Registry entry for a path, or undefined if the route is not registered. */
export function getRouteMeta(path: string): PublicRoute | undefined {
  const norm = normalizePath(path);
  return PUBLIC_ROUTES.find((r) => r.path === norm);
}

