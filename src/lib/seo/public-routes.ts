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
  "/transparency": "2026-06-01",
  "/resale-condition-report": "2026-06-18",
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
  // Legal pages mirror their rendered effectiveDate ("April 1, 2026").
  "/privacy": "2026-04-01",
  "/terms": "2026-04-01",
  "/cookies": "2026-04-01",
  "/acceptable-use": "2026-04-01",
  "/refund": "2026-07-02",
  "/imprint": "2026-07-02",
  "/dpa": "2026-04-01",
  "/subprocessors": "2026-04-01",
  "/dmca": "2026-04-01",
  "/accessibility": "2026-04-01",
  "/status": "2026-06-12",
  "/leaderboard": "2026-06-13",
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
    path: "/flipdesk",
    title: "FlipDesk — eBay Reseller Management",
    description:
      "FlipDesk is GradeThread's eBay reseller suite: grade, comp, list, reprice, and reconcile in one place — with a verifiable condition grade in every listing.",
    changefreq: "monthly",
    priority: 0.8,
  },
  {
    path: "/sell-used-clothes-ebay",
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
      "How the GradeThread condition-grading model is trained and evaluated, what a grade does and doesn't claim, how errors are handled, and where human review fits.",
    changefreq: "monthly",
    priority: 0.7,
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
      "Original GradeThread data on how a garment's condition grade drives buyer return rate, sell-through, and resale value on the standardized 1.0–10.0 scale.",
    changefreq: "weekly",
    priority: 0.8,
    jsonLdType: "Dataset",
  },
  {
    // US-593: buyer-facing "verify this grade" entry point — a no-login lookup
    // that resolves a scanned QR / pasted certificate code to the certificate.
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
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;
export const OG_IMAGE_TYPE = "image/png";
export const DEFAULT_OG_IMAGE_PATH = "/og-image.png";
export const DEFAULT_OG_IMAGE_ALT =
  "GradeThread — objective AI condition grading and verifiable certificates for pre-owned clothing.";

export const ROUTE_OG_IMAGES: Record<string, { file: string; alt: string }> = {
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
