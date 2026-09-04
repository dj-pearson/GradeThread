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
  gradingScaleJsonLd,
  methodologyJsonLd,
  gradedClothingMeaningJsonLd,
  vsAuthenticationJsonLd,
  transparencyJsonLd,
  resaleConditionReportJsonLd,
  verifyJsonLd,
  passportScanJsonLd,
  whatsItWorthJsonLd,
  reduceReturnsJsonLd,
  resellerGuideJsonLd,
  designVsDamageJsonLd,
  resaleValueJsonLd,
  gradingByCategoryJsonLd,
  buyerGuaranteeJsonLd,
  flipdeskJsonLd,
  sellOnEbayJsonLd,
  aboutJsonLd,
  glossaryJsonLd,
  glossaryBreadcrumbItems,
  resellerTermJsonLd,
  resellerTermBreadcrumbItems,
  resellerGlossaryHubJsonLd,
  resellerGlossaryHubBreadcrumbItems,
  flipdeskLandingJsonLd,
  flipdeskLandingBreadcrumbItems,
  resellingPillarJsonLd,
  resellingPillarBreadcrumbItems,
  resellingGuideJsonLd,
  resellingGuideBreadcrumbItems,
  compareHubJsonLd,
  compareHubBreadcrumbItems,
  comparisonJsonLd,
  comparisonBreadcrumbItems,
  opportunistGuideJsonLd,
  opportunistGuideBreadcrumbItems,
  returnsSpineJsonLd,
  returnsSpineBreadcrumbItems,
  platformStandardsHubJsonLd,
  platformStandardsHubBreadcrumbItems,
  platformStandardJsonLd,
  platformStandardBreadcrumbItems,
  whereToSellJsonLd,
  whereToSellBreadcrumbItems,
  crosslistAppsJsonLd,
  crosslistAppsBreadcrumbItems,
  alternativeJsonLd,
  alternativeBreadcrumbItems,
  switchFromJsonLd,
  switchFromBreadcrumbItems,
  crosslistPairJsonLd,
  crosslistPairBreadcrumbItems,
  conditionChartJsonLd,
  conditionChartBreadcrumbItems,
  gradeCheckerJsonLd,
  gradeCheckerBreadcrumbItems,
  flawJsonLd,
  flawBreadcrumbItems,
  flawHubJsonLd,
  flawHubBreadcrumbItems,
  careMatrixJsonLd,
  careMatrixBreadcrumbItems,
  garmentGuideJsonLd,
  guideBreadcrumbItems,
  garmentHubJsonLd,
  guideHubBreadcrumbItems,
  durabilityReportJsonLd,
  authenticityCheckJsonLd,
  fitCheckerJsonLd,
  rnLookupJsonLd,
  calculatorHubJsonLd,
  calculatorJsonLd,
  calculatorBreadcrumbLdItems,
  forBrandsJsonLd,
  downloadsJsonLd,
  forResellersJsonLd,
  developersJsonLd,
  verifiedJsonLd,
} from "@/pages/marketing/marketing-jsonld";
import { getGlossaryEntryByPath } from "@/lib/seo/glossary";
import { resolvePrerenderSeed } from "@/lib/seo/prerender-seed";
import {
  MIN_DURABILITY_COHORTS,
  isPublishableReport,
} from "@/lib/report-thresholds";
import {
  getResellerTermByPath,
  isResellerGlossaryHubPath,
} from "@/lib/seo/reseller-glossary";
import { getFlipdeskLandingByPath } from "@/lib/seo/flipdesk-landing";
import {
  getResellingGuideByPath,
  isResellingPillarPath,
} from "@/lib/seo/reselling-guides";
import {
  getComparisonByPath,
  isCompareHubPath,
} from "@/lib/seo/comparison-guides";
import { getCalculatorByPath } from "@/lib/seo/calculators";
import { getOpportunistGuideByPath } from "@/lib/seo/opportunist-guides";
import { isReturnsSpinePath } from "@/lib/seo/returns-spine";
import {
  getPlatformStandardByPath,
  isPlatformStandardsHubPath,
} from "@/lib/seo/platform-standards";
import { isWhereToSellPath } from "@/lib/seo/where-to-sell";
import { isCrosslistAppsPath } from "@/lib/seo/crosslisting-apps";
import { getAlternativeByPath } from "@/lib/seo/competitor-alternatives";
import { getSwitchFromByPath } from "@/lib/seo/switch-from";
import { getCrosslistPairByPath } from "@/lib/seo/crosslist-pairs";
import { isConditionChartPath } from "@/lib/seo/condition-chart";
import { isGradeCheckerPath } from "@/lib/seo/grade-checker";
import { getFlawByPath, isFlawHubPath } from "@/lib/seo/flaw-library";
import { getMatrixEntryByPath } from "@/lib/seo/care-matrix";
import { getGuideByPath, isGuideHubPath } from "@/lib/seo/garment-guides";
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
  // US-2105 AC1: these four shipped only Organization + BreadcrumbList.
  "/for-brands": forBrandsJsonLd,
  // US-3111: three SoftwareApplication entries + the download FAQ.
  "/download": downloadsJsonLd,
  "/for-resellers": forResellersJsonLd,
  "/developers": developersJsonLd,
  "/verified": verifiedJsonLd,
  "/faq": faqJsonLd,
  "/condition-grading": conditionGradingJsonLd,
  "/grading-standard": gradingStandardJsonLd,
  // US-1664 (SEO 2.0 keystone): DefinedTermSet (the named scale) + FAQPage.
  "/grading/scale": gradingScaleJsonLd,
  // US-1677 (E-E-A-T): methodology page (Article + FAQPage).
  "/grading/methodology": methodologyJsonLd,
  // US-1684: disambiguation pages (Article + FAQPage).
  "/grading/graded-clothing-meaning": gradedClothingMeaningJsonLd,
  "/grading/vs-authentication": vsAuthenticationJsonLd,
  "/transparency": transparencyJsonLd,
  // US-976: public "State of Resale Condition" data report (Dataset + Article +
  // FAQPage). Deterministic JSON-LD so prerender == SPA (parity test covers it).
  "/resale-condition-report": resaleConditionReportJsonLd,
  // US-2044: /state-of-durability shipped its Dataset markup to the SPA ONLY.
  // It is the flagship ORIGINAL-DATA asset — precisely the surface that earns
  // AI-answer citations — and every non-JS crawler (Google's HTML pass, GPTBot,
  // ClaudeBot, PerplexityBot) saw an undifferentiated marketing page. Its
  // sibling report above was wired; this one was missed.
  "/state-of-durability": durabilityReportJsonLd,
  // US-2044: both free-tool calculators lost WebApplication + FAQPage the same
  // way. Free tools are the highest-intent acquisition surface and the most
  // likely to be recommended by an AI assistant — WebApplication is what makes
  // that machine-readable. The third tool (/tools/grade-checker) was wired,
  // which is what made these two easy to miss.
  "/tools/authenticity-check": authenticityCheckJsonLd,
  "/tools/fit-checker": fitCheckerJsonLd,
  // US-9033: same omission, same reason it was easy to miss — the route
  // declared WebApplication in PUBLIC_ROUTES and the page rendered it via
  // <SEO>, so both halves looked done and only the prerenderer was blind.
  "/tools/rn-lookup": rnLookupJsonLd,
  // US-9002/9007: the calculator hub. Individual calculators resolve through
  // the registry in jsonLdForRoute() rather than being listed one by one.
  "/tools/calculators": calculatorHubJsonLd,
  "/verify": verifyJsonLd,
  // US-1106: buyer-facing passport lookup (HowTo + FAQPage).
  "/scan": passportScanJsonLd,
  "/whats-it-worth": whatsItWorthJsonLd,
  // Cornerstone pillar pages (US-855): Article + FAQPage.
  "/reduce-returns": reduceReturnsJsonLd,
  "/reseller-grading-guide": resellerGuideJsonLd,
  "/design-vs-damage": designVsDamageJsonLd,
  "/resale-value-by-condition": resaleValueJsonLd,
  "/grading-by-category": gradingByCategoryJsonLd,
  // US-867: buyer trust guarantee policy (Article + FAQPage).
  "/buyer-guarantee": buyerGuaranteeJsonLd,
  "/flipdesk": flipdeskJsonLd,
  "/sell-used-clothes-ebay": sellOnEbayJsonLd,
  // US-868: company/about page (AboutPage + FAQPage).
  "/about": aboutJsonLd,
};

/** JSON-LD nodes for a given route. Mirrors what each page renders via <SEO>. */
export function jsonLdForRoute(path: string): JsonLd[] {
  if (path === "/") {
    return [organizationLd(), webSiteLd(), softwareApplicationLd(), faqPageLd(LANDING_FAQS)];
  }
  const route = PUBLIC_ROUTES.find((r) => r.path === path);
  if (!route) return [];
  // FlipDesk landing pages (US-1675/1676): Organization + 3-level breadcrumb +
  // SoftwareApplication + FAQPage, matching the live landing page.
  const flipdeskLanding = getFlipdeskLandingByPath(path);
  if (flipdeskLanding) {
    return [
      organizationLd(),
      breadcrumbLd(flipdeskLandingBreadcrumbItems(flipdeskLanding)),
      ...flipdeskLandingJsonLd(flipdeskLanding),
    ];
  }
  // The calculator family (US-9002): Organization + 3-level breadcrumb +
  // WebApplication + FAQPage, resolved from the registry rather than a
  // hand-listed path map, so a new calculator gets its markup for free.
  const calc = getCalculatorByPath(path);
  if (calc) {
    return [
      organizationLd(),
      breadcrumbLd(calculatorBreadcrumbLdItems(calc)),
      ...calculatorJsonLd(calc),
    ];
  }
  // Reselling pillar (US-1688): Organization + 2-level breadcrumb + HowTo + FAQ.
  if (isResellingPillarPath(path)) {
    return [
      organizationLd(),
      breadcrumbLd(resellingPillarBreadcrumbItems()),
      ...resellingPillarJsonLd(),
    ];
  }
  // Reselling guide (US-1688): Organization + 3-level breadcrumb + Article + FAQ.
  const resellingGuide = getResellingGuideByPath(path);
  if (resellingGuide) {
    return [
      organizationLd(),
      breadcrumbLd(resellingGuideBreadcrumbItems(resellingGuide)),
      ...resellingGuideJsonLd(resellingGuide),
    ];
  }
  // Returns spine (US-1673): Organization + 3-level breadcrumb + Article + FAQ.
  if (isReturnsSpinePath(path)) {
    return [
      organizationLd(),
      breadcrumbLd(returnsSpineBreadcrumbItems()),
      ...returnsSpineJsonLd(),
    ];
  }
  // Platform condition-standards (US-1672). Under /grading/ — matched BEFORE the
  // glossary lookup below. Hub = Organization + 3-level breadcrumb; spoke adds
  // Article + FAQ.
  if (isPlatformStandardsHubPath(path)) {
    return [
      organizationLd(),
      breadcrumbLd(platformStandardsHubBreadcrumbItems()),
      ...platformStandardsHubJsonLd(),
    ];
  }
  const platformStandard = getPlatformStandardByPath(path);
  if (platformStandard) {
    return [
      organizationLd(),
      breadcrumbLd(platformStandardBreadcrumbItems(platformStandard)),
      ...platformStandardJsonLd(platformStandard),
    ];
  }
  // Printable condition chart (US-1678). Under /grading/ — before the glossary
  // lookup. Organization + 3-level breadcrumb + Article.
  if (isConditionChartPath(path)) {
    return [
      organizationLd(),
      breadcrumbLd(conditionChartBreadcrumbItems()),
      ...conditionChartJsonLd(),
    ];
  }
  // Opportunist mid-tail guides (US-1668): Organization + 3-level breadcrumb +
  // HowTo + Article + FAQ. Checked before the reselling-guide lookup is moot
  // (these paths aren't in RESELLING_GUIDES) but explicit for clarity.
  const opportunist = getOpportunistGuideByPath(path);
  if (opportunist) {
    return [
      organizationLd(),
      breadcrumbLd(opportunistGuideBreadcrumbItems(opportunist)),
      ...opportunistGuideJsonLd(opportunist),
    ];
  }
  // Free grade-checker tool (US-1687): Organization + 3-level breadcrumb +
  // WebApplication + FAQ.
  if (isGradeCheckerPath(path)) {
    return [
      organizationLd(),
      breadcrumbLd(gradeCheckerBreadcrumbItems()),
      ...gradeCheckerJsonLd(),
    ];
  }
  // Where-to-sell mega-guide (US-1693): Organization + 2-level breadcrumb +
  // Article + ItemList + FAQ.
  if (isWhereToSellPath(path)) {
    return [
      organizationLd(),
      breadcrumbLd(whereToSellBreadcrumbItems()),
      ...whereToSellJsonLd(),
    ];
  }
  // Best crosslisting apps listicle (US-1686): under /reselling/, matched before
  // the reselling-guide lookup. Organization + 3-level breadcrumb + Article +
  // ItemList + FAQ.
  if (isCrosslistAppsPath(path)) {
    return [
      organizationLd(),
      breadcrumbLd(crosslistAppsBreadcrumbItems()),
      ...crosslistAppsJsonLd(),
    ];
  }
  // Competitor alternative pages: also under /reselling/, so likewise matched
  // BEFORE the reselling-guide lookup below or that would claim them.
  // Organization + 3-level breadcrumb + Article + ItemList + FAQ.
  // US-9209: switch-from pages, also under /reselling/, matched here for the
  // same reason. Organization + 3-level breadcrumb + Article + FAQ.
  // US-9214: crosslist pair pages, also under /reselling/, matched before the
  // guide lookup for the same reason.
  const pair = getCrosslistPairByPath(path);
  if (pair) {
    return [
      organizationLd(),
      breadcrumbLd(crosslistPairBreadcrumbItems(pair)),
      ...crosslistPairJsonLd(pair),
    ];
  }
  const switchFrom = getSwitchFromByPath(path);
  if (switchFrom) {
    return [
      organizationLd(),
      breadcrumbLd(switchFromBreadcrumbItems(switchFrom)),
      ...switchFromJsonLd(switchFrom),
    ];
  }
  const alternative = getAlternativeByPath(path);
  if (alternative) {
    return [
      organizationLd(),
      breadcrumbLd(alternativeBreadcrumbItems(alternative)),
      ...alternativeJsonLd(alternative),
    ];
  }
  // Comparison hub (US-1667): Organization + 2-level breadcrumb (no extra LD).
  if (isCompareHubPath(path)) {
    return [
      organizationLd(),
      breadcrumbLd(compareHubBreadcrumbItems()),
      ...compareHubJsonLd(),
    ];
  }
  // Comparison page (US-1667): Organization + 3-level breadcrumb + Article + FAQ.
  const comparison = getComparisonByPath(path);
  if (comparison) {
    return [
      organizationLd(),
      breadcrumbLd(comparisonBreadcrumbItems(comparison)),
      ...comparisonJsonLd(comparison),
    ];
  }
  // Flaw library hub (US-1683): Organization + 2-level breadcrumb +
  // DefinedTermSet + FAQ.
  if (isFlawHubPath(path)) {
    return [
      organizationLd(),
      breadcrumbLd(flawHubBreadcrumbItems()),
      ...flawHubJsonLd(),
    ];
  }
  // US-9014: a flaw-and-fibre page. Checked BEFORE the flaw page, because
  // /care/stains-general/silk must not be mistaken for the parent.
  const matrixEntry = getMatrixEntryByPath(path);
  if (matrixEntry) {
    return [
      organizationLd(),
      breadcrumbLd(careMatrixBreadcrumbItems(matrixEntry)),
      ...careMatrixJsonLd(matrixEntry),
    ];
  }
  // Flaw page (US-1683): Organization + 3-level breadcrumb + Article +
  // DefinedTerm + FAQ.
  const flaw = getFlawByPath(path);
  if (flaw) {
    return [
      organizationLd(),
      breadcrumbLd(flawBreadcrumbItems(flaw)),
      ...flawJsonLd(flaw),
    ];
  }
  // Garment guides hub (US-1682): Organization + 2-level breadcrumb + FAQ.
  if (isGuideHubPath(path)) {
    return [
      organizationLd(),
      breadcrumbLd(guideHubBreadcrumbItems()),
      ...garmentHubJsonLd(),
    ];
  }
  // Garment guide (US-1682): Organization + 3-level breadcrumb + HowTo + FAQ.
  const guide = getGuideByPath(path);
  if (guide) {
    return [
      organizationLd(),
      breadcrumbLd(guideBreadcrumbItems(guide)),
      ...garmentGuideJsonLd(guide),
    ];
  }
  // Reseller glossary hub (US-1671): Organization + 2-level breadcrumb +
  // DefinedTermSet + hub FAQ, matching what the live hub page emits.
  if (isResellerGlossaryHubPath(path)) {
    return [
      organizationLd(),
      breadcrumbLd(resellerGlossaryHubBreadcrumbItems()),
      ...resellerGlossaryHubJsonLd(),
    ];
  }
  // Reseller glossary term page (US-1671): Organization + 3-level breadcrumb +
  // DefinedTerm + term FAQ.
  const resellerTerm = getResellerTermByPath(path);
  if (resellerTerm) {
    return [
      organizationLd(),
      breadcrumbLd(resellerTermBreadcrumbItems(resellerTerm)),
      ...resellerTermJsonLd(resellerTerm),
    ];
  }
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
/**
 * US-2098: is this a report page whose dataset is too thin to publish?
 *
 * Reads the SAME build-time seed the page body renders from (scripts/prerender.mjs
 * fetches it into setPrerenderSeed before rendering), so the crawler-facing
 * <head> and the crawler-facing <body> cannot disagree about whether a finding
 * exists.
 *
 * Fails CLOSED: if the seed is absent we cannot show a report either, so
 * noindex is the correct answer rather than indexing an unknown.
 */
function reportIsUnpublishable(path: string): boolean {
  if (path !== "/state-of-durability") return false;
  const seed = resolvePrerenderSeed<{
    sample?: { sufficient_cohorts?: number };
  }>("durability-report");
  return !isPublishableReport(
    seed?.sample?.sufficient_cohorts,
    MIN_DURABILITY_COHORTS,
  );
}

export function buildHeadTags(route: PublicRoute): string {
  // US-9008: a route may point its canonical at a different URL when two
  // pages serve one intent. Falls back to its own path, which is every other
  // route in the registry.
  const canonical = absoluteUrl(route.canonicalPath ?? route.path);
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
    // index,follow + explicit rich-result allowances: large image thumbnails,
    // unlimited text snippets, and full video previews. Lets Google show the
    // richest SERP card and gives AI answer-engines permission to extract longer
    // passages (GEO). Applies to every prerendered (public, indexable) route.
    //
    // US-2098: EXCEPT a data-report page whose dataset is below the publishable
    // threshold. This has to happen HERE, not only in the page's <SEO>:
    // react-helmet-async v3 renders no server-side head, so a noindex set in the
    // SPA reaches humans and never reaches a crawler — which is precisely
    // backwards for a page we are trying to keep OUT of the index.
    reportIsUnpublishable(route.path)
      ? `<meta name="robots" content="noindex, follow">`
      : `<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">`,
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
