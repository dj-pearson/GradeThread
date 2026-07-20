// This file is a router definition module — every lazy() page binding the
// rule treats as a component declaration, but they're consumed only by the
// router config below. Fast-refresh constraints don't apply here.
/* eslint-disable react-refresh/only-export-components */
import { lazy, SuspenseWrapper } from "./lazy";
import { createBrowserRouter, Navigate, useLocation } from "react-router-dom";
import { RootLayout } from "@/layouts/root-layout";
import { RouteErrorFallback } from "@/components/error-boundary";
import {
  COMPETITOR_ALTERNATIVES,
  alternativePath,
} from "@/lib/seo/competitor-alternatives";

// RootLayout stays eager (it renders on the first paint of every route). The
// authenticated layouts + auth guards are lazy: they pull Supabase, react-query
// and radix, and none of that is needed to render the public/landing pages —
// keeping them out of the eager entry chunk is the big mobile-LCP win (the
// landing page was shipping ~80KB gz of supabase+radix it never used).
const AuthLayout = lazy(() => import("@/layouts/auth-layout").then(m => ({ default: m.AuthLayout })));
const DashboardLayout = lazy(() => import("@/layouts/dashboard-layout").then(m => ({ default: m.DashboardLayout })));
const AdminLayout = lazy(() => import("@/layouts/admin-layout").then(m => ({ default: m.AdminLayout })));
const AdminRoutes = lazy(() => import("./admin-routes").then(m => ({ default: m.AdminRoutes })));
const ProtectedRoute = lazy(() => import("@/components/auth/protected-route").then(m => ({ default: m.ProtectedRoute })));
const AdminRoute = lazy(() => import("@/components/auth/admin-route").then(m => ({ default: m.AdminRoute })));
// Buyer platform (US-1802): buyer app shell + role guard.
const BuyerRoute = lazy(() => import("@/components/auth/buyer-route").then(m => ({ default: m.BuyerRoute })));
const BuyerLayout = lazy(() => import("@/layouts/buyer-layout").then(m => ({ default: m.BuyerLayout })));
const BuyerHomePage = lazy(() => import("@/pages/buyer/home").then(m => ({ default: m.BuyerHomePage })));
const BuyerOnboardingPage = lazy(() => import("@/pages/buyer/onboarding").then(m => ({ default: m.BuyerOnboardingPage })));
const BuyerSettingsPage = lazy(() => import("@/pages/buyer/settings").then(m => ({ default: m.BuyerSettingsPage })));
const BuyerAlertsPage = lazy(() => import("@/pages/buyer/alerts").then(m => ({ default: m.BuyerAlertsPage })));
const BuyerRewardsPage = lazy(() => import("@/pages/buyer/rewards").then(m => ({ default: m.BuyerRewardsPage })));
const BuyerPortfolioPage = lazy(() => import("@/pages/buyer/portfolio").then(m => ({ default: m.BuyerPortfolioPage })));
const BuyerBillingPage = lazy(() => import("@/pages/buyer/billing").then(m => ({ default: m.BuyerBillingPage })));
const BuyerPlaceholderPage = lazy(() => import("@/pages/buyer/placeholder").then(m => ({ default: m.BuyerPlaceholderPage })));

// Lazy-loaded pages for code splitting
const LandingPage = lazy(() => import("@/pages/landing").then(m => ({ default: m.LandingPage })));
const LoginPage = lazy(() => import("@/pages/login").then(m => ({ default: m.LoginPage })));
const SignupPage = lazy(() => import("@/pages/signup").then(m => ({ default: m.SignupPage })));
const AuthCallbackPage = lazy(() => import("@/pages/auth-callback").then(m => ({ default: m.AuthCallbackPage })));
const AuthConfirmPage = lazy(() => import("@/pages/auth-confirm").then(m => ({ default: m.AuthConfirmPage })));
const ResetPasswordPage = lazy(() => import("@/pages/reset-password").then(m => ({ default: m.ResetPasswordPage })));
const DashboardPage = lazy(() => import("@/pages/dashboard").then(m => ({ default: m.DashboardPage })));
const SupportTicketsPage = lazy(() => import("@/pages/support-tickets").then(m => ({ default: m.SupportTicketsPage })));
const SubmissionsPage = lazy(() => import("@/pages/submissions").then(m => ({ default: m.SubmissionsPage })));
const NewSubmissionPage = lazy(() => import("@/pages/new-submission").then(m => ({ default: m.NewSubmissionPage })));
const SnapToValuePage = lazy(() => import("@/pages/snap").then(m => ({ default: m.SnapToValuePage })));
const BulkSubmissionPage = lazy(() => import("@/pages/bulk-submission").then(m => ({ default: m.BulkSubmissionPage })));
const SubmissionDetailPage = lazy(() => import("@/pages/submission-detail").then(m => ({ default: m.SubmissionDetailPage })));
const FinancesPage = lazy(() => import("@/pages/finances").then(m => ({ default: m.FinancesPage })));
const SettingsPage = lazy(() => import("@/pages/settings").then(m => ({ default: m.SettingsPage })));
const AccountPage = lazy(() => import("@/pages/account").then(m => ({ default: m.AccountPage })));
const BillingPage = lazy(() => import("@/pages/billing").then(m => ({ default: m.BillingPage })));
const ApiKeysPage = lazy(() => import("@/pages/api-keys").then(m => ({ default: m.ApiKeysPage })));
const TeamPage = lazy(() => import("@/pages/team").then(m => ({ default: m.TeamPage })));
const AcceptInvitePage = lazy(() => import("@/pages/accept-invite").then(m => ({ default: m.AcceptInvitePage })));
const ConnectExtensionPage = lazy(() => import("@/pages/connect-extension").then(m => ({ default: m.ConnectExtensionPage })));
const PriceSuggestionsPage = lazy(() => import("@/pages/price-suggestions").then(m => ({ default: m.PriceSuggestionsPage })));
const CertificatePage = lazy(() => import("@/pages/certificate").then(m => ({ default: m.CertificatePage })));
const PassportPage = lazy(() => import("@/pages/passport").then(m => ({ default: m.PassportPage })));
const PassportClaimPage = lazy(() => import("@/pages/passport-claim").then(m => ({ default: m.PassportClaimPage })));
const TagScanPage = lazy(() => import("@/pages/tag-scan").then(m => ({ default: m.TagScanPage })));
const VerifiedSellerPage = lazy(() => import("@/pages/verified-seller").then(m => ({ default: m.VerifiedSellerPage })));
const TrustProfilePage = lazy(() => import("@/pages/trust-profile").then(m => ({ default: m.TrustProfilePage })));
const VerifiedDirectoryPage = lazy(() => import("@/pages/verified-directory").then(m => ({ default: m.VerifiedDirectoryPage })));
const FlipdeskVerifiedPage = lazy(() => import("@/pages/flipdesk/verified").then(m => ({ default: m.FlipdeskVerifiedPage })));
// Public status page (US-500) — live component health probed from the
// visitor's browser. Dynamic, NOT registered in PUBLIC_ROUTES (no prerender).
const StatusPage = lazy(() => import("@/pages/status").then(m => ({ default: m.StatusPage })));
const WaitlistPendingPage = lazy(() => import("@/pages/waitlist-pending").then(m => ({ default: m.WaitlistPendingPage })));
const PrivacyPage = lazy(() => import("@/pages/legal/privacy").then(m => ({ default: m.PrivacyPage })));
const TermsPage = lazy(() => import("@/pages/legal/terms").then(m => ({ default: m.TermsPage })));
const CookiesPage = lazy(() => import("@/pages/legal/cookies").then(m => ({ default: m.CookiesPage })));
const AcceptableUsePage = lazy(() => import("@/pages/legal/acceptable-use").then(m => ({ default: m.AcceptableUsePage })));
const RefundPage = lazy(() => import("@/pages/legal/refund").then(m => ({ default: m.RefundPage })));
const ImprintPage = lazy(() => import("@/pages/legal/imprint").then(m => ({ default: m.ImprintPage })));
const DpaPage = lazy(() => import("@/pages/legal/dpa").then(m => ({ default: m.DpaPage })));
const SubprocessorsPage = lazy(() => import("@/pages/legal/subprocessors").then(m => ({ default: m.SubprocessorsPage })));
const DmcaPage = lazy(() => import("@/pages/legal/dmca").then(m => ({ default: m.DmcaPage })));
const AccessibilityPage = lazy(() => import("@/pages/legal/accessibility").then(m => ({ default: m.AccessibilityPage })));
// Evergreen marketing pages (US-302) — public, prerendered, indexable.
const HowItWorksPage = lazy(() => import("@/pages/marketing/how-it-works").then(m => ({ default: m.HowItWorksPage })));
const PricingPage = lazy(() => import("@/pages/marketing/pricing").then(m => ({ default: m.PricingPage })));
const ForResellersPage = lazy(() => import("@/pages/marketing/for-resellers").then(m => ({ default: m.ForResellersPage })));
const FlipDeskPage = lazy(() => import("@/pages/marketing/flipdesk").then(m => ({ default: m.FlipDeskPage })));
const FlipdeskLandingPage = lazy(() => import("@/pages/marketing/flipdesk-landing").then(m => ({ default: m.FlipdeskLandingPage })));
const ResellingPillarPage = lazy(() => import("@/pages/marketing/reselling").then(m => ({ default: m.ResellingPillarPage })));
const ResellingGuidePage = lazy(() => import("@/pages/marketing/reselling").then(m => ({ default: m.ResellingGuidePage })));
const CompareHubPage = lazy(() => import("@/pages/marketing/compare").then(m => ({ default: m.CompareHubPage })));
const ComparisonPage = lazy(() => import("@/pages/marketing/compare").then(m => ({ default: m.ComparisonPage })));
const OpportunistGuidePage = lazy(() => import("@/pages/marketing/opportunist-guide").then(m => ({ default: m.OpportunistGuidePage })));
const ReduceEbayReturnsPage = lazy(() => import("@/pages/marketing/reduce-ebay-returns").then(m => ({ default: m.ReduceEbayReturnsPage })));
const PlatformStandardsHubPage = lazy(() => import("@/pages/marketing/platform-standards").then(m => ({ default: m.PlatformStandardsHubPage })));
const PlatformStandardPage = lazy(() => import("@/pages/marketing/platform-standards").then(m => ({ default: m.PlatformStandardPage })));
const WhereToSellPage = lazy(() => import("@/pages/marketing/where-to-sell").then(m => ({ default: m.WhereToSellPage })));
const CrosslistingAppsPage = lazy(() => import("@/pages/marketing/crosslisting-apps").then(m => ({ default: m.CrosslistingAppsPage })));
const CompetitorAlternativePage = lazy(() => import("@/pages/marketing/competitor-alternative").then(m => ({ default: m.CompetitorAlternativePage })));
const ConditionChartPage = lazy(() => import("@/pages/marketing/condition-chart").then(m => ({ default: m.ConditionChartPage })));
const GradeCheckerPage = lazy(() => import("@/pages/tools/grade-checker").then(m => ({ default: m.GradeCheckerPage })));
const AuthenticityCheckPage = lazy(() => import("@/pages/tools/authenticity-check").then(m => ({ default: m.AuthenticityCheckPage })));
const FitCheckerPage = lazy(() => import("@/pages/tools/fit-checker").then(m => ({ default: m.FitCheckerPage })));
const ForBrandsPage = lazy(() => import("@/pages/marketing/for-brands").then(m => ({ default: m.ForBrandsPage })));
const FlawLibraryHubPage = lazy(() => import("@/pages/marketing/flaw-library").then(m => ({ default: m.FlawLibraryHubPage })));
const FlawPage = lazy(() => import("@/pages/marketing/flaw-library").then(m => ({ default: m.FlawPage })));
const GarmentGuidesHubPage = lazy(() => import("@/pages/marketing/garment-guides").then(m => ({ default: m.GarmentGuidesHubPage })));
const GarmentGuidePage = lazy(() => import("@/pages/marketing/garment-guides").then(m => ({ default: m.GarmentGuidePage })));
const SellUsedClothesEbayPage = lazy(() => import("@/pages/marketing/sell-used-clothes-ebay").then(m => ({ default: m.SellUsedClothesEbayPage })));
const FaqPage = lazy(() => import("@/pages/marketing/faq").then(m => ({ default: m.FaqPage })));
const ConditionGradingPage = lazy(() => import("@/pages/marketing/condition-grading").then(m => ({ default: m.ConditionGradingPage })));
const GradingStandardPage = lazy(() => import("@/pages/marketing/grading-standard").then(m => ({ default: m.GradingStandardPage })));
const GradingScalePage = lazy(() => import("@/pages/marketing/grading-scale").then(m => ({ default: m.GradingScalePage })));
const GradingMethodologyPage = lazy(() => import("@/pages/marketing/grading-methodology").then(m => ({ default: m.GradingMethodologyPage })));
const GradedClothingMeaningPage = lazy(() => import("@/pages/marketing/grading-disambiguation").then(m => ({ default: m.GradedClothingMeaningPage })));
const VsAuthenticationPage = lazy(() => import("@/pages/marketing/grading-disambiguation").then(m => ({ default: m.VsAuthenticationPage })));
const TransparencyPage = lazy(() => import("@/pages/marketing/transparency").then(m => ({ default: m.TransparencyPage })));
const ResaleConditionReportPage = lazy(() => import("@/pages/marketing/resale-condition-report").then(m => ({ default: m.ResaleConditionReportPage })));
const StateOfDurabilityPage = lazy(() => import("@/pages/marketing/state-of-durability").then(m => ({ default: m.StateOfDurabilityPage })));
const HtmlSitemapPage = lazy(() => import("@/pages/marketing/sitemap").then(m => ({ default: m.HtmlSitemapPage })));
const BodyProfilesPage = lazy(() => import("@/pages/fit/body-profiles").then(m => ({ default: m.BodyProfilesPage })));
const VerifyGradePage = lazy(() => import("@/pages/marketing/verify").then(m => ({ default: m.VerifyGradePage })));
const PassportScanPage = lazy(() => import("@/pages/marketing/passport-scan").then(m => ({ default: m.PassportScanPage })));
const DevelopersPage = lazy(() => import("@/pages/marketing/developers").then(m => ({ default: m.DevelopersPage })));
const WhatsItWorthPage = lazy(() => import("@/pages/marketing/whats-it-worth").then(m => ({ default: m.WhatsItWorthPage })));
// US-867: buyer trust guarantee policy (prerendered) + claim intake form (dynamic).
const BuyerGuaranteePage = lazy(() => import("@/pages/marketing/buyer-guarantee").then(m => ({ default: m.BuyerGuaranteePage })));
const AboutPage = lazy(() => import("@/pages/marketing/about").then(m => ({ default: m.AboutPage })));
const BuyerGuaranteeClaimPage = lazy(() => import("@/pages/buyer-guarantee-claim").then(m => ({ default: m.BuyerGuaranteeClaimPage })));
// US-2073: the buyer DASHBOARD coverage view. Deliberately named
// BuyerCoveragePage, not BuyerGuaranteePage — that name is already taken by the
// public marketing/policy page at /buyer-guarantee, and conflating the two is
// how someone links a paying subscriber to the sales page.
const BuyerCoveragePage = lazy(() => import("@/pages/buyer/guarantee").then(m => ({ default: m.BuyerCoveragePage })));
// US-855: cornerstone pillar pages
const ReduceReturnsPage = lazy(() => import("@/pages/marketing/reduce-returns").then(m => ({ default: m.ReduceReturnsPage })));
const ResellerGradingGuidePage = lazy(() => import("@/pages/marketing/reseller-grading-guide").then(m => ({ default: m.ResellerGradingGuidePage })));
const DesignVsDamagePage = lazy(() => import("@/pages/marketing/design-vs-damage").then(m => ({ default: m.DesignVsDamagePage })));
const ResaleValueByConditionPage = lazy(() => import("@/pages/marketing/resale-value-by-condition").then(m => ({ default: m.ResaleValueByConditionPage })));
const GradingByCategoryPage = lazy(() => import("@/pages/marketing/grading-by-category").then(m => ({ default: m.GradingByCategoryPage })));
// US-596: white-label embeddable grade widget — bare (no app chrome), rendered
// inside partner iframes. Dynamic per certificate, NOT in PUBLIC_ROUTES.
const EmbedGradePage = lazy(() => import("@/pages/embed-grade").then(m => ({ default: m.EmbedGradePage })));
const GradingGlossaryPage = lazy(() => import("@/pages/marketing/grading-glossary").then(m => ({ default: m.GradingGlossaryPage })));
const ResellerGlossaryHubPage = lazy(() => import("@/pages/marketing/reseller-glossary").then(m => ({ default: m.ResellerGlossaryHubPage })));
const ResellerGlossaryTermPage = lazy(() => import("@/pages/marketing/reseller-glossary").then(m => ({ default: m.ResellerGlossaryTermPage })));
const FlipdeskOverviewPage = lazy(() => import("@/pages/flipdesk/overview").then(m => ({ default: m.FlipdeskOverviewPage })));
const FlipdeskSearchPage = lazy(() => import("@/pages/flipdesk/search").then(m => ({ default: m.FlipdeskSearchPage })));
// US-958: unified Inventory surface — hosts the table/grid/kanban/prep views as
// `?mode=` toggles on one route. The individual view page components
// (listings/grid/pipeline/prep) are imported lazily by this container — they
// are no longer mounted directly by the router — so their chunks stay split.
const FlipdeskInventoryPage = lazy(() => import("@/pages/flipdesk/inventory").then(m => ({ default: m.FlipdeskInventoryPage })));
const FlipdeskComposerPage = lazy(() => import("@/pages/flipdesk/composer").then(m => ({ default: m.FlipdeskComposerPage })));
const FlipdeskItemPage = lazy(() => import("@/pages/flipdesk/item").then(m => ({ default: m.FlipdeskItemPage })));
const FlipdeskExpensesPage = lazy(() => import("@/pages/flipdesk/expenses").then(m => ({ default: m.FlipdeskExpensesPage })));
const FlipdeskAnalyticsPage = lazy(() => import("@/pages/flipdesk/analytics").then(m => ({ default: m.FlipdeskAnalyticsPage })));
const FlipdeskListingPerformancePage = lazy(() => import("@/pages/flipdesk/listing-performance").then(m => ({ default: m.FlipdeskListingPerformancePage })));
const FlipdeskCommunityInsightsPage = lazy(() => import("@/pages/flipdesk/community-insights").then(m => ({ default: m.FlipdeskCommunityInsightsPage })));
const FlipdeskIntakePage = lazy(() => import("@/pages/flipdesk/intake").then(m => ({ default: m.FlipdeskIntakePage })));
const FlipdeskImportPage = lazy(() => import("@/pages/flipdesk/import").then(m => ({ default: m.FlipdeskImportPage })));
const FlipdeskMarketplacesPage = lazy(() => import("@/pages/flipdesk/marketplaces").then(m => ({ default: m.FlipdeskMarketplacesPage })));
const FlipdeskMeasureCardPage = lazy(() => import("@/pages/flipdesk/measure-card").then(m => ({ default: m.FlipdeskMeasureCardPage })));
const FlipdeskMarketplacesGooglePage = lazy(() => import("@/pages/flipdesk/marketplaces-google").then(m => ({ default: m.FlipdeskMarketplacesGooglePage })));
const FlipdeskOffersPage = lazy(() => import("@/pages/flipdesk/offers").then(m => ({ default: m.FlipdeskOffersPage })));
const FlipdeskPostSalePage = lazy(() => import("@/pages/flipdesk/post-sale").then(m => ({ default: m.FlipdeskPostSalePage })));
const FlipdeskBulkPricingPage = lazy(() => import("@/pages/flipdesk/bulk-pricing").then(m => ({ default: m.FlipdeskBulkPricingPage })));
const FlipdeskReconcilePage = lazy(() => import("@/pages/flipdesk/reconcile").then(m => ({ default: m.FlipdeskReconcilePage })));
const FlipdeskRepricingPage = lazy(() => import("@/pages/flipdesk/repricing").then(m => ({ default: m.FlipdeskRepricingPage })));
const FlipdeskAutomationsPage = lazy(() => import("@/pages/flipdesk/automations").then(m => ({ default: m.FlipdeskAutomationsPage })));
const FlipdeskScoutPage = lazy(() => import("@/pages/flipdesk/scout").then(m => ({ default: m.FlipdeskScoutPage })));
const FlipdeskScoutBuyPage = lazy(() => import("@/pages/flipdesk/scout-buy").then(m => ({ default: m.FlipdeskScoutBuyPage })));
const FlipdeskSourcesPage = lazy(() => import("@/pages/flipdesk/sources").then(m => ({ default: m.FlipdeskSourcesPage })));
const FlipdeskDemandPage = lazy(() => import("@/pages/flipdesk/demand").then(m => ({ default: m.FlipdeskDemandPage })));
const BuyerDemandPage = lazy(() => import("@/pages/buyer/demand").then(m => ({ default: m.BuyerDemandPage })));
const FlipdeskConsignmentPage = lazy(() => import("@/pages/flipdesk/consignment").then(m => ({ default: m.FlipdeskConsignmentPage })));
const FlipdeskAutolisterPage = lazy(() => import("@/pages/flipdesk/autolister").then(m => ({ default: m.FlipdeskAutolisterPage })));
const FlipdeskAutolisterQueuePage = lazy(() => import("@/pages/flipdesk/autolister-queue").then(m => ({ default: m.FlipdeskAutolisterQueuePage })));
const FlipdeskAutolisterBulkEditPage = lazy(() => import("@/pages/flipdesk/autolister-bulk-edit").then(m => ({ default: m.FlipdeskAutolisterBulkEditPage })));
const FlipdeskAutolisterDraftsPage = lazy(() => import("@/pages/flipdesk/autolister-drafts").then(m => ({ default: m.FlipdeskAutolisterDraftsPage })));
const FlipdeskScheduledDropsPage = lazy(() => import("@/pages/flipdesk/scheduled-drops").then(m => ({ default: m.FlipdeskScheduledDropsPage })));
const NotFoundPage = lazy(() => import("@/pages/not-found").then(m => ({ default: m.NotFoundPage })));
// US-443: in-shell 404 that keeps the dashboard/admin chrome (sidebar + header).
const InShellNotFound = lazy(() => import("@/pages/not-found").then(m => ({ default: m.InShellNotFound })));
const ReferralsPage = lazy(() => import("@/pages/referrals").then(m => ({ default: m.ReferralsPage })));
// US-864: public, opt-in top-referrers leaderboard. Dynamic (loads the public
// feed client-side), NOT registered in PUBLIC_ROUTES — like /status.
const ReferralLeaderboardPage = lazy(() => import("@/pages/referral-leaderboard").then(m => ({ default: m.ReferralLeaderboardPage })));


// The content module moved from /dashboard/content/* into the admin dashboard
// (/admin/content/*). This redirect keeps old bookmarks/links working by
// swapping the path prefix while preserving the sub-path, params and query.
function ContentRedirect() {
  const { pathname, search } = useLocation();
  const target = pathname.replace(/^\/dashboard\/content/, "/admin/content");
  return <Navigate to={`${target}${search}`} replace />;
}

// US-958: the standalone /grid, /pipeline, /listings, /prep (and the
// /inventory/* sub-routes) are consolidated into the single unified Inventory
// surface, which selects the shape via `?mode=`. Redirect each legacy URL to
// /inventory with the equivalent mode, preserving any incoming query params
// (tab/q/sort/filter) so bookmarks + saved-view links keep working.
function InventoryModeRedirect({ mode }: { mode?: string }) {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  if (mode) params.set("mode", mode);
  else params.delete("mode");
  const qs = params.toString();
  return (
    <Navigate
      to={`/dashboard/flipdesk/inventory${qs ? `?${qs}` : ""}`}
      replace
    />
  );
}

// US-740: the legacy core inventory is consolidated into the richer FlipDesk
// inventory. Redirect the detail route to the FlipDesk item canvas, preserving
// the :id and any query so existing deep links keep working.
function InventoryItemRedirect() {
  const { pathname, search } = useLocation();
  const target = pathname.replace(
    /^\/dashboard\/inventory\//,
    "/dashboard/flipdesk/items/",
  );
  return <Navigate to={`${target}${search}`} replace />;
}

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    errorElement: <RouteErrorFallback />,
    children: [
      // Public routes
      { path: "/", element: <SuspenseWrapper><LandingPage /></SuspenseWrapper> },
      { path: "/cert/:id", element: <SuspenseWrapper><CertificatePage /></SuspenseWrapper> },
      // Garment Passport — public, confidence-scored provenance timeline (US-1093).
      // Dynamic (like /cert/:id): served by the SSR Pages Function in prod; this
      // SPA route is the dev / in-app fallback. NOT registered in PUBLIC_ROUTES.
      { path: "/passport/:slug", element: <SuspenseWrapper><PassportPage /></SuspenseWrapper> },
      // Ownership claim/handoff (US-1094). Anonymous interactive flow (posts to
      // the edge), kept OUTSIDE /passport/* so it stays a pure SPA route (no SSR
      // Pages Function). noindex; NOT registered in PUBLIC_ROUTES.
      { path: "/claim/:token", element: <SuspenseWrapper><PassportClaimPage /></SuspenseWrapper> },
      // US-1096: physical-tag scan landing. Public; resolves a scanned QR/short
      // code to its passport + scan-to-claim. Pure SPA route (no SSR Function).
      { path: "/t/:code", element: <SuspenseWrapper><TagScanPage /></SuspenseWrapper> },
      // GradeThread Verified — public seller directory + leaderboard (US-863).
      // Static, indexable, prerendered (registered in PUBLIC_ROUTES); the seller
      // list itself loads client-side from the public sellers feed.
      { path: "/verified", element: <SuspenseWrapper><VerifiedDirectoryPage /></SuspenseWrapper> },
      // GradeThread Verified — public seller trust profile. Dynamic (like
      // /cert/:id): served by the SSR Pages Function in prod; this SPA route is
      // the dev / in-app fallback. NOT registered in PUBLIC_ROUTES (dynamic).
      { path: "/verified/:handle", element: <SuspenseWrapper><VerifiedSellerPage /></SuspenseWrapper> },
      // US-1818: public opt-in buyer Trust Score profile. Client-rendered + NOINDEX
      // (private-by-default; deliberately NOT in PUBLIC_ROUTES / the sitemap).
      { path: "/trust/:handle", element: <SuspenseWrapper><TrustProfilePage /></SuspenseWrapper> },

      // Marketing pages (public, prerendered — US-302)
      { path: "/how-it-works", element: <SuspenseWrapper><HowItWorksPage /></SuspenseWrapper> },
      { path: "/pricing", element: <SuspenseWrapper><PricingPage /></SuspenseWrapper> },
      { path: "/for-resellers", element: <SuspenseWrapper><ForResellersPage /></SuspenseWrapper> },
      { path: "/flipdesk", element: <SuspenseWrapper><FlipDeskPage /></SuspenseWrapper> },
      // US-1675/1676: FlipDesk conversion landing pages (one data-driven page).
      { path: "/flipdesk/inventory-management", element: <SuspenseWrapper><FlipdeskLandingPage /></SuspenseWrapper> },
      { path: "/flipdesk/autolister", element: <SuspenseWrapper><FlipdeskLandingPage /></SuspenseWrapper> },
      { path: "/flipdesk/crosslisting", element: <SuspenseWrapper><FlipdeskLandingPage /></SuspenseWrapper> },
      { path: "/flipdesk/comps", element: <SuspenseWrapper><FlipdeskLandingPage /></SuspenseWrapper> },
      { path: "/flipdesk/bookkeeping", element: <SuspenseWrapper><FlipdeskLandingPage /></SuspenseWrapper> },
      // US-1688: reselling pillar + TOFU guides (static pillar, dynamic guide route).
      { path: "/reselling", element: <SuspenseWrapper><ResellingPillarPage /></SuspenseWrapper> },
      // US-1668: opportunist mid-tail eBay guides (explicit paths, registered
      // BEFORE the dynamic /reselling/:slug so the static segments win).
      { path: "/reselling/ebay-item-specifics", element: <SuspenseWrapper><OpportunistGuidePage path="/reselling/ebay-item-specifics" /></SuspenseWrapper> },
      { path: "/reselling/comps/ebay-sold-comps", element: <SuspenseWrapper><OpportunistGuidePage path="/reselling/comps/ebay-sold-comps" /></SuspenseWrapper> },
      // US-1673: the returns spine (explicit path, before the dynamic slug route).
      { path: "/reselling/reduce-ebay-returns", element: <SuspenseWrapper><ReduceEbayReturnsPage /></SuspenseWrapper> },
      // US-1686: best crosslisting apps listicle (explicit, before /reselling/:slug).
      { path: "/reselling/best-crosslisting-apps", element: <SuspenseWrapper><CrosslistingAppsPage /></SuspenseWrapper> },
      // US-1693: consumer where-to-sell mega-guide.
      { path: "/where-to-sell-used-clothes", element: <SuspenseWrapper><WhereToSellPage /></SuspenseWrapper> },
      // Competitor alternative pages. Generated from the same data as the
      // routes/sitemap so the three lists cannot drift, and registered
      // EXPLICITLY before /reselling/:slug — that dynamic route would otherwise
      // swallow them and render the guide page's not-found instead.
      ...COMPETITOR_ALTERNATIVES.map((alt) => ({
        path: alternativePath(alt.slug),
        element: <SuspenseWrapper><CompetitorAlternativePage slug={alt.slug} /></SuspenseWrapper>,
      })),
      { path: "/reselling/:slug", element: <SuspenseWrapper><ResellingGuidePage /></SuspenseWrapper> },
      // US-1667: marketplace comparison hub + pages.
      { path: "/compare", element: <SuspenseWrapper><CompareHubPage /></SuspenseWrapper> },
      { path: "/compare/:slug", element: <SuspenseWrapper><ComparisonPage /></SuspenseWrapper> },
      { path: "/sell-used-clothes-ebay", element: <SuspenseWrapper><SellUsedClothesEbayPage /></SuspenseWrapper> },
      { path: "/faq", element: <SuspenseWrapper><FaqPage /></SuspenseWrapper> },
      { path: "/condition-grading", element: <SuspenseWrapper><ConditionGradingPage /></SuspenseWrapper> },
      { path: "/grading-standard", element: <SuspenseWrapper><GradingStandardPage /></SuspenseWrapper> },
      // US-1664 (SEO 2.0 keystone): the named Grading Scale pillar. Static, so it
      // outranks the /grading/:slug glossary route below.
      { path: "/grading/scale", element: <SuspenseWrapper><GradingScalePage /></SuspenseWrapper> },
      // US-1677 (E-E-A-T): grading methodology page. Static, outranks /grading/:slug.
      { path: "/grading/methodology", element: <SuspenseWrapper><GradingMethodologyPage /></SuspenseWrapper> },
      // US-1684: disambiguation pages. Static, outrank /grading/:slug.
      { path: "/grading/graded-clothing-meaning", element: <SuspenseWrapper><GradedClothingMeaningPage /></SuspenseWrapper> },
      { path: "/grading/vs-authentication", element: <SuspenseWrapper><VsAuthenticationPage /></SuspenseWrapper> },
      { path: "/transparency", element: <SuspenseWrapper><TransparencyPage /></SuspenseWrapper> },
      { path: "/resale-condition-report", element: <SuspenseWrapper><ResaleConditionReportPage /></SuspenseWrapper> },
      { path: "/state-of-durability", element: <SuspenseWrapper><StateOfDurabilityPage /></SuspenseWrapper> },
      { path: "/sitemap", element: <SuspenseWrapper><HtmlSitemapPage /></SuspenseWrapper> },
      { path: "/verify", element: <SuspenseWrapper><VerifyGradePage /></SuspenseWrapper> },
      // US-1106: buyer-facing "scan before you buy" passport lookup landing.
      { path: "/scan", element: <SuspenseWrapper><PassportScanPage /></SuspenseWrapper> },
      { path: "/developers", element: <SuspenseWrapper><DevelopersPage /></SuspenseWrapper> },
      { path: "/whats-it-worth", element: <SuspenseWrapper><WhatsItWorthPage /></SuspenseWrapper> },
      // US-868: company/about page (entity-level authority surface)
      { path: "/about", element: <SuspenseWrapper><AboutPage /></SuspenseWrapper> },
      // US-867: buyer trust guarantee. Policy page is prerendered (PUBLIC_ROUTES);
      // the claim intake form is a dynamic public route (no account needed).
      { path: "/buyer-guarantee", element: <SuspenseWrapper><BuyerGuaranteePage /></SuspenseWrapper> },
      { path: "/buyer-guarantee/claim", element: <SuspenseWrapper><BuyerGuaranteeClaimPage /></SuspenseWrapper> },
      // Cornerstone pillar pages (US-855)
      { path: "/reduce-returns", element: <SuspenseWrapper><ReduceReturnsPage /></SuspenseWrapper> },
      { path: "/reseller-grading-guide", element: <SuspenseWrapper><ResellerGradingGuidePage /></SuspenseWrapper> },
      { path: "/design-vs-damage", element: <SuspenseWrapper><DesignVsDamagePage /></SuspenseWrapper> },
      { path: "/resale-value-by-condition", element: <SuspenseWrapper><ResaleValueByConditionPage /></SuspenseWrapper> },
      { path: "/grading-by-category", element: <SuspenseWrapper><GradingByCategoryPage /></SuspenseWrapper> },
      // Reseller condition-vocabulary glossary (US-1671): the hub + one page per
      // term. Static /grading/glossary (and the 2-segment term route) outrank the
      // /grading/:slug spoke route below. Registered in PUBLIC_ROUTES + prerendered.
      { path: "/grading/glossary", element: <SuspenseWrapper><ResellerGlossaryHubPage /></SuspenseWrapper> },
      { path: "/grading/glossary/:term", element: <SuspenseWrapper><ResellerGlossaryTermPage /></SuspenseWrapper> },
      // Flaw library (US-1683): hub + per-flaw pages. Static /grading/flaws + the
      // 2-segment flaw route outrank /grading/:slug below.
      { path: "/grading/flaws", element: <SuspenseWrapper><FlawLibraryHubPage /></SuspenseWrapper> },
      { path: "/grading/flaws/:flaw", element: <SuspenseWrapper><FlawPage /></SuspenseWrapper> },
      // Garment-type grading guides (US-1682): hub + per-garment pages.
      { path: "/grading/guides", element: <SuspenseWrapper><GarmentGuidesHubPage /></SuspenseWrapper> },
      { path: "/grading/guides/:garment", element: <SuspenseWrapper><GarmentGuidePage /></SuspenseWrapper> },
      // US-1672: platform condition-standard pages (hub + spokes). Static
      // /grading/platform-standards + the 2-segment spoke outrank /grading/:slug.
      { path: "/grading/platform-standards", element: <SuspenseWrapper><PlatformStandardsHubPage /></SuspenseWrapper> },
      { path: "/grading/platform-standards/:platform", element: <SuspenseWrapper><PlatformStandardPage /></SuspenseWrapper> },
      // US-1678: free printable condition chart (static, before /grading/:slug).
      { path: "/grading/condition-chart", element: <SuspenseWrapper><ConditionChartPage /></SuspenseWrapper> },
      // US-1687: free grade-checker tool.
      { path: "/tools/grade-checker", element: <SuspenseWrapper><GradeCheckerPage /></SuspenseWrapper> },
      // US-1771: free authenticity-check tool.
      { path: "/tools/authenticity-check", element: <SuspenseWrapper><AuthenticityCheckPage /></SuspenseWrapper> },
      // US-1780: free fit-checker tool.
      { path: "/tools/fit-checker", element: <SuspenseWrapper><FitCheckerPage /></SuspenseWrapper> },
      { path: "/for-brands", element: <SuspenseWrapper><ForBrandsPage /></SuspenseWrapper> },
      // Glossary hub spokes (US-303): one page per grade tier + factor, served
      // by a single dynamic route. The indexable set is registered in
      // PUBLIC_ROUTES (via glossaryRoutes()) and prerendered individually.
      { path: "/grading/:slug", element: <SuspenseWrapper><GradingGlossaryPage /></SuspenseWrapper> },

      // System status (public, US-500)
      { path: "/status", element: <SuspenseWrapper><StatusPage /></SuspenseWrapper> },

      // Public top-referrers leaderboard (US-864) — opt-in, PII-free. Dynamic,
      // NOT prerendered (loads the public feed client-side).
      { path: "/leaderboard", element: <SuspenseWrapper><ReferralLeaderboardPage /></SuspenseWrapper> },

      // US-585: waitlist-pending — shown when a signed-in account isn't yet
      // approved while the launch gate is active (edge-fetch redirects here).
      { path: "/waitlist-pending", element: <SuspenseWrapper><WaitlistPendingPage /></SuspenseWrapper> },

      // Legal pages (public)
      { path: "/privacy", element: <SuspenseWrapper><PrivacyPage /></SuspenseWrapper> },
      { path: "/terms", element: <SuspenseWrapper><TermsPage /></SuspenseWrapper> },
      { path: "/cookies", element: <SuspenseWrapper><CookiesPage /></SuspenseWrapper> },
      { path: "/acceptable-use", element: <SuspenseWrapper><AcceptableUsePage /></SuspenseWrapper> },
      { path: "/refund", element: <SuspenseWrapper><RefundPage /></SuspenseWrapper> },
      { path: "/imprint", element: <SuspenseWrapper><ImprintPage /></SuspenseWrapper> },
      { path: "/dpa", element: <SuspenseWrapper><DpaPage /></SuspenseWrapper> },
      { path: "/subprocessors", element: <SuspenseWrapper><SubprocessorsPage /></SuspenseWrapper> },
      { path: "/dmca", element: <SuspenseWrapper><DmcaPage /></SuspenseWrapper> },
      { path: "/accessibility", element: <SuspenseWrapper><AccessibilityPage /></SuspenseWrapper> },

      // Auth routes (guest only)
      {
        element: <SuspenseWrapper><AuthLayout /></SuspenseWrapper>,
        children: [
          { path: "/login", element: <SuspenseWrapper><LoginPage /></SuspenseWrapper> },
          { path: "/signup", element: <SuspenseWrapper><SignupPage /></SuspenseWrapper> },
          { path: "/auth/reset-password", element: <SuspenseWrapper><ResetPasswordPage /></SuspenseWrapper> },
        ],
      },

      // Auth callback (public, handles redirect)
      { path: "/auth/callback", element: <SuspenseWrapper><AuthCallbackPage /></SuspenseWrapper> },

      // Email confirmation via OTP / token_hash (public — the account has no
      // session until it verifies here). Reached from the branded auth email's
      // link or by typing the 6-digit code.
      { path: "/auth/confirm", element: <SuspenseWrapper><AuthConfirmPage /></SuspenseWrapper> },

      // Workspace invitation acceptance — works for both signed-in and
      // signed-out users. The page redirects to /signup or /login as
      // needed and resumes after auth.
      { path: "/accept-invite", element: <SuspenseWrapper><AcceptInvitePage /></SuspenseWrapper> },

      // US-1873: unified-extension connect page. Opened from the extension popup
      // with ?ext=<id>; mints an extension token and hands it to the extension.
      // Public — self-handles the signed-out case (redirects to /login?next=).
      { path: "/connect-extension", element: <SuspenseWrapper><ConnectExtensionPage /></SuspenseWrapper> },

      // Protected dashboard routes
      {
        element: <SuspenseWrapper><ProtectedRoute /></SuspenseWrapper>,
        children: [
          {
            element: <SuspenseWrapper><DashboardLayout /></SuspenseWrapper>,
            children: [
              { path: "/dashboard", element: <SuspenseWrapper><DashboardPage /></SuspenseWrapper> },
              { path: "/dashboard/snap", element: <SuspenseWrapper><SnapToValuePage /></SuspenseWrapper> },
              { path: "/dashboard/submissions", element: <SuspenseWrapper><SubmissionsPage /></SuspenseWrapper> },
              { path: "/dashboard/submissions/new", element: <SuspenseWrapper><NewSubmissionPage /></SuspenseWrapper> },
              { path: "/dashboard/submissions/bulk", element: <SuspenseWrapper><BulkSubmissionPage /></SuspenseWrapper> },
              { path: "/dashboard/submissions/:id", element: <SuspenseWrapper><SubmissionDetailPage /></SuspenseWrapper> },
              // US-740: consolidated into the FlipDesk inventory (the canonical
              // multi-view surface). Legacy routes redirect so all inbound links
              // (sidebar, finances, price-suggestions, dashboard) keep working.
              { path: "/dashboard/inventory", element: <Navigate to="/dashboard/flipdesk/inventory" replace /> },
              { path: "/dashboard/inventory/new", element: <Navigate to="/dashboard/flipdesk/intake" replace /> },
              { path: "/dashboard/inventory/:id", element: <InventoryItemRedirect /> },
              { path: "/dashboard/finances", element: <SuspenseWrapper><FinancesPage /></SuspenseWrapper> },
              // US-1777: buyer body-profile store (measurements for fit checks).
              { path: "/dashboard/measurements", element: <SuspenseWrapper><BodyProfilesPage /></SuspenseWrapper> },
              { path: "/dashboard/analytics/suggestions", element: <SuspenseWrapper><PriceSuggestionsPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk", element: <SuspenseWrapper><FlipdeskOverviewPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/overview", element: <SuspenseWrapper><FlipdeskOverviewPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/search", element: <SuspenseWrapper><FlipdeskSearchPage /></SuspenseWrapper> },
              // ── Consolidated Inventory surface ──────────────────────────
              // /inventory is the new canonical home (table view); /grid and
              // /kanban host the photo-card + pipeline shapes of the same data.
              // The pre-consolidation URLs (/items, /grid, /pipeline, /listings,
              // /prep) stay live below so saved views + bookmarks keep working.
              // US-958: one route hosts every shape via `?mode=` (table is the
              // default). The /inventory/{grid,kanban,prep} sub-routes redirect
              // into it, preserving query params.
              { path: "/dashboard/flipdesk/inventory", element: <SuspenseWrapper><FlipdeskInventoryPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/inventory/grid", element: <InventoryModeRedirect mode="grid" /> },
              { path: "/dashboard/flipdesk/inventory/kanban", element: <InventoryModeRedirect mode="kanban" /> },
              { path: "/dashboard/flipdesk/inventory/prep", element: <InventoryModeRedirect mode="prep" /> },
              // Legacy paths — still resolve so links don't break.
              // /items now redirects to /inventory (preserving query params,
              // e.g. a saved-view ?view= link).
              { path: "/dashboard/flipdesk/items", element: <InventoryModeRedirect /> },
              { path: "/dashboard/flipdesk/grid", element: <InventoryModeRedirect mode="grid" /> },
              { path: "/dashboard/flipdesk/items/:id", element: <SuspenseWrapper><FlipdeskItemPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/items/:id/draft", element: <SuspenseWrapper><FlipdeskComposerPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/intake", element: <SuspenseWrapper><FlipdeskIntakePage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/prep", element: <InventoryModeRedirect mode="prep" /> },
              { path: "/dashboard/flipdesk/import", element: <SuspenseWrapper><FlipdeskImportPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/autolister", element: <SuspenseWrapper><FlipdeskAutolisterPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/autolister/queue", element: <SuspenseWrapper><FlipdeskAutolisterQueuePage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/autolister/bulk-edit", element: <SuspenseWrapper><FlipdeskAutolisterBulkEditPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/autolister/drafts", element: <SuspenseWrapper><FlipdeskAutolisterDraftsPage /></SuspenseWrapper> },
          { path: "/dashboard/flipdesk/scheduled-drops", element: <SuspenseWrapper><FlipdeskScheduledDropsPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/pipeline", element: <InventoryModeRedirect mode="kanban" /> },
              { path: "/dashboard/flipdesk/listings", element: <InventoryModeRedirect /> },
              { path: "/dashboard/flipdesk/verified", element: <SuspenseWrapper><FlipdeskVerifiedPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/sources", element: <SuspenseWrapper><FlipdeskSourcesPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/demand", element: <SuspenseWrapper><FlipdeskDemandPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/consignment", element: <SuspenseWrapper><FlipdeskConsignmentPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/marketplaces", element: <SuspenseWrapper><FlipdeskMarketplacesPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/measure-card", element: <SuspenseWrapper><FlipdeskMeasureCardPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/offers", element: <SuspenseWrapper><FlipdeskOffersPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/post-sale", element: <SuspenseWrapper><FlipdeskPostSalePage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/bulk-pricing", element: <SuspenseWrapper><FlipdeskBulkPricingPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/marketplaces/google", element: <SuspenseWrapper><FlipdeskMarketplacesGooglePage /></SuspenseWrapper> },
              // US-963: the standalone Reconciliation page is now the "eBay SKU
              // match" / "Payouts & fees" tabs of the unified Reconcile area.
              { path: "/dashboard/flipdesk/reconciliation", element: <Navigate to="/dashboard/flipdesk/reconcile?tab=ebay" replace /> },
              { path: "/dashboard/flipdesk/reconcile", element: <SuspenseWrapper><FlipdeskReconcilePage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/repricing", element: <SuspenseWrapper><FlipdeskRepricingPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/automations", element: <SuspenseWrapper><FlipdeskAutomationsPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/scout", element: <SuspenseWrapper><FlipdeskScoutPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/scout/buy", element: <SuspenseWrapper><FlipdeskScoutBuyPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/expenses", element: <SuspenseWrapper><FlipdeskExpensesPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/analytics", element: <SuspenseWrapper><FlipdeskAnalyticsPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/analytics/grading-roi", element: <SuspenseWrapper><FlipdeskAnalyticsPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/analytics/returns", element: <SuspenseWrapper><FlipdeskAnalyticsPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/analytics/performance", element: <SuspenseWrapper><FlipdeskListingPerformancePage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/community", element: <SuspenseWrapper><FlipdeskCommunityInsightsPage /></SuspenseWrapper> },
              { path: "/dashboard/account", element: <SuspenseWrapper><AccountPage /></SuspenseWrapper> },
              { path: "/dashboard/settings", element: <SuspenseWrapper><SettingsPage /></SuspenseWrapper> },
              { path: "/dashboard/support", element: <SuspenseWrapper><SupportTicketsPage /></SuspenseWrapper> },
              { path: "/dashboard/support/:id", element: <SuspenseWrapper><SupportTicketsPage /></SuspenseWrapper> },
              { path: "/dashboard/billing", element: <SuspenseWrapper><BillingPage /></SuspenseWrapper> },
              { path: "/dashboard/api-keys", element: <SuspenseWrapper><ApiKeysPage /></SuspenseWrapper> },
              { path: "/dashboard/team", element: <SuspenseWrapper><TeamPage /></SuspenseWrapper> },
              { path: "/dashboard/referrals", element: <SuspenseWrapper><ReferralsPage /></SuspenseWrapper> },
              // Content module moved to the admin dashboard (/admin/content/*).
              // Keep old /dashboard/content/* URLs alive via a prefix-preserving
              // redirect so existing bookmarks and in-app links don't 404.
              { path: "/dashboard/content/*", element: <ContentRedirect /> },
              // In-shell 404: an unknown /dashboard/* path keeps the sidebar +
              // header instead of dropping to the full-screen navless root 404.
              { path: "/dashboard/*", element: <SuspenseWrapper><InShellNotFound /></SuspenseWrapper> },
            ],
          },
          // Buyer app (US-1802) — sibling of the seller DashboardLayout under the
          // SAME ProtectedRoute (shared session), gated by the buyer role.
          {
            element: <SuspenseWrapper><BuyerRoute /></SuspenseWrapper>,
            children: [
              {
                element: <SuspenseWrapper><BuyerLayout /></SuspenseWrapper>,
                children: [
                  { path: "/buyer", element: <SuspenseWrapper><BuyerHomePage /></SuspenseWrapper> },
                  { path: "/buyer/onboarding", element: <SuspenseWrapper><BuyerOnboardingPage /></SuspenseWrapper> },
                  { path: "/buyer/alerts", element: <SuspenseWrapper><BuyerAlertsPage /></SuspenseWrapper> },
                  { path: "/buyer/rewards", element: <SuspenseWrapper><BuyerRewardsPage /></SuspenseWrapper> },
                  { path: "/buyer/portfolio", element: <SuspenseWrapper><BuyerPortfolioPage /></SuspenseWrapper> },
                  // US-2073: real coverage surface, replacing the placeholder that told a PAYING
                  // subscriber the feature they bought was "coming soon".
                  { path: "/buyer/guarantee", element: <SuspenseWrapper><BuyerCoveragePage /></SuspenseWrapper> },
                  { path: "/buyer/demand", element: <SuspenseWrapper><BuyerDemandPage /></SuspenseWrapper> },
                  { path: "/buyer/billing", element: <SuspenseWrapper><BuyerBillingPage /></SuspenseWrapper> },
                  { path: "/buyer/settings", element: <SuspenseWrapper><BuyerSettingsPage /></SuspenseWrapper> },
                  { path: "/buyer/*", element: <SuspenseWrapper><BuyerPlaceholderPage title="Not found" description="That buyer page doesn't exist yet." /></SuspenseWrapper> },
                ],
              },
            ],
          },
        ],
      },

      // Admin routes (admin/super_admin only)
      {
        element: <SuspenseWrapper><AdminRoute /></SuspenseWrapper>,
        children: [
          {
            element: <SuspenseWrapper><AdminLayout /></SuspenseWrapper>,
            children: [
              // US-2112: the admin subtree moved to ./admin-routes as DESCENDANT
              // routes, so its 81 lazy declarations and 86 route objects load only
              // when someone actually reaches /admin/* — they were shipping in the
              // entry chunk to every marketing visitor.
              { path: "/admin/*", element: <SuspenseWrapper><AdminRoutes /></SuspenseWrapper> },
            ],
          },
        ],
      },

      // 404
      { path: "*", element: <SuspenseWrapper><NotFoundPage /></SuspenseWrapper> },
    ],
  },
  // US-596: white-label embed — intentionally OUTSIDE RootLayout so it carries
  // no Toaster / cookie banner / dialogs when rendered inside a partner iframe.
  {
    path: "/embed/grade/:id",
    element: <SuspenseWrapper><EmbedGradePage /></SuspenseWrapper>,
    errorElement: <RouteErrorFallback />,
  },
]);
