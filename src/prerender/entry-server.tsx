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
import { StaticRouter } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { LandingPage } from "@/pages/landing";
import { PrivacyPage } from "@/pages/legal/privacy";
import { TermsPage } from "@/pages/legal/terms";
import { CookiesPage } from "@/pages/legal/cookies";
import { AcceptableUsePage } from "@/pages/legal/acceptable-use";
import { RefundPage } from "@/pages/legal/refund";
import { ImprintPage } from "@/pages/legal/imprint";
import { DpaPage } from "@/pages/legal/dpa";
import { SubprocessorsPage } from "@/pages/legal/subprocessors";
import { DmcaPage } from "@/pages/legal/dmca";
import { AccessibilityPage } from "@/pages/legal/accessibility";
import { HowItWorksPage } from "@/pages/marketing/how-it-works";
import { PricingPage } from "@/pages/marketing/pricing";
import { ForResellersPage } from "@/pages/marketing/for-resellers";
import { FlipDeskPage } from "@/pages/marketing/flipdesk";
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
import { VerifyGradePage } from "@/pages/marketing/verify";
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
import { CONDITION_CHART_PATH } from "@/lib/seo/condition-chart";
import { ConditionChartPage } from "@/pages/marketing/condition-chart";
import { GRADE_CHECKER_PATH } from "@/lib/seo/grade-checker";
import { GradeCheckerPage } from "@/pages/tools/grade-checker";
import { AUTHENTICITY_CHECK_PATH } from "@/lib/seo/authenticity-check";
import { AuthenticityCheckPage } from "@/pages/tools/authenticity-check";

// Static map of prerenderable routes → page element.
const PAGES: Record<string, React.ReactNode> = {
  "/": <LandingPage />,
  "/how-it-works": <HowItWorksPage />,
  "/pricing": <PricingPage />,
  "/for-resellers": <ForResellersPage />,
  "/flipdesk": <FlipDeskPage />,
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
  "/verify": <VerifyGradePage />,
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
  "/imprint": <ImprintPage />,
  "/dpa": <DpaPage />,
  "/subprocessors": <SubprocessorsPage />,
  "/dmca": <DmcaPage />,
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
  // Free printable condition chart (US-1678).
  [CONDITION_CHART_PATH]: <ConditionChartPage />,
  // Free grade-checker tool (US-1687).
  [GRADE_CHECKER_PATH]: <GradeCheckerPage />,
  // Free authenticity-check tool (US-1771).
  [AUTHENTICITY_CHECK_PATH]: <AuthenticityCheckPage />,
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
