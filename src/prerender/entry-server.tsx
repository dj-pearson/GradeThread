// SSR entry used only by the build-time prerender (US-292). It renders a single
// public route's React tree to a static HTML body string. The prerender script
// (scripts/prerender.mjs) loads this via Vite's SSR pipeline, injects the body
// + the registry-driven <head> (head-builder.ts) into the built index.html
// template, and writes dist/<route>/index.html.
//
// No browser is required, and this is not cloaking: the SAME prerendered HTML is
// served to every visitor. On the client, main.tsx mounts with createRoot (not
// hydrateRoot), so React simply re-renders over the static shell into the live
// SPA — no hydration-mismatch warnings.
//
// We render each public page directly inside a StaticRouter (giving <Link> its
// context) rather than through the lazy app router. The pages already carry
// their own chrome (landing has its header/footer; legal pages use LegalLayout),
// and RootLayout only adds the Toaster + dialogs + cookie banner, which all
// render nothing meaningful server-side. This keeps the SSR bundle free of the
// auth/dashboard/supabase graph.

import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router";
import { HelmetProvider } from "react-helmet-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { LandingPage } from "@/pages/landing";
import { PrivacyPage } from "@/pages/legal/privacy";
import { TermsPage } from "@/pages/legal/terms";
import { CookiesPage } from "@/pages/legal/cookies";
import { AcceptableUsePage } from "@/pages/legal/acceptable-use";
import { RefundPage } from "@/pages/legal/refund";
import { AccountDeletionPage } from "@/pages/legal/account-deletion";
import { ImprintPage } from "@/pages/legal/imprint";
import { DpaPage } from "@/pages/legal/dpa";
import { SubprocessorsPage } from "@/pages/legal/subprocessors";
import { DmcaPage } from "@/pages/legal/dmca";
import { TrademarksPage } from "@/pages/legal/trademarks";
import { AccessibilityPage } from "@/pages/legal/accessibility";
import { HowItWorksPage } from "@/pages/marketing/how-it-works";
import { PricingPage } from "@/pages/marketing/pricing";
import { ForResellersPage } from "@/pages/marketing/for-resellers";
import { FlipDeskPage } from "@/pages/marketing/flipdesk";
import { PartnersPage } from "@/pages/marketing/partners";
import { SellUsedClothesEbayPage } from "@/pages/marketing/sell-used-clothes-ebay";
import { FaqPage } from "@/pages/marketing/faq";
import { ConditionGradingPage } from "@/pages/marketing/condition-grading";
import { GradingStandardPage } from "@/pages/marketing/grading-standard";
import { GradingScalePage } from "@/pages/marketing/grading-scale";
import { GradingMethodologyPage } from "@/pages/marketing/grading-methodology";
import {
  GradedClothingMeaningPage,
  VsAuthenticationPage,
} from "@/pages/marketing/grading-disambiguation";
import { TransparencyPage } from "@/pages/marketing/transparency";
import { ResaleConditionReportPage } from "@/pages/marketing/resale-condition-report";
import { StateOfDurabilityPage } from "@/pages/marketing/state-of-durability";
import { VerifyGradePage } from "@/pages/marketing/verify";
import { StyleCodeLookupPage } from "@/pages/marketing/style-code-lookup";
import { PassportScanPage } from "@/pages/marketing/passport-scan";
import { DevelopersPage } from "@/pages/marketing/developers";
import { WhatsItWorthPage } from "@/pages/marketing/whats-it-worth";
import { BuyerGuaranteePage } from "@/pages/marketing/buyer-guarantee";
import { AboutPage } from "@/pages/marketing/about";
import { ReduceReturnsPage } from "@/pages/marketing/reduce-returns";
import { ResellerGradingGuidePage } from "@/pages/marketing/reseller-grading-guide";
import { DesignVsDamagePage } from "@/pages/marketing/design-vs-damage";
import { ResaleValueByConditionPage } from "@/pages/marketing/resale-value-by-condition";
import { GradingByCategoryPage } from "@/pages/marketing/grading-by-category";
import { GradingGlossaryPage } from "@/pages/marketing/grading-glossary";
import {
  ResellerGlossaryHubPage,
  ResellerGlossaryTermPage,
} from "@/pages/marketing/reseller-glossary";
import { HtmlSitemapPage } from "@/pages/marketing/sitemap";
import { VerifiedDirectoryPage } from "@/pages/verified-directory";
import { StatusPage } from "@/pages/status";
import { ReferralLeaderboardPage } from "@/pages/referral-leaderboard";
import { GLOSSARY_ENTRIES } from "@/lib/seo/glossary";
import {
  RESELLER_TERMS,
  RESELLER_GLOSSARY_HUB_PATH,
  resellerTermPath,
} from "@/lib/seo/reseller-glossary";
import { FLIPDESK_LANDINGS } from "@/lib/seo/flipdesk-landing";
import { FlipdeskLandingPage } from "@/pages/marketing/flipdesk-landing";
import {
  RESELLING_PILLAR_PATH,
  RESELLING_GUIDES,
  resellingGuidePath,
} from "@/lib/seo/reselling-guides";
import {
  ResellingPillarPage,
  ResellingGuidePage,
} from "@/pages/marketing/reselling";
import {
  FLAW_ENTRIES,
  FLAW_LIBRARY_HUB_PATH,
  flawPath,
} from "@/lib/seo/flaw-library";
import {
  FlawLibraryHubPage,
  FlawPage,
} from "@/pages/marketing/flaw-library";
import { CARE_MATRIX, matrixPath } from "@/lib/seo/care-matrix";
import { CareMatrixPage } from "@/pages/marketing/care-matrix";
import {
  GARMENT_GUIDES,
  GARMENT_GUIDES_HUB_PATH,
  guidePath,
} from "@/lib/seo/garment-guides";
import {
  GarmentGuidesHubPage,
  GarmentGuidePage,
} from "@/pages/marketing/garment-guides";
import {
  COMPARE_HUB_PATH,
  COMPARISONS,
  comparePath,
} from "@/lib/seo/comparison-guides";
import { CompareHubPage, ComparisonPage } from "@/pages/marketing/compare";
import { OPPORTUNIST_GUIDES } from "@/lib/seo/opportunist-guides";
import { OpportunistGuidePage } from "@/pages/marketing/opportunist-guide";
import { RETURNS_SPINE_PATH } from "@/lib/seo/returns-spine";
import { ReduceEbayReturnsPage } from "@/pages/marketing/reduce-ebay-returns";
import {
  PLATFORM_STANDARDS,
  PLATFORM_STANDARDS_HUB_PATH,
  platformStandardPath,
} from "@/lib/seo/platform-standards";
import {
  PlatformStandardsHubPage,
  PlatformStandardPage,
} from "@/pages/marketing/platform-standards";
import { WHERE_TO_SELL_PATH } from "@/lib/seo/where-to-sell";
import { WhereToSellPage } from "@/pages/marketing/where-to-sell";
import { CROSSLIST_APPS_PATH } from "@/lib/seo/crosslisting-apps";
import { CrosslistingAppsPage } from "@/pages/marketing/crosslisting-apps";
import {
  COMPETITOR_ALTERNATIVES,
  alternativePath,
} from "@/lib/seo/competitor-alternatives";
import { CompetitorAlternativePage } from "@/pages/marketing/competitor-alternative";
import { SWITCH_FROM_PAGES, switchFromPath } from "@/lib/seo/switch-from";
import { SwitchFromPageView } from "@/pages/marketing/switch-from";
import { CROSSLIST_PAIRS, crosslistPairPath } from "@/lib/seo/crosslist-pairs";
import { CrosslistPairPage } from "@/pages/marketing/crosslist-pair";
import { CONDITION_CHART_PATH } from "@/lib/seo/condition-chart";
import { CHANGELOG_PATH } from "@/lib/seo/changelog";
import { ConditionChartPage } from "@/pages/marketing/condition-chart";
import { ChangelogPage } from "@/pages/marketing/changelog";
import { GRADE_CHECKER_PATH } from "@/lib/seo/grade-checker";
import { GradeCheckerPage } from "@/pages/tools/grade-checker";
import { RN_LOOKUP_PATH } from "@/lib/seo/rn-lookup";
import { RnLookupPage } from "@/pages/tools/rn-lookup";
import { AUTHENTICITY_CHECK_PATH } from "@/lib/seo/authenticity-check";
import { AuthenticityCheckPage } from "@/pages/tools/authenticity-check";
import { FIT_CHECKER_PATH } from "@/lib/seo/fit-checker";
import { FitCheckerPage } from "@/pages/tools/fit-checker";
import {
  CALCULATOR_HUB_PATH,
  calculatorPageModule,
  calculatorPath,
  liveCalculators,
} from "@/lib/seo/calculators";
import { CalculatorHubPage } from "@/pages/tools/calculators";
import { MeasurementConverterPage } from "@/pages/tools/measurement-converter";
import { EbayFeeCalculatorPage } from "@/pages/tools/ebay-fee-calculator";
import { EbayShippingCalculatorPage } from "@/pages/tools/ebay-shipping-calculator";
import {
  PoshmarkFeeCalculatorPage,
  MercariFeeCalculatorPage,
  DepopFeeCalculatorPage,
  EtsyFeeCalculatorPage,
} from "@/pages/tools/marketplace-fee-calculator";
import { ResellerProfitCalculatorPage } from "@/pages/tools/reseller-profit-calculator";
import { EbaySoldListingsPage } from "@/pages/tools/ebay-sold-listings";
import { SingleStitchDatingPage } from "@/pages/tools/single-stitch-dating";
import { ResellerInventorySpreadsheetPage } from "@/pages/tools/reseller-inventory-spreadsheet";
import { PhotographClothesToSellPage } from "@/pages/tools/photograph-clothes-to-sell";
import { FOR_BRANDS_PATH } from "@/lib/seo/for-brands";
import { ForBrandsPage } from "@/pages/marketing/for-brands";
import { DOWNLOAD_PATH } from "@/lib/seo/downloads";
import { DownloadPage } from "@/pages/marketing/download";

// Static map of prerenderable routes → page element.
// US-9002: slug -> page element for the calculator family. Kept beside the
// registry rather than inline in PAGES so that adding a calculator is one entry
// here and one status flip in calculators.ts, and forgetting either one fails
// the lockstep guard below rather than shipping a blank route.
const CALCULATOR_PAGES: Record<string, React.ReactNode> = {
  "measurement-converter": <MeasurementConverterPage />,
  "ebay-fee-calculator": <EbayFeeCalculatorPage />,
  "ebay-shipping-calculator": <EbayShippingCalculatorPage />,
  "poshmark-fee-calculator": <PoshmarkFeeCalculatorPage />,
  "mercari-fee-calculator": <MercariFeeCalculatorPage />,
  "depop-fee-calculator": <DepopFeeCalculatorPage />,
  "etsy-fee-calculator": <EtsyFeeCalculatorPage />,
  "reseller-profit-calculator": <ResellerProfitCalculatorPage />,
  "ebay-sold-listings": <EbaySoldListingsPage />,
  "single-stitch-dating": <SingleStitchDatingPage />,
  "reseller-inventory-spreadsheet": <ResellerInventorySpreadsheetPage />,
  "photograph-clothes-to-sell": <PhotographClothesToSellPage />,
};

const PAGES: Record<string, React.ReactNode> = {
  "/": <LandingPage />,
  "/how-it-works": <HowItWorksPage />,
  "/pricing": <PricingPage />,
  "/for-resellers": <ForResellersPage />,
  "/flipdesk": <FlipDeskPage />,
  "/partners": <PartnersPage />,
  "/sell-used-clothes-ebay": <SellUsedClothesEbayPage />,
  "/faq": <FaqPage />,
  "/condition-grading": <ConditionGradingPage />,
  "/grading-standard": <GradingStandardPage />,
  // US-1664 (SEO 2.0 keystone): the named 1.0–10.0 Grading Scale pillar.
  "/grading/scale": <GradingScalePage />,
  // US-1677 (E-E-A-T): the grading methodology page.
  "/grading/methodology": <GradingMethodologyPage />,
  // US-1684: disambiguation pages.
  "/grading/graded-clothing-meaning": <GradedClothingMeaningPage />,
  "/grading/vs-authentication": <VsAuthenticationPage />,
  "/transparency": <TransparencyPage />,
  // US-976: public "State of Resale Condition" data report. Figures load
  // client-side; the prerendered shell carries the methodology + Dataset JSON-LD.
  "/resale-condition-report": <ResaleConditionReportPage />,
  "/state-of-durability": <StateOfDurabilityPage />,
  // US-291: human HTML sitemap (long-tail internal-link discovery surface).
  "/sitemap": <HtmlSitemapPage />,
  "/verify": <VerifyGradePage />,
  "/style": <StyleCodeLookupPage />,
  // US-1106: buyer-facing "scan before you buy" passport lookup landing.
  "/scan": <PassportScanPage />,
  "/developers": <DevelopersPage />,
  "/whats-it-worth": <WhatsItWorthPage />,
  // US-867: buyer trust guarantee policy page.
  "/buyer-guarantee": <BuyerGuaranteePage />,
  // US-868: company/about page (entity-level authority surface).
  "/about": <AboutPage />,
  // US-863: public verified-seller directory. The seller list loads client-side;
  // the prerendered shell carries the header + metadata.
  "/verified": <VerifiedDirectoryPage />,
  // Cornerstone pillar pages (US-855)
  "/reduce-returns": <ReduceReturnsPage />,
  "/reseller-grading-guide": <ResellerGradingGuidePage />,
  "/design-vs-damage": <DesignVsDamagePage />,
  "/resale-value-by-condition": <ResaleValueByConditionPage />,
  "/grading-by-category": <GradingByCategoryPage />,
  "/privacy": <PrivacyPage />,
  "/terms": <TermsPage />,
  "/cookies": <CookiesPage />,
  "/acceptable-use": <AcceptableUsePage />,
  "/refund": <RefundPage />,
  "/account-deletion": <AccountDeletionPage />,
  "/imprint": <ImprintPage />,
  "/dpa": <DpaPage />,
  "/subprocessors": <SubprocessorsPage />,
  "/dmca": <DmcaPage />,
  "/trademarks": <TrademarksPage />,
  "/accessibility": <AccessibilityPage />,
  // US-500: probes run client-side only (useEffect); SSR emits the checking
  // shell, which the live SPA re-renders over with real component health.
  "/status": <StatusPage />,
  // US-864: opt-in top-referrers leaderboard. The ranked list loads client-side
  // from the public feed; SSR emits the header + metadata shell.
  "/leaderboard": <ReferralLeaderboardPage />,
  // Glossary hub (US-303): the /grading/:slug route resolves its slug from
  // useParams at runtime; here we render each entry with an explicit slug prop
  // since the prerender renders a path directly with no router param match.
  ...Object.fromEntries(
    GLOSSARY_ENTRIES.map((e) => [
      e.path,
      <GradingGlossaryPage key={e.slug} slug={e.slug} />,
    ]),
  ),
  // Reseller condition-vocabulary glossary hub + term pages (US-1671).
  [RESELLER_GLOSSARY_HUB_PATH]: <ResellerGlossaryHubPage />,
  ...Object.fromEntries(
    RESELLER_TERMS.map((t) => [
      resellerTermPath(t.slug),
      <ResellerGlossaryTermPage key={t.slug} slug={t.slug} />,
    ]),
  ),
  // FlipDesk landing pages (US-1675 / US-1676).
  ...Object.fromEntries(
    FLIPDESK_LANDINGS.map((l) => [
      l.path,
      <FlipdeskLandingPage key={l.slug} slug={l.slug} />,
    ]),
  ),
  // Reselling pillar + guides (US-1688).
  [RESELLING_PILLAR_PATH]: <ResellingPillarPage />,
  ...Object.fromEntries(
    RESELLING_GUIDES.map((g) => [
      resellingGuidePath(g.slug),
      <ResellingGuidePage key={g.slug} slug={g.slug} />,
    ]),
  ),
  // US-9014: the flaw-crossed-with-fabric matrix. Each page is resolved from
  // its own path, like the flaw pages, so the prerender renders the right one.
  ...Object.fromEntries(
    CARE_MATRIX.map((e) => [matrixPath(e), <CareMatrixPage path={matrixPath(e)} />]),
  ),
  // Flaw library (US-1683).
  [FLAW_LIBRARY_HUB_PATH]: <FlawLibraryHubPage />,
  ...Object.fromEntries(
    FLAW_ENTRIES.map((f) => [
      flawPath(f.slug),
      <FlawPage key={f.slug} slug={f.slug} />,
    ]),
  ),
  // Garment-type grading guides (US-1682).
  [GARMENT_GUIDES_HUB_PATH]: <GarmentGuidesHubPage />,
  ...Object.fromEntries(
    GARMENT_GUIDES.map((g) => [
      guidePath(g.slug),
      <GarmentGuidePage key={g.slug} slug={g.slug} />,
    ]),
  ),
  // Marketplace comparisons (US-1667).
  [COMPARE_HUB_PATH]: <CompareHubPage />,
  ...Object.fromEntries(
    COMPARISONS.map((c) => [
      comparePath(c.slug),
      <ComparisonPage key={c.slug} slug={c.slug} />,
    ]),
  ),
  // Opportunist mid-tail eBay guides (US-1668).
  ...Object.fromEntries(
    OPPORTUNIST_GUIDES.map((g) => [
      g.path,
      <OpportunistGuidePage key={g.path} path={g.path} />,
    ]),
  ),
  // The returns spine (US-1673).
  [RETURNS_SPINE_PATH]: <ReduceEbayReturnsPage />,
  // Platform condition-standard pages (US-1672).
  [PLATFORM_STANDARDS_HUB_PATH]: <PlatformStandardsHubPage />,
  ...Object.fromEntries(
    PLATFORM_STANDARDS.map((s) => [
      platformStandardPath(s.slug),
      <PlatformStandardPage key={s.slug} slug={s.slug} />,
    ]),
  ),
  // Consumer where-to-sell mega-guide (US-1693).
  [WHERE_TO_SELL_PATH]: <WhereToSellPage />,
  // Best crosslisting apps listicle (US-1686).
  [CROSSLIST_APPS_PATH]: <CrosslistingAppsPage />,
  // Competitor alternative pages — generated from the same source as the router
  // and the route registry, so the three lists cannot drift apart (a missing
  // entry here is a registered route that prerenders to an empty SPA shell,
  // which the crawl-parity + sync-guard tests exist to catch).
  ...Object.fromEntries(
    COMPETITOR_ALTERNATIVES.map((alt) => [
      alternativePath(alt.slug),
      <CompetitorAlternativePage slug={alt.slug} />,
    ]),
  ),
  // US-9209: switch-from pages, generated from their data like the above.
  ...Object.fromEntries(
    SWITCH_FROM_PAGES.map((p) => [
      switchFromPath(p.slug),
      <SwitchFromPageView slug={p.slug} />,
    ]),
  ),
  // US-9214: crosslist pair pages, likewise from their own data.
  ...Object.fromEntries(
    CROSSLIST_PAIRS.map((p) => [
      crosslistPairPath(p.slug),
      <CrosslistPairPage slug={p.slug} />,
    ]),
  ),
  // Free printable condition chart (US-1678).
  [CONDITION_CHART_PATH]: <ConditionChartPage />,
  [CHANGELOG_PATH]: <ChangelogPage />,
  // Free grade-checker tool (US-1687).
  [GRADE_CHECKER_PATH]: <GradeCheckerPage />,
  // Free RN number lookup + tag reader (US-9033).
  [RN_LOOKUP_PATH]: <RnLookupPage />,
  // Free authenticity-check tool (US-1771).
  [AUTHENTICITY_CHECK_PATH]: <AuthenticityCheckPage />,
  [FIT_CHECKER_PATH]: <FitCheckerPage />,
  // The calculator family (US-9002). Generated from the registry so a new
  // calculator cannot ship a route without a page, and the lockstep guard
  // below catches it if the module map falls behind.
  [CALCULATOR_HUB_PATH]: <CalculatorHubPage />,
  ...Object.fromEntries(
    liveCalculators().map((c) => [calculatorPath(c.slug), CALCULATOR_PAGES[c.slug]]),
  ),
  [FOR_BRANDS_PATH]: <ForBrandsPage />,
  [DOWNLOAD_PATH]: <DownloadPage />,
};

export function renderRoute(path: string): string {
  const page = PAGES[path];
  if (!page) {
    throw new Error(`[prerender] no page registered for "${path}"`);
  }
  // A throwaway QueryClient: public pages read no server state, but the
  // provider must exist for any incidental hooks.
  const queryClient = new QueryClient();
  return renderToString(
    <StrictMode>
      <HelmetProvider>
        <QueryClientProvider client={queryClient}>
          <StaticRouter location={path}>{page}</StaticRouter>
        </QueryClientProvider>
      </HelmetProvider>
    </StrictMode>,
  );
}

// The set of paths this entry can render — the prerender script asserts this
// matches the route registry so a new public route can't silently skip SSR.
export const PRERENDERABLE_PATHS = Object.keys(PAGES);

// US-1950: the source module the CLIENT router lazy-loads for each prerendered
// path. main.tsx mounts with createRoot (a client render, NOT hydrateRoot — the
// intentional "prerender as a fast poster" design), so React discards the
// prerendered HTML and re-renders from scratch; every route is lazy() behind a
// full-screen <SuspenseWrapper> fallback, so that client render SUSPENDS into a
// 2-3s blank spinner while the route's JS chunk downloads. The prerendered <head>
// preloads only the eager vendor chunks, never the route chunk — so even an
// instantly-painted page flashes the spinner. The prerender resolves each of
// these module ids to its built chunk (via build-meta/bundle-modules.json) and
// emits a <link rel="modulepreload"> so the route chunk is already in flight when
// the client render begins — no suspend, no spinner flash. Kept in lockstep with
// PAGES by the guard below (a missing/extra key fails the build). Paths where
// several routes share one page module (glossary, guides, comparisons, …) all
// point at that shared module. Match is by path suffix, so no extension needed.
const M = "src/pages/";
export const ROUTE_PAGE_MODULES: Record<string, string> = {
  "/": `${M}landing`,
  "/how-it-works": `${M}marketing/how-it-works`,
  "/pricing": `${M}marketing/pricing`,
  "/for-resellers": `${M}marketing/for-resellers`,
  "/flipdesk": `${M}marketing/flipdesk`,
  "/partners": `${M}marketing/partners`,
  "/sell-used-clothes-ebay": `${M}marketing/sell-used-clothes-ebay`,
  "/faq": `${M}marketing/faq`,
  "/condition-grading": `${M}marketing/condition-grading`,
  "/grading-standard": `${M}marketing/grading-standard`,
  "/grading/scale": `${M}marketing/grading-scale`,
  "/grading/methodology": `${M}marketing/grading-methodology`,
  "/grading/graded-clothing-meaning": `${M}marketing/grading-disambiguation`,
  "/grading/vs-authentication": `${M}marketing/grading-disambiguation`,
  "/transparency": `${M}marketing/transparency`,
  "/resale-condition-report": `${M}marketing/resale-condition-report`,
  "/state-of-durability": `${M}marketing/state-of-durability`,
  "/sitemap": `${M}marketing/sitemap`,
  "/verify": `${M}marketing/verify`,
  "/style": `${M}marketing/style-code-lookup`,
  "/scan": `${M}marketing/passport-scan`,
  "/developers": `${M}marketing/developers`,
  "/whats-it-worth": `${M}marketing/whats-it-worth`,
  "/buyer-guarantee": `${M}marketing/buyer-guarantee`,
  "/about": `${M}marketing/about`,
  "/verified": `${M}verified-directory`,
  "/reduce-returns": `${M}marketing/reduce-returns`,
  "/reseller-grading-guide": `${M}marketing/reseller-grading-guide`,
  "/design-vs-damage": `${M}marketing/design-vs-damage`,
  "/resale-value-by-condition": `${M}marketing/resale-value-by-condition`,
  "/grading-by-category": `${M}marketing/grading-by-category`,
  "/privacy": `${M}legal/privacy`,
  "/terms": `${M}legal/terms`,
  "/cookies": `${M}legal/cookies`,
  "/acceptable-use": `${M}legal/acceptable-use`,
  "/refund": `${M}legal/refund`,
  "/account-deletion": `${M}legal/account-deletion`,
  "/imprint": `${M}legal/imprint`,
  "/dpa": `${M}legal/dpa`,
  "/subprocessors": `${M}legal/subprocessors`,
  "/dmca": `${M}legal/dmca`,
  "/trademarks": `${M}legal/trademarks`,
  "/accessibility": `${M}legal/accessibility`,
  "/status": `${M}status`,
  "/leaderboard": `${M}referral-leaderboard`,
  // Dynamic families — every path in the family shares one page module.
  ...Object.fromEntries(
    GLOSSARY_ENTRIES.map((e) => [e.path, `${M}marketing/grading-glossary`]),
  ),
  [RESELLER_GLOSSARY_HUB_PATH]: `${M}marketing/reseller-glossary`,
  ...Object.fromEntries(
    RESELLER_TERMS.map((t) => [resellerTermPath(t.slug), `${M}marketing/reseller-glossary`]),
  ),
  ...Object.fromEntries(
    FLIPDESK_LANDINGS.map((l) => [l.path, `${M}marketing/flipdesk-landing`]),
  ),
  [RESELLING_PILLAR_PATH]: `${M}marketing/reselling`,
  ...Object.fromEntries(
    RESELLING_GUIDES.map((g) => [resellingGuidePath(g.slug), `${M}marketing/reselling`]),
  ),
  [FLAW_LIBRARY_HUB_PATH]: `${M}marketing/flaw-library`,
  ...Object.fromEntries(
    FLAW_ENTRIES.map((f) => [flawPath(f.slug), `${M}marketing/flaw-library`]),
  ),
  // US-9014: the matrix has its own page module.
  ...Object.fromEntries(
    CARE_MATRIX.map((e) => [matrixPath(e), `${M}marketing/care-matrix`]),
  ),
  [GARMENT_GUIDES_HUB_PATH]: `${M}marketing/garment-guides`,
  ...Object.fromEntries(
    GARMENT_GUIDES.map((g) => [guidePath(g.slug), `${M}marketing/garment-guides`]),
  ),
  [COMPARE_HUB_PATH]: `${M}marketing/compare`,
  ...Object.fromEntries(
    COMPARISONS.map((c) => [comparePath(c.slug), `${M}marketing/compare`]),
  ),
  ...Object.fromEntries(
    OPPORTUNIST_GUIDES.map((g) => [g.path, `${M}marketing/opportunist-guide`]),
  ),
  [RETURNS_SPINE_PATH]: `${M}marketing/reduce-ebay-returns`,
  [PLATFORM_STANDARDS_HUB_PATH]: `${M}marketing/platform-standards`,
  ...Object.fromEntries(
    PLATFORM_STANDARDS.map((s) => [platformStandardPath(s.slug), `${M}marketing/platform-standards`]),
  ),
  [WHERE_TO_SELL_PATH]: `${M}marketing/where-to-sell`,
  [CROSSLIST_APPS_PATH]: `${M}marketing/crosslisting-apps`,
  // All three competitor alternative pages share one page module, like the
  // glossary/guides/comparison sets above. Generated from the same source as
  // PAGES so the guard below cannot catch them out of sync.
  ...Object.fromEntries(
    COMPETITOR_ALTERNATIVES.map((alt) => [
      alternativePath(alt.slug),
      `${M}marketing/competitor-alternative`,
    ]),
  ),
  ...Object.fromEntries(
    SWITCH_FROM_PAGES.map((p) => [switchFromPath(p.slug), `${M}marketing/switch-from`]),
  ),
  ...Object.fromEntries(
    CROSSLIST_PAIRS.map((p) => [crosslistPairPath(p.slug), `${M}marketing/crosslist-pair`]),
  ),
  [CONDITION_CHART_PATH]: `${M}marketing/condition-chart`,
  [CHANGELOG_PATH]: `${M}marketing/changelog`,
  [GRADE_CHECKER_PATH]: `${M}tools/grade-checker`,
  [RN_LOOKUP_PATH]: `${M}tools/rn-lookup`,
  [AUTHENTICITY_CHECK_PATH]: `${M}tools/authenticity-check`,
  [FIT_CHECKER_PATH]: `${M}tools/fit-checker`,
  [CALCULATOR_HUB_PATH]: `${M}tools/calculators`,
  ...Object.fromEntries(
    liveCalculators().map((c) => [calculatorPath(c.slug), `${M}${calculatorPageModule(c)}`]),
  ),
  [FOR_BRANDS_PATH]: `${M}marketing/for-brands`,
  [DOWNLOAD_PATH]: `${M}marketing/download`,
};

// Lockstep guard: every prerendered path must have a page-module mapping and
// vice versa. A drift here means a new route would silently ship without its
// chunk preloaded (the exact regression US-1950 fixes), so fail loudly at
// import time (the prerender build imports this module).
{
  const pages = Object.keys(PAGES).sort();
  const mapped = Object.keys(ROUTE_PAGE_MODULES).sort();
  if (JSON.stringify(pages) !== JSON.stringify(mapped)) {
    const missing = pages.filter((p) => !(p in ROUTE_PAGE_MODULES));
    const extra = mapped.filter((p) => !(p in PAGES));
    throw new Error(
      `[prerender] ROUTE_PAGE_MODULES out of sync with PAGES.` +
        (missing.length ? ` Missing: ${missing.join(", ")}.` : "") +
        (extra.length ? ` Extra: ${extra.join(", ")}.` : ""),
    );
  }
}
