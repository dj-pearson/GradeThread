// This file is a router definition module — every lazy() page binding the
// rule treats as a component declaration, but they're consumed only by the
// router config below. Fast-refresh constraints don't apply here.
/* eslint-disable react-refresh/only-export-components */
import { lazy, SuspenseWrapper } from "./lazy";
import { createBrowserRouter, Navigate, useLocation } from "react-router";
import { RootLayout } from "@/layouts/root-layout";
import { RouteErrorFallback } from "@/components/error-boundary";
import {
  COMPETITOR_ALTERNATIVE_SLUGS,
  alternativePath,
} from "@/lib/seo/competitor-alternative-slugs";
import { SWITCH_FROM_SLUGS, switchFromPath } from "@/lib/seo/switch-from-slugs";
import { CROSSLIST_PAIR_SLUGS, crosslistPairPath } from "@/lib/seo/crosslist-pair-slugs";

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
const ExamplePage = lazy(() => import("@/pages/example").then(m => ({ default: m.ExamplePage })));
// US-1851: seller rewards — level, quarterly season track, cosmetic perks.
const RewardsPage = lazy(() => import("@/pages/rewards").then(m => ({ default: m.RewardsPage })));
const NewSubmissionPage = lazy(() => import("@/pages/new-submission").then(m => ({ default: m.NewSubmissionPage })));
const SnapToValuePage = lazy(() => import("@/pages/snap").then(m => ({ default: m.SnapToValuePage })));
const BulkSubmissionPage = lazy(() => import("@/pages/bulk-submission").then(m => ({ default: m.BulkSubmissionPage })));
const SubmissionDetailPage = lazy(() => import("@/pages/submission-detail").then(m => ({ default: m.SubmissionDetailPage })));
const AccountPage = lazy(() => import("@/pages/account").then(m => ({ default: m.AccountPage })));
const ApiKeysPage = lazy(() => import("@/pages/api-keys").then(m => ({ default: m.ApiKeysPage })));
const AcceptInvitePage = lazy(() => import("@/pages/accept-invite").then(m => ({ default: m.AcceptInvitePage })));
const ConnectExtensionPage = lazy(() => import("@/pages/connect-extension").then(m => ({ default: m.ConnectExtensionPage })));
const ConnectClaudePage = lazy(() => import("@/pages/connect-claude").then(m => ({ default: m.ConnectClaudePage })));
const CertificatePage = lazy(() => import("@/pages/certificate").then(m => ({ default: m.CertificatePage })));
const PassportPage = lazy(() => import("@/pages/passport").then(m => ({ default: m.PassportPage })));
const PassportClaimPage = lazy(() => import("@/pages/passport-claim").then(m => ({ default: m.PassportClaimPage })));
const TagScanPage = lazy(() => import("@/pages/tag-scan").then(m => ({ default: m.TagScanPage })));
const VerifiedSellerPage = lazy(() => import("@/pages/verified-seller").then(m => ({ default: m.VerifiedSellerPage })));
const TrustProfilePage = lazy(() => import("@/pages/trust-profile").then(m => ({ default: m.TrustProfilePage })));
const VerifiedDirectoryPage = lazy(() => import("@/pages/verified-directory").then(m => ({ default: m.VerifiedDirectoryPage })));
const FindsPage = lazy(() => import("@/pages/finds").then(m => ({ default: m.FindsPage })));
// US-2576: the public Help Center. Edge-SSR'd in production; these are the
// in-app and dev renderers.
const HelpHubPage = lazy(() => import("@/pages/help/hub").then(m => ({ default: m.HelpHubPage })));
const HelpCategoryPage = lazy(() => import("@/pages/help/category").then(m => ({ default: m.HelpCategoryPage })));
const HelpArticlePage = lazy(() => import("@/pages/help/article").then(m => ({ default: m.HelpArticlePage })));
const HelpSearchPage = lazy(() => import("@/pages/help/search").then(m => ({ default: m.HelpSearchPage })));
// US-2583: the in-app reader. Sees members-only articles, and internal ones
// for an admin — the SERVER decides which, from the verified user id.
const HelpReaderPage = lazy(() => import("@/pages/help-reader").then(m => ({ default: m.HelpReaderPage })));
const GlossaryPage = lazy(() => import("@/pages/glossary").then(m => ({ default: m.GlossaryPage })));
const LeaderboardsPage = lazy(() => import("@/pages/leaderboards").then(m => ({ default: m.LeaderboardsPage })));
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
const AccountDeletionPage = lazy(() => import("@/pages/legal/account-deletion").then(m => ({ default: m.AccountDeletionPage })));
const ImprintPage = lazy(() => import("@/pages/legal/imprint").then(m => ({ default: m.ImprintPage })));
const DpaPage = lazy(() => import("@/pages/legal/dpa").then(m => ({ default: m.DpaPage })));
const SubprocessorsPage = lazy(() => import("@/pages/legal/subprocessors").then(m => ({ default: m.SubprocessorsPage })));
const DmcaPage = lazy(() => import("@/pages/legal/dmca").then(m => ({ default: m.DmcaPage })));
const TrademarksPage = lazy(() => import("@/pages/legal/trademarks").then(m => ({ default: m.TrademarksPage })));
const AccessibilityPage = lazy(() => import("@/pages/legal/accessibility").then(m => ({ default: m.AccessibilityPage })));
// Evergreen marketing pages (US-302) — public, prerendered, indexable.
const HowItWorksPage = lazy(() => import("@/pages/marketing/how-it-works").then(m => ({ default: m.HowItWorksPage })));
const PricingPage = lazy(() => import("@/pages/marketing/pricing").then(m => ({ default: m.PricingPage })));
const ForResellersPage = lazy(() => import("@/pages/marketing/for-resellers").then(m => ({ default: m.ForResellersPage })));
const FlipDeskPage = lazy(() => import("@/pages/marketing/flipdesk").then(m => ({ default: m.FlipDeskPage })));
const PartnersPage = lazy(() => import("@/pages/marketing/partners").then(m => ({ default: m.PartnersPage })));
const FlipdeskLandingPage = lazy(() => import("@/pages/marketing/flipdesk-landing").then(m => ({ default: m.FlipdeskLandingPage })));
const ResellingPillarPage = lazy(() => import("@/pages/marketing/reselling").then(m => ({ default: m.ResellingPillarPage })));
const ResellingGuidePage = lazy(() => import("@/pages/marketing/reselling").then(m => ({ default: m.ResellingGuidePage })));
const BuyingGuidePage = lazy(() => import("@/pages/marketing/buying-guide").then(m => ({ default: m.BuyingGuidePage })));
const CompareHubPage = lazy(() => import("@/pages/marketing/compare").then(m => ({ default: m.CompareHubPage })));
const ComparisonPage = lazy(() => import("@/pages/marketing/compare").then(m => ({ default: m.ComparisonPage })));
const OpportunistGuidePage = lazy(() => import("@/pages/marketing/opportunist-guide").then(m => ({ default: m.OpportunistGuidePage })));
const ReduceEbayReturnsPage = lazy(() => import("@/pages/marketing/reduce-ebay-returns").then(m => ({ default: m.ReduceEbayReturnsPage })));
const PlatformStandardsHubPage = lazy(() => import("@/pages/marketing/platform-standards").then(m => ({ default: m.PlatformStandardsHubPage })));
const PlatformStandardPage = lazy(() => import("@/pages/marketing/platform-standards").then(m => ({ default: m.PlatformStandardPage })));
const WhereToSellPage = lazy(() => import("@/pages/marketing/where-to-sell").then(m => ({ default: m.WhereToSellPage })));
const CrosslistingAppsPage = lazy(() => import("@/pages/marketing/crosslisting-apps").then(m => ({ default: m.CrosslistingAppsPage })));
const CompetitorAlternativePage = lazy(() => import("@/pages/marketing/competitor-alternative").then(m => ({ default: m.CompetitorAlternativePage })));
const SwitchFromPageView = lazy(() => import("@/pages/marketing/switch-from").then(m => ({ default: m.SwitchFromPageView })));
const CrosslistPairPage = lazy(() => import("@/pages/marketing/crosslist-pair").then(m => ({ default: m.CrosslistPairPage })));
const ConditionChartPage = lazy(() => import("@/pages/marketing/condition-chart").then(m => ({ default: m.ConditionChartPage })));
const ChangelogPage = lazy(() => import("@/pages/marketing/changelog").then(m => ({ default: m.ChangelogPage })));
// US-2506: SPA renderers for the public Condition Index. Prod serves the
// edge-SSR Pages Function (functions/condition-index/[[path]].ts); these routes
// are the dev / in-app fallback. Without them the footer's "Condition Index"
// link — rendered by MarketingLayout on EVERY public page — was a react-router
// Link to a path the router didn't know, so it fell through to the * 404.
// Dynamic, so NOT registered in PUBLIC_ROUTES (same as /finds, /leaderboards).
const ConditionIndexHubPage = lazy(() => import("@/pages/marketing/condition-index").then(m => ({ default: m.ConditionIndexHubPage })));
const ConditionIndexItemPage = lazy(() => import("@/pages/marketing/condition-index").then(m => ({ default: m.ConditionIndexItemPage })));
const GradeCheckerPage = lazy(() => import("@/pages/tools/grade-checker").then(m => ({ default: m.GradeCheckerPage })));
const RnLookupPage = lazy(() => import("@/pages/tools/rn-lookup").then(m => ({ default: m.RnLookupPage })));
const AuthenticityCheckPage = lazy(() => import("@/pages/tools/authenticity-check").then(m => ({ default: m.AuthenticityCheckPage })));
const FitCheckerPage = lazy(() => import("@/pages/tools/fit-checker").then(m => ({ default: m.FitCheckerPage })));
const CalculatorHubPage = lazy(() => import("@/pages/tools/calculators").then(m => ({ default: m.CalculatorHubPage })));
const MeasurementConverterPage = lazy(() => import("@/pages/tools/measurement-converter").then(m => ({ default: m.MeasurementConverterPage })));
const EbayFeeCalculatorPage = lazy(() => import("@/pages/tools/ebay-fee-calculator").then(m => ({ default: m.EbayFeeCalculatorPage })));
const EbayShippingCalculatorPage = lazy(() => import("@/pages/tools/ebay-shipping-calculator").then(m => ({ default: m.EbayShippingCalculatorPage })));
const PoshmarkFeeCalculatorPage = lazy(() => import("@/pages/tools/marketplace-fee-calculator").then(m => ({ default: m.PoshmarkFeeCalculatorPage })));
const MercariFeeCalculatorPage = lazy(() => import("@/pages/tools/marketplace-fee-calculator").then(m => ({ default: m.MercariFeeCalculatorPage })));
const DepopFeeCalculatorPage = lazy(() => import("@/pages/tools/marketplace-fee-calculator").then(m => ({ default: m.DepopFeeCalculatorPage })));
const EtsyFeeCalculatorPage = lazy(() => import("@/pages/tools/marketplace-fee-calculator").then(m => ({ default: m.EtsyFeeCalculatorPage })));
const ResellerProfitCalculatorPage = lazy(() => import("@/pages/tools/reseller-profit-calculator").then(m => ({ default: m.ResellerProfitCalculatorPage })));
const EbaySoldListingsPage = lazy(() => import("@/pages/tools/ebay-sold-listings").then(m => ({ default: m.EbaySoldListingsPage })));
const SingleStitchDatingPage = lazy(() => import("@/pages/tools/single-stitch-dating").then(m => ({ default: m.SingleStitchDatingPage })));
const ResellerInventorySpreadsheetPage = lazy(() => import("@/pages/tools/reseller-inventory-spreadsheet").then(m => ({ default: m.ResellerInventorySpreadsheetPage })));
const PhotographClothesToSellPage = lazy(() => import("@/pages/tools/photograph-clothes-to-sell").then(m => ({ default: m.PhotographClothesToSellPage })));
const ListingGeneratorPage = lazy(() => import("@/pages/tools/listing-generator").then(m => ({ default: m.ListingGeneratorPage })));
const ForBrandsPage = lazy(() => import("@/pages/marketing/for-brands").then(m => ({ default: m.ForBrandsPage })));
const DownloadPage = lazy(() => import("@/pages/marketing/download").then(m => ({ default: m.DownloadPage })));
const FlawLibraryHubPage = lazy(() => import("@/pages/marketing/flaw-library").then(m => ({ default: m.FlawLibraryHubPage })));
const CareMatrixPage = lazy(() => import("@/pages/marketing/care-matrix").then(m => ({ default: m.CareMatrixPage })));
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
const StyleCodeLookupPage = lazy(() => import("@/pages/marketing/style-code-lookup").then(m => ({ default: m.StyleCodeLookupPage })));
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
const FlipdeskItemPage = lazy(() => import("@/pages/flipdesk/item").then(m => ({ default: m.FlipdeskItemPage })));
const FlipdeskAnalyticsPage = lazy(() => import("@/pages/flipdesk/analytics").then(m => ({ default: m.FlipdeskAnalyticsPage })));
const FlipdeskIntakePage = lazy(() => import("@/pages/flipdesk/intake").then(m => ({ default: m.FlipdeskIntakePage })));
const FlipdeskReviewPage = lazy(() => import("@/pages/flipdesk/review").then(m => ({ default: m.FlipdeskReviewPage })));
const FlipdeskImportPage = lazy(() => import("@/pages/flipdesk/import").then(m => ({ default: m.FlipdeskImportPage })));
const FlipdeskMarketplacesPage = lazy(() => import("@/pages/flipdesk/marketplaces").then(m => ({ default: m.FlipdeskMarketplacesPage })));
const FlipdeskMeasureCardPage = lazy(() => import("@/pages/flipdesk/measure-card").then(m => ({ default: m.FlipdeskMeasureCardPage })));
const FlipdeskMarketplacesGooglePage = lazy(() => import("@/pages/flipdesk/marketplaces-google").then(m => ({ default: m.FlipdeskMarketplacesGooglePage })));
const FlipdeskOffersPage = lazy(() => import("@/pages/flipdesk/offers").then(m => ({ default: m.FlipdeskOffersPage })));
const FlipdeskPostSalePage = lazy(() => import("@/pages/flipdesk/post-sale").then(m => ({ default: m.FlipdeskPostSalePage })));
// US-2161: the two consolidated hosts. Each renders the existing pages as
// ?tab= tabs; the old paths below redirect into them.
const FlipdeskPricingPage = lazy(() => import("@/pages/flipdesk/pricing").then(m => ({ default: m.FlipdeskPricingPage })));
const FlipdeskMoneyPage = lazy(() => import("@/pages/flipdesk/money").then(m => ({ default: m.FlipdeskMoneyPage })));
const FlipdeskAutolisterHostPage = lazy(() => import("@/pages/flipdesk/autolister-host").then(m => ({ default: m.FlipdeskAutolisterHostPage })));
const FlipdeskSourcingPage = lazy(() => import("@/pages/flipdesk/sourcing").then(m => ({ default: m.FlipdeskSourcingPage })));
const BuyerDemandPage = lazy(() => import("@/pages/buyer/demand").then(m => ({ default: m.BuyerDemandPage })));
const FlipdeskConsignmentPage = lazy(() => import("@/pages/flipdesk/consignment").then(m => ({ default: m.FlipdeskConsignmentPage })));
const FlipdeskAutolisterQueuePage = lazy(() => import("@/pages/flipdesk/autolister-queue").then(m => ({ default: m.FlipdeskAutolisterQueuePage })));
const FlipdeskAutolisterBulkEditPage = lazy(() => import("@/pages/flipdesk/autolister-bulk-edit").then(m => ({ default: m.FlipdeskAutolisterBulkEditPage })));
const FlipdeskScheduledDropsPage = lazy(() => import("@/pages/flipdesk/scheduled-drops").then(m => ({ default: m.FlipdeskScheduledDropsPage })));
// US-2877: saved listing presets. The table, the CRUD API and the iOS
// editor have existed since US-674; the web could only APPLY a template.
const FlipdeskTemplatesPage = lazy(() => import("@/pages/flipdesk/templates").then(m => ({ default: m.TemplatesPage })));
const FlipdeskDescriptionSnippetsPage = lazy(() => import("@/pages/flipdesk/description-snippets").then(m => ({ default: m.FlipdeskDescriptionSnippetsPage })));
const NotFoundPage = lazy(() => import("@/pages/not-found").then(m => ({ default: m.NotFoundPage })));
// US-443: in-shell 404 that keeps the dashboard/admin chrome (sidebar + header).
const InShellNotFound = lazy(() => import("@/pages/not-found").then(m => ({ default: m.InShellNotFound })));
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

// US-2161: the pricing and sourcing clusters are consolidated into tabbed hosts.
// A bare <Navigate to="…?tab=x"> would REPLACE the incoming query string, which
// silently drops params the old page consumed — /flipdesk/scout?brand=Nike is a
// real in-app link (community-recommendations.ts), and losing the brand turns a
// one-click lookup into an empty search. So merge instead: keep every incoming
// param and add the tab.
// US-2161 (second pass): the ?view= counterpart of TabRedirect. It sets the
// OUTER view and deliberately leaves any incoming ?tab= alone, which is the
// whole reason the two parameters are separate: /reconcile?tab=payouts has to
// land on /money?view=reconcile&tab=payouts with the inner tab intact. Merging
// rather than replacing the query is not optional here — a bare <Navigate> with
// a literal query string drops every parameter already on the URL, which is the
// bug the first pass of this story found on /scout?brand=Nike.
function ViewRedirect({ to, view }: { to: string; view: string }) {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  params.set("view", view);
  return <Navigate to={`${to}?${params.toString()}`} replace />;
}

function TabRedirect({ to, tab }: { to: string; tab: string }) {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  params.set("tab", tab);
  return <Navigate to={`${to}?${params.toString()}`} replace />;
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
      // US-1855: the public Showcase / "Finds" feed. Dynamic (like /cert/:id):
      // served by the SSR Pages Function in prod, this SPA route is the dev /
      // in-app renderer and the interactive one. The facet paths mirror the
      // Function's (/finds/b/<brand>, /finds/c/<category>) so an SSR link lands
      // somewhere the SPA can render. NOT in PUBLIC_ROUTES (dynamic, not prerendered).
      // US-2576: the public Help Center. Same shape as /finds — articles are
      // database rows, so prod serves the SSR Pages Function
      // (functions/help/[[path]].ts) and these SPA routes are the in-app / dev
      // renderer. The hub is registered BEFORE the category route so the
      // one-segment path can't swallow it. NOT in PUBLIC_ROUTES: registering it
      // would bake a snapshot into dist/ that _routes.json never serves and list
      // /help in the sitemap twice (sitemap-help.xml is the Function's job).
      { path: "/help", element: <SuspenseWrapper><HelpHubPage /></SuspenseWrapper> },
      // Before /help/:category: "search" is a reserved slug (no article or
      // category can take it), so this literal path can never be shadowed.
      { path: "/help/search", element: <SuspenseWrapper><HelpSearchPage /></SuspenseWrapper> },
      { path: "/help/:category", element: <SuspenseWrapper><HelpCategoryPage /></SuspenseWrapper> },
      { path: "/help/:category/:slug", element: <SuspenseWrapper><HelpArticlePage /></SuspenseWrapper> },
      { path: "/finds", element: <SuspenseWrapper><FindsPage /></SuspenseWrapper> },
      { path: "/finds/b/:brandSlug", element: <SuspenseWrapper><FindsPage /></SuspenseWrapper> },
      { path: "/finds/c/:categorySlug", element: <SuspenseWrapper><FindsPage /></SuspenseWrapper> },
      // US-1856: the public reward leaderboards. Same shape as /finds — rankings
      // are dynamic, so prod serves the SSR Pages Function
      // (functions/leaderboards/[[path]].ts) and this SPA route is the dev /
      // in-app renderer. Facet paths mirror the Function's. NOT in PUBLIC_ROUTES.
      { path: "/leaderboards", element: <SuspenseWrapper><LeaderboardsPage /></SuspenseWrapper> },
      { path: "/leaderboards/:metric", element: <SuspenseWrapper><LeaderboardsPage /></SuspenseWrapper> },
      { path: "/leaderboards/:metric/b/:brandSlug", element: <SuspenseWrapper><LeaderboardsPage /></SuspenseWrapper> },
      { path: "/leaderboards/:metric/c/:categorySlug", element: <SuspenseWrapper><LeaderboardsPage /></SuspenseWrapper> },
      // US-1818: public opt-in buyer Trust Score profile. Client-rendered + NOINDEX
      // (private-by-default; deliberately NOT in PUBLIC_ROUTES / the sitemap).
      { path: "/trust/:handle", element: <SuspenseWrapper><TrustProfilePage /></SuspenseWrapper> },

      // Marketing pages (public, prerendered — US-302)
      { path: "/how-it-works", element: <SuspenseWrapper><HowItWorksPage /></SuspenseWrapper> },
      { path: "/pricing", element: <SuspenseWrapper><PricingPage /></SuspenseWrapper> },
      { path: "/for-resellers", element: <SuspenseWrapper><ForResellersPage /></SuspenseWrapper> },
      { path: "/flipdesk", element: <SuspenseWrapper><FlipDeskPage /></SuspenseWrapper> },
      // US-9212: the creator programme (cash), separate from the seller
      // referral link. Public so a creator can read the terms before applying.
      { path: "/partners", element: <SuspenseWrapper><PartnersPage /></SuspenseWrapper> },
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
      ...COMPETITOR_ALTERNATIVE_SLUGS.map((slug) => ({
        path: alternativePath(slug),
        element: <SuspenseWrapper><CompetitorAlternativePage slug={slug} /></SuspenseWrapper>,
      })),
      // US-9214: crosslist pair pages, explicit ahead of /reselling/:slug.
      ...CROSSLIST_PAIR_SLUGS.map((slug) => ({
        path: crosslistPairPath(slug),
        element: <SuspenseWrapper><CrosslistPairPage slug={slug} /></SuspenseWrapper>,
      })),
      // US-9209: switch-from pages, explicit for the same reason as the above.
      ...SWITCH_FROM_SLUGS.map((slug) => ({
        path: switchFromPath(slug),
        element: <SuspenseWrapper><SwitchFromPageView slug={slug} /></SuspenseWrapper>,
      })),
      { path: "/reselling/:slug", element: <SuspenseWrapper><ResellingGuidePage /></SuspenseWrapper> },
      // US-3093: the buyer-trust cluster. Its own directory, and deliberately no
      // /buying index route — there is one page, and a hub page with a single
      // link on it is a crawl target with nothing to say.
      { path: "/buying/:slug", element: <SuspenseWrapper><BuyingGuidePage /></SuspenseWrapper> },
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
      // US-2506: the Condition Index. Static hub registered before the dynamic
      // slug route so the two-segment item path can't swallow the hub.
      { path: "/condition-index", element: <SuspenseWrapper><ConditionIndexHubPage /></SuspenseWrapper> },
      { path: "/condition-index/:slug", element: <SuspenseWrapper><ConditionIndexItemPage /></SuspenseWrapper> },
      { path: "/resale-condition-report", element: <SuspenseWrapper><ResaleConditionReportPage /></SuspenseWrapper> },
      { path: "/state-of-durability", element: <SuspenseWrapper><StateOfDurabilityPage /></SuspenseWrapper> },
      { path: "/sitemap", element: <SuspenseWrapper><HtmlSitemapPage /></SuspenseWrapper> },
      { path: "/verify", element: <SuspenseWrapper><VerifyGradePage /></SuspenseWrapper> },
      { path: "/style", element: <SuspenseWrapper><StyleCodeLookupPage /></SuspenseWrapper> },
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
      // Flaw library (US-1683, moved to /care by US-9012): hub + per-flaw pages. Static /care + the
      // 2-segment flaw route outrank /grading/:slug below.
      // US-9012 moved these from /grading/flaws to /care. Old URLs 301 from
      // public/_redirects; the router does not need to know about them.
      { path: "/care", element: <SuspenseWrapper><FlawLibraryHubPage /></SuspenseWrapper> },
      { path: "/care/:flaw", element: <SuspenseWrapper><FlawPage /></SuspenseWrapper> },
      // US-9014: the flaw-crossed-with-fabric matrix. Declared AFTER /care/:flaw
      // so the one-segment route still wins for a bare flaw path.
      { path: "/care/:flaw/:fabric", element: <SuspenseWrapper><CareMatrixPage /></SuspenseWrapper> },
      // Garment-type grading guides (US-1682): hub + per-garment pages.
      { path: "/grading/guides", element: <SuspenseWrapper><GarmentGuidesHubPage /></SuspenseWrapper> },
      { path: "/grading/guides/:garment", element: <SuspenseWrapper><GarmentGuidePage /></SuspenseWrapper> },
      // US-1672: platform condition-standard pages (hub + spokes). Static
      // /grading/platform-standards + the 2-segment spoke outrank /grading/:slug.
      { path: "/grading/platform-standards", element: <SuspenseWrapper><PlatformStandardsHubPage /></SuspenseWrapper> },
      { path: "/grading/platform-standards/:platform", element: <SuspenseWrapper><PlatformStandardPage /></SuspenseWrapper> },
      // US-1678: free printable condition chart (static, before /grading/:slug).
      { path: "/grading/condition-chart", element: <SuspenseWrapper><ConditionChartPage /></SuspenseWrapper> },
      { path: "/changelog", element: <SuspenseWrapper><ChangelogPage /></SuspenseWrapper> },
      // US-1687: free grade-checker tool.
      { path: "/tools/grade-checker", element: <SuspenseWrapper><GradeCheckerPage /></SuspenseWrapper> },
      // US-9033: free RN number lookup + tag reader.
      { path: "/tools/rn-lookup", element: <SuspenseWrapper><RnLookupPage /></SuspenseWrapper> },
      // US-1771: free authenticity-check tool.
      { path: "/tools/authenticity-check", element: <SuspenseWrapper><AuthenticityCheckPage /></SuspenseWrapper> },
      // US-1780: free fit-checker tool.
      { path: "/tools/fit-checker", element: <SuspenseWrapper><FitCheckerPage /></SuspenseWrapper> },
      // US-9002/9007: the calculator family.
      { path: "/tools/calculators", element: <SuspenseWrapper><CalculatorHubPage /></SuspenseWrapper> },
      { path: "/tools/measurement-converter", element: <SuspenseWrapper><MeasurementConverterPage /></SuspenseWrapper> },
      { path: "/tools/ebay-fee-calculator", element: <SuspenseWrapper><EbayFeeCalculatorPage /></SuspenseWrapper> },
      { path: "/tools/ebay-shipping-calculator", element: <SuspenseWrapper><EbayShippingCalculatorPage /></SuspenseWrapper> },
      { path: "/tools/poshmark-fee-calculator", element: <SuspenseWrapper><PoshmarkFeeCalculatorPage /></SuspenseWrapper> },
      { path: "/tools/mercari-fee-calculator", element: <SuspenseWrapper><MercariFeeCalculatorPage /></SuspenseWrapper> },
      { path: "/tools/depop-fee-calculator", element: <SuspenseWrapper><DepopFeeCalculatorPage /></SuspenseWrapper> },
      { path: "/tools/etsy-fee-calculator", element: <SuspenseWrapper><EtsyFeeCalculatorPage /></SuspenseWrapper> },
      { path: "/tools/reseller-profit-calculator", element: <SuspenseWrapper><ResellerProfitCalculatorPage /></SuspenseWrapper> },
      { path: "/tools/ebay-sold-listings", element: <SuspenseWrapper><EbaySoldListingsPage /></SuspenseWrapper> },
      { path: "/tools/single-stitch-dating", element: <SuspenseWrapper><SingleStitchDatingPage /></SuspenseWrapper> },
      { path: "/tools/reseller-inventory-spreadsheet", element: <SuspenseWrapper><ResellerInventorySpreadsheetPage /></SuspenseWrapper> },
      { path: "/tools/photograph-clothes-to-sell", element: <SuspenseWrapper><PhotographClothesToSellPage /></SuspenseWrapper> },
      { path: "/tools/listing-generator", element: <SuspenseWrapper><ListingGeneratorPage /></SuspenseWrapper> },
      { path: "/for-brands", element: <SuspenseWrapper><ForBrandsPage /></SuspenseWrapper> },
      { path: "/download", element: <SuspenseWrapper><DownloadPage /></SuspenseWrapper> },
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
      { path: "/account-deletion", element: <SuspenseWrapper><AccountDeletionPage /></SuspenseWrapper> },
      { path: "/imprint", element: <SuspenseWrapper><ImprintPage /></SuspenseWrapper> },
      { path: "/dpa", element: <SuspenseWrapper><DpaPage /></SuspenseWrapper> },
      { path: "/subprocessors", element: <SuspenseWrapper><SubprocessorsPage /></SuspenseWrapper> },
      { path: "/dmca", element: <SuspenseWrapper><DmcaPage /></SuspenseWrapper> },
      { path: "/trademarks", element: <SuspenseWrapper><TrademarksPage /></SuspenseWrapper> },
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
          // US-9121: the OAuth consent screen. Inside ProtectedRoute so an
          // unauthenticated visit routes through login and comes back with the
          // request intact (ProtectedRoute preserves pathname AND search), and
          // OUTSIDE DashboardLayout because a sidebar on a decision this size is
          // an invitation to click something else.
          //
          // NOT in PUBLIC_ROUTES and NOT prerendered, deliberately: this page
          // only means anything with a live authorization request in its query
          // string, so an indexed copy would be a permanently broken result.
          { path: "/connect/claude", element: <SuspenseWrapper><ConnectClaudePage /></SuspenseWrapper> },
          {
            element: <SuspenseWrapper><DashboardLayout /></SuspenseWrapper>,
            children: [
              { path: "/dashboard", element: <SuspenseWrapper><DashboardPage /></SuspenseWrapper> },
              { path: "/dashboard/snap", element: <SuspenseWrapper><SnapToValuePage /></SuspenseWrapper> },
              // US-2865: the worked example. Read-only, no queries, no writes.
              { path: "/dashboard/example", element: <SuspenseWrapper><ExamplePage /></SuspenseWrapper> },
              { path: "/dashboard/submissions", element: <SuspenseWrapper><SubmissionsPage /></SuspenseWrapper> },
              { path: "/dashboard/rewards", element: <SuspenseWrapper><RewardsPage /></SuspenseWrapper> },
              { path: "/dashboard/submissions/new", element: <SuspenseWrapper><NewSubmissionPage /></SuspenseWrapper> },
              { path: "/dashboard/submissions/bulk", element: <SuspenseWrapper><BulkSubmissionPage /></SuspenseWrapper> },
              { path: "/dashboard/submissions/:id", element: <SuspenseWrapper><SubmissionDetailPage /></SuspenseWrapper> },
              // US-740: consolidated into the FlipDesk inventory (the canonical
              // multi-view surface). Legacy routes redirect so all inbound links
              // (sidebar, finances, price-suggestions, dashboard) keep working.
              { path: "/dashboard/inventory", element: <Navigate to="/dashboard/flipdesk/inventory" replace /> },
              { path: "/dashboard/inventory/new", element: <Navigate to="/dashboard/flipdesk/intake" replace /> },
              { path: "/dashboard/inventory/:id", element: <InventoryItemRedirect /> },
              { path: "/dashboard/finances", element: <ViewRedirect to="/dashboard/flipdesk/money" view="finances" /> },
              // US-1777: buyer body-profile store (measurements for fit checks).
              { path: "/dashboard/measurements", element: <SuspenseWrapper><BodyProfilesPage /></SuspenseWrapper> },
              { path: "/dashboard/analytics/suggestions", element: <TabRedirect to="/dashboard/flipdesk/pricing" tab="suggestions" /> },
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
              // One item editor at every status, so /draft is now an ALIAS for
              // the item page rather than a second, narrower surface. Dozens of
              // links (AutoLister, scheduled drops, publish blockers with
              // ?focus=) still point here, and they all keep working.
              { path: "/dashboard/flipdesk/items/:id/draft", element: <SuspenseWrapper><FlipdeskItemPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/intake", element: <SuspenseWrapper><FlipdeskIntakePage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/review/:id", element: <SuspenseWrapper><FlipdeskReviewPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/prep", element: <InventoryModeRedirect mode="prep" /> },
              { path: "/dashboard/flipdesk/import", element: <SuspenseWrapper><FlipdeskImportPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/autolister", element: <SuspenseWrapper><FlipdeskAutolisterHostPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/autolister/queue", element: <SuspenseWrapper><FlipdeskAutolisterQueuePage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/autolister/bulk-edit", element: <SuspenseWrapper><FlipdeskAutolisterBulkEditPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/autolister/drafts", element: <ViewRedirect to="/dashboard/flipdesk/autolister" view="drafts" /> },
          { path: "/dashboard/flipdesk/scheduled-drops", element: <SuspenseWrapper><FlipdeskScheduledDropsPage /></SuspenseWrapper> },
          { path: "/dashboard/flipdesk/templates", element: <SuspenseWrapper><FlipdeskTemplatesPage /></SuspenseWrapper> },
          { path: "/dashboard/flipdesk/settings/blocks", element: <SuspenseWrapper><FlipdeskDescriptionSnippetsPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/pipeline", element: <InventoryModeRedirect mode="kanban" /> },
              { path: "/dashboard/flipdesk/listings", element: <InventoryModeRedirect /> },
              { path: "/dashboard/flipdesk/verified", element: <SuspenseWrapper><FlipdeskVerifiedPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/sources", element: <TabRedirect to="/dashboard/flipdesk/sourcing" tab="sources" /> },
              { path: "/dashboard/flipdesk/demand", element: <TabRedirect to="/dashboard/flipdesk/sourcing" tab="demand" /> },
              { path: "/dashboard/flipdesk/consignment", element: <SuspenseWrapper><FlipdeskConsignmentPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/marketplaces", element: <SuspenseWrapper><FlipdeskMarketplacesPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/measure-card", element: <SuspenseWrapper><FlipdeskMeasureCardPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/offers", element: <SuspenseWrapper><FlipdeskOffersPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/post-sale", element: <SuspenseWrapper><FlipdeskPostSalePage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/bulk-pricing", element: <TabRedirect to="/dashboard/flipdesk/pricing" tab="bulk" /> },
              { path: "/dashboard/flipdesk/marketplaces/google", element: <SuspenseWrapper><FlipdeskMarketplacesGooglePage /></SuspenseWrapper> },
              // US-963: the standalone Reconciliation page is now the "eBay SKU
              // match" / "Payouts & fees" tabs of the unified Reconcile area.
              { path: "/dashboard/flipdesk/reconciliation", element: <Navigate to="/dashboard/flipdesk/money?view=reconcile&tab=ebay" replace /> },
              { path: "/dashboard/flipdesk/money", element: <SuspenseWrapper><FlipdeskMoneyPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/reconcile", element: <ViewRedirect to="/dashboard/flipdesk/money" view="reconcile" /> },
              { path: "/dashboard/flipdesk/repricing", element: <TabRedirect to="/dashboard/flipdesk/pricing" tab="repricing" /> },
              // US-2161: the four pricing surfaces are one destination now. These four
              // paths redirect rather than 404 so deep links, the command palette and
              // flipdesk-search all keep working.
              { path: "/dashboard/flipdesk/automations", element: <TabRedirect to="/dashboard/flipdesk/pricing" tab="automations" /> },
              { path: "/dashboard/flipdesk/pricing", element: <SuspenseWrapper><FlipdeskPricingPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/sourcing", element: <SuspenseWrapper><FlipdeskSourcingPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/scout", element: <TabRedirect to="/dashboard/flipdesk/sourcing" tab="scout" /> },
              { path: "/dashboard/flipdesk/scout/buy", element: <TabRedirect to="/dashboard/flipdesk/sourcing" tab="buy" /> },
              { path: "/dashboard/flipdesk/expenses", element: <ViewRedirect to="/dashboard/flipdesk/money" view="expenses" /> },
              { path: "/dashboard/flipdesk/analytics", element: <SuspenseWrapper><FlipdeskAnalyticsPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/analytics/grading-roi", element: <SuspenseWrapper><FlipdeskAnalyticsPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/analytics/returns", element: <SuspenseWrapper><FlipdeskAnalyticsPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/analytics/price-curve", element: <SuspenseWrapper><FlipdeskAnalyticsPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/analytics/performance", element: <SuspenseWrapper><FlipdeskAnalyticsPage /></SuspenseWrapper> },
              // US-3019: the sourcing team's scorecard. Same host as every other
              // analytics tab, which reads the tab off the pathname.
              { path: "/dashboard/flipdesk/analytics/team", element: <SuspenseWrapper><FlipdeskAnalyticsPage /></SuspenseWrapper> },
              // US-2161: Community Insights is an Analytics tab now; the old path keeps
              // working via the analytics host, which reads the tab off the pathname.
              { path: "/dashboard/flipdesk/community", element: <Navigate to="/dashboard/flipdesk/analytics/community" replace /> },
              { path: "/dashboard/flipdesk/analytics/community", element: <SuspenseWrapper><FlipdeskAnalyticsPage /></SuspenseWrapper> },
              { path: "/dashboard/account", element: <SuspenseWrapper><AccountPage /></SuspenseWrapper> },
              // US-2511: the five legacy account paths render the Account HUB
              // with their tab preselected, so an in-app or emailed link no
              // longer lands on a tab-less version of the page. They RENDER
              // rather than redirect because Stripe checkout returns, the
              // cancellation link, the drip CTA, the unsubscribe deep-link and
              // Stripe Connect's return all point here — see the comment on
              // AccountPage's initialTab prop.
              { path: "/dashboard/settings", element: <SuspenseWrapper><AccountPage initialTab="settings" /></SuspenseWrapper> },
              // US-2583: the members-only docs reader. noindex on every page,
              // and /dashboard is already disallowed in robots.txt.
              { path: "/dashboard/help", element: <SuspenseWrapper><HelpReaderPage /></SuspenseWrapper> },
              // US-2864: BEFORE the :slug route, or "glossary" is read as an
              // article slug and the page 404s inside the reader.
              { path: "/dashboard/help/glossary", element: <SuspenseWrapper><GlossaryPage /></SuspenseWrapper> },
              { path: "/dashboard/help/:slug", element: <SuspenseWrapper><HelpReaderPage /></SuspenseWrapper> },
              { path: "/dashboard/support", element: <SuspenseWrapper><SupportTicketsPage /></SuspenseWrapper> },
              { path: "/dashboard/support/:id", element: <SuspenseWrapper><SupportTicketsPage /></SuspenseWrapper> },
              { path: "/dashboard/billing", element: <SuspenseWrapper><AccountPage initialTab="billing" /></SuspenseWrapper> },
              // US-2554: the developer surface is its own destination now. What
              // lived in an Account tab is a whole product — keys, usage, overage,
              // white-label embeds and the docs entry points — and an Account tab is
              // where you change your password, not where you integrate an API.
              { path: "/dashboard/developers", element: <SuspenseWrapper><ApiKeysPage /></SuspenseWrapper> },
              // KEPT, not redirected: Stripe returns the API-overage checkout to
              // /dashboard/api-keys?checkout=success (payments.ts:1104), and US-2511
              // is explicit that a money path never gets an extra client-side hop.
              { path: "/dashboard/api-keys", element: <SuspenseWrapper><AccountPage initialTab="api-keys" /></SuspenseWrapper> },
              { path: "/dashboard/team", element: <SuspenseWrapper><AccountPage initialTab="team" /></SuspenseWrapper> },
              { path: "/dashboard/referrals", element: <SuspenseWrapper><AccountPage initialTab="referrals" /></SuspenseWrapper> },
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
                  // US-2509: a real 404, not the coming-soon component. This
                  // used to render BuyerPlaceholderPage, whose unlocked branch
                  // draws a Sparkles icon over "coming soon" copy — so a
                  // mistyped buyer URL read as an unshipped feature. The seller
                  // side has used InShellNotFound for exactly this since US-443.
                  { path: "/buyer/*", element: <SuspenseWrapper><InShellNotFound homeTo="/buyer" homeLabel="Back to buyer home" /></SuspenseWrapper> },
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
