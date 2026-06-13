// Deterministic <head> builder for the build-time prerender (US-292).
//
// Why not react-helmet-async? The v3 fork in use renders NOTHING server-side
// (its SSR `context.helmet` sink comes back empty) and injects no <script>
// client-side either — verified directly. So the crawlable <head> for each
// static route is assembled here from the route registry + JSON-LD builders,
// which is the same data the client <SEO> component uses. Humans still get the
// full hydrated SPA (and the runtime useEffect JSON-LD); crawlers get this.

import {
  PUBLIC_ROUTES,
  SITE_URL,
  absoluteUrl,
  ogImageForRoute,
  OG_IMAGE_WIDTH,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_TYPE,
  type PublicRoute,
} from "@/lib/seo/public-routes";
import {
  organizationLd,
  webSiteLd,
  softwareApplicationLd,
  faqPageLd,
  breadcrumbLd,
  type JsonLd,
} from "@/lib/seo/json-ld";
import { LANDING_FAQS } from "@/pages/landing-faqs";
import {
  howItWorksJsonLd,
  pricingJsonLd,
  faqJsonLd,
  conditionGradingJsonLd,
  gradingStandardJsonLd,
  transparencyJsonLd,
  verifyJsonLd,
  whatsItWorthJsonLd,
  glossaryJsonLd,
  glossaryBreadcrumbItems,
} from "@/pages/marketing/marketing-jsonld";
import { getGlossaryEntryByPath } from "@/lib/seo/glossary";
import { twitterSiteHandle, twitterCreatorHandle } from "@/lib/seo/social";

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The <SEO> component renders react-helmet-async <Helmet> children, and this
// fork emits those tags INLINE into the SSR body instead of collecting them
// into a head sink. <title>/<meta>/<link rel=canonical> are never valid inside
// <body>, and the canonical <head> is built separately by buildHeadTags(), so
// strip the SEO tags from the rendered body before injecting it. (The client
// re-adds them correctly after mount.)
export function stripHeadTagsFromBody(body: string): string {
  return body
    .replace(/<title>[\s\S]*?<\/title>/gi, "")
    // Only the SEO meta tags the component emits — leave other markup alone.
    .replace(
      /<meta\b[^>]*?\b(?:name="(?:description|robots|keywords|twitter:[^"]*)"|property="og:[^"]*")[^>]*?>/gi,
      "",
    )
    .replace(/<link\b[^>]*?\brel="canonical"[^>]*?>/gi, "");
}

// Per-route page JSON-LD beyond the shared Organization + BreadcrumbList.
// Imported from the page modules so the prerendered HTML carries IDENTICAL
// structured data to what the live page injects at runtime (no drift).
const MARKETING_LD: Record<string, () => JsonLd[]> = {
  "/how-it-works": howItWorksJsonLd,
  "/pricing": pricingJsonLd,
  "/faq": faqJsonLd,
  "/condition-grading": conditionGradingJsonLd,
  "/grading-standard": gradingStandardJsonLd,
  "/transparency": transparencyJsonLd,
  "/verify": verifyJsonLd,
  "/whats-it-worth": whatsItWorthJsonLd,
};

/** JSON-LD nodes for a given route. Mirrors what each page renders via <SEO>. */
export function jsonLdForRoute(path: string): JsonLd[] {
  if (path === "/") {
    return [organizationLd(), webSiteLd(), softwareApplicationLd(), faqPageLd(LANDING_FAQS)];
  }
  const route = PUBLIC_ROUTES.find((r) => r.path === path);
  if (!route) return [];
  // Glossary pages (US-303) carry a 3-level breadcrumb back to the pillar plus
  // an FAQPage — built from the SAME helpers the live page passes to its layout,
  // so prerendered and runtime structured data stay identical.
  const glossary = getGlossaryEntryByPath(path);
  if (glossary) {
    // Mirror the live glossary page exactly (US-423): MarketingLayout emits
    // Organization + the 3-level BreadcrumbList (via its `breadcrumbs` prop),
    // and glossaryJsonLd adds the FAQPage. Emit the breadcrumb here too so the
    // prerendered head matches — and so it appears exactly once.
    return [
      organizationLd(),
      breadcrumbLd(glossaryBreadcrumbItems(glossary)),
      ...glossaryJsonLd(glossary),
    ];
  }
  // Every other non-home page (legal + marketing) renders Organization + a
  // 2-level breadcrumb via its layout; marketing pages add page-type schema.
  const base: JsonLd[] = [
    organizationLd(),
    breadcrumbLd([
      { name: "GradeThread", url: `${SITE_URL}/` },
      { name: route.title, url: absoluteUrl(path) },
    ]),
  ];
  const extra = MARKETING_LD[path]?.() ?? [];
  return [...base, ...extra];
}

/** Full <head> inner HTML (meta + canonical + OG/Twitter + JSON-LD) for a route. */
export function buildHeadTags(route: PublicRoute): string {
  const canonical = absoluteUrl(route.path);
  const fullTitle =
    route.path === "/"
      ? "GradeThread - The Standard for Clothing Condition Grading"
      : `${route.title} | GradeThread`;
  const desc = escapeAttr(route.description);
  const title = escapeAttr(fullTitle);

  const ld = jsonLdForRoute(route.path)
    .map(
      (obj) =>
        `<script type="application/ld+json" data-seo-jsonld="true">${JSON.stringify(
          obj,
        ).replace(/</g, "\\u003c")}</script>`,
    )
    .join("\n    ");

  // US-308 verification tags. process.env is read at build time by the
  // prerender script (Node), parallel to import.meta.env in the SPA bundle.
  const verifyGoogle = process.env.VITE_GOOGLE_SITE_VERIFICATION ?? "";
  const verifyBing = process.env.VITE_BING_SITE_VERIFICATION ?? "";

  // US-427: per-route distinct OG image (falls back to the site-wide default),
  // with explicit dimensions/type/alt so unfurls render the card immediately
  // (no pre-fetch round-trip) and stay accessible.
  const og = ogImageForRoute(route.path);
  const ogImage = escapeAttr(og.url);
  const ogAlt = escapeAttr(og.alt);

  // US-428: brand X/Twitter handles, config-driven (empty unless set).
  const twitterSite = twitterSiteHandle();
  const twitterCreator = twitterCreatorHandle();

  return [
    `<title>${title}</title>`,
    `<meta name="description" content="${desc}">`,
    `<meta name="robots" content="index, follow">`,
    `<link rel="canonical" href="${escapeAttr(canonical)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${desc}">`,
    `<meta property="og:site_name" content="GradeThread">`,
    `<meta property="og:url" content="${escapeAttr(canonical)}">`,
    `<meta property="og:image" content="${ogImage}">`,
    `<meta property="og:image:secure_url" content="${ogImage}">`,
    `<meta property="og:image:type" content="${OG_IMAGE_TYPE}">`,
    `<meta property="og:image:width" content="${OG_IMAGE_WIDTH}">`,
    `<meta property="og:image:height" content="${OG_IMAGE_HEIGHT}">`,
    `<meta property="og:image:alt" content="${ogAlt}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${desc}">`,
    `<meta name="twitter:image" content="${ogImage}">`,
    `<meta name="twitter:image:alt" content="${ogAlt}">`,
    // US-428: brand X handle for entity recognition. Mirrors the SPA <SEO>
    // component; emitted only when a real handle is configured (no placeholder).
    twitterSite ? `<meta name="twitter:site" content="${escapeAttr(twitterSite)}">` : "",
    twitterCreator
      ? `<meta name="twitter:creator" content="${escapeAttr(twitterCreator)}">`
      : "",
    verifyGoogle
      ? `<meta name="google-site-verification" content="${escapeAttr(verifyGoogle)}">`
      : "",
    verifyBing
      ? `<meta name="msvalidate.01" content="${escapeAttr(verifyBing)}">`
      : "",
    ld,
  ]
    .filter(Boolean)
    .join("\n    ");
}
