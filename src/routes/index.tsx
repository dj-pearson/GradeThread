// This file is a router definition module — every lazy() page binding the
// rule treats as a component declaration, but they're consumed only by the
// router config below. Fast-refresh constraints don't apply here.
/* eslint-disable react-refresh/only-export-components */
import { lazy as reactLazy, Suspense, type ComponentType } from "react";
import { createBrowserRouter, Navigate, useLocation } from "react-router-dom";
import { RootLayout } from "@/layouts/root-layout";
import { RouteErrorFallback } from "@/components/error-boundary";

// Wrap React.lazy so a failed dynamic import doesn't hard-crash the route.
// A rejected import() almost always means a new deploy replaced the hashed
// chunk this (older) page references, so the asset now 404s and Cloudflare's
// SPA fallback serves index.html — yielding the "expected a JS module but got
// text/html" MIME error. Reloading once fetches the fresh index + chunk map.
// A sessionStorage flag prevents an infinite reload loop if the chunk is
// genuinely missing (a broken deploy); the flag is cleared on any success.
const CHUNK_RELOAD_KEY = "chunk-reload-once";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirror React.lazy's own ComponentType<any> so components with props stay assignable
function lazy<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
) {
  return reactLazy(() =>
    factory()
      .then((mod) => {
        sessionStorage.removeItem(CHUNK_RELOAD_KEY);
        return mod;
      })
      .catch((err: unknown) => {
        if (!sessionStorage.getItem(CHUNK_RELOAD_KEY)) {
          sessionStorage.setItem(CHUNK_RELOAD_KEY, "1");
          window.location.reload();
          // Never resolve — keep the Suspense fallback up during the reload.
          return new Promise<{ default: T }>(() => {});
        }
        throw err;
      }),
  );
}

// RootLayout stays eager (it renders on the first paint of every route). The
// authenticated layouts + auth guards are lazy: they pull Supabase, react-query
// and radix, and none of that is needed to render the public/landing pages —
// keeping them out of the eager entry chunk is the big mobile-LCP win (the
// landing page was shipping ~80KB gz of supabase+radix it never used).
const AuthLayout = lazy(() => import("@/layouts/auth-layout").then(m => ({ default: m.AuthLayout })));
const DashboardLayout = lazy(() => import("@/layouts/dashboard-layout").then(m => ({ default: m.DashboardLayout })));
const AdminLayout = lazy(() => import("@/layouts/admin-layout").then(m => ({ default: m.AdminLayout })));
const ProtectedRoute = lazy(() => import("@/components/auth/protected-route").then(m => ({ default: m.ProtectedRoute })));
const AdminRoute = lazy(() => import("@/components/auth/admin-route").then(m => ({ default: m.AdminRoute })));

// Lazy-loaded pages for code splitting
const LandingPage = lazy(() => import("@/pages/landing").then(m => ({ default: m.LandingPage })));
const LoginPage = lazy(() => import("@/pages/login").then(m => ({ default: m.LoginPage })));
const SignupPage = lazy(() => import("@/pages/signup").then(m => ({ default: m.SignupPage })));
const AuthCallbackPage = lazy(() => import("@/pages/auth-callback").then(m => ({ default: m.AuthCallbackPage })));
const ResetPasswordPage = lazy(() => import("@/pages/reset-password").then(m => ({ default: m.ResetPasswordPage })));
const DashboardPage = lazy(() => import("@/pages/dashboard").then(m => ({ default: m.DashboardPage })));
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
const PriceSuggestionsPage = lazy(() => import("@/pages/price-suggestions").then(m => ({ default: m.PriceSuggestionsPage })));
const CertificatePage = lazy(() => import("@/pages/certificate").then(m => ({ default: m.CertificatePage })));
const VerifiedSellerPage = lazy(() => import("@/pages/verified-seller").then(m => ({ default: m.VerifiedSellerPage })));
const FlipdeskVerifiedPage = lazy(() => import("@/pages/flipdesk/verified").then(m => ({ default: m.FlipdeskVerifiedPage })));
// Public status page (US-500) — live component health probed from the
// visitor's browser. Dynamic, NOT registered in PUBLIC_ROUTES (no prerender).
const StatusPage = lazy(() => import("@/pages/status").then(m => ({ default: m.StatusPage })));
const WaitlistPendingPage = lazy(() => import("@/pages/waitlist-pending").then(m => ({ default: m.WaitlistPendingPage })));
const PrivacyPage = lazy(() => import("@/pages/legal/privacy").then(m => ({ default: m.PrivacyPage })));
const TermsPage = lazy(() => import("@/pages/legal/terms").then(m => ({ default: m.TermsPage })));
const CookiesPage = lazy(() => import("@/pages/legal/cookies").then(m => ({ default: m.CookiesPage })));
const AcceptableUsePage = lazy(() => import("@/pages/legal/acceptable-use").then(m => ({ default: m.AcceptableUsePage })));
const DpaPage = lazy(() => import("@/pages/legal/dpa").then(m => ({ default: m.DpaPage })));
const SubprocessorsPage = lazy(() => import("@/pages/legal/subprocessors").then(m => ({ default: m.SubprocessorsPage })));
const DmcaPage = lazy(() => import("@/pages/legal/dmca").then(m => ({ default: m.DmcaPage })));
const AccessibilityPage = lazy(() => import("@/pages/legal/accessibility").then(m => ({ default: m.AccessibilityPage })));
// Evergreen marketing pages (US-302) — public, prerendered, indexable.
const HowItWorksPage = lazy(() => import("@/pages/marketing/how-it-works").then(m => ({ default: m.HowItWorksPage })));
const PricingPage = lazy(() => import("@/pages/marketing/pricing").then(m => ({ default: m.PricingPage })));
const ForResellersPage = lazy(() => import("@/pages/marketing/for-resellers").then(m => ({ default: m.ForResellersPage })));
const FaqPage = lazy(() => import("@/pages/marketing/faq").then(m => ({ default: m.FaqPage })));
const ConditionGradingPage = lazy(() => import("@/pages/marketing/condition-grading").then(m => ({ default: m.ConditionGradingPage })));
const GradingStandardPage = lazy(() => import("@/pages/marketing/grading-standard").then(m => ({ default: m.GradingStandardPage })));
const TransparencyPage = lazy(() => import("@/pages/marketing/transparency").then(m => ({ default: m.TransparencyPage })));
const VerifyGradePage = lazy(() => import("@/pages/marketing/verify").then(m => ({ default: m.VerifyGradePage })));
const DevelopersPage = lazy(() => import("@/pages/marketing/developers").then(m => ({ default: m.DevelopersPage })));
// US-596: white-label embeddable grade widget — bare (no app chrome), rendered
// inside partner iframes. Dynamic per certificate, NOT in PUBLIC_ROUTES.
const EmbedGradePage = lazy(() => import("@/pages/embed-grade").then(m => ({ default: m.EmbedGradePage })));
const GradingGlossaryPage = lazy(() => import("@/pages/marketing/grading-glossary").then(m => ({ default: m.GradingGlossaryPage })));
const FlipdeskOverviewPage = lazy(() => import("@/pages/flipdesk/overview").then(m => ({ default: m.FlipdeskOverviewPage })));
const FlipdeskPipelinePage = lazy(() => import("@/pages/flipdesk/pipeline").then(m => ({ default: m.FlipdeskPipelinePage })));
const FlipdeskListingsPage = lazy(() => import("@/pages/flipdesk/listings").then(m => ({ default: m.FlipdeskListingsPage })));
// FlipdeskItemsPage was the legacy power-user table. Its features (saved
// views, filter builder, CSV export, bulk AI enrich) now live on the
// canonical Inventory page (FlipdeskListingsPage) — the /items URL is kept
// as a redirect below so saved-view links from before the consolidation
// still resolve cleanly.
const FlipdeskGridPage = lazy(() => import("@/pages/flipdesk/grid").then(m => ({ default: m.FlipdeskGridPage })));
const FlipdeskComposerPage = lazy(() => import("@/pages/flipdesk/composer").then(m => ({ default: m.FlipdeskComposerPage })));
const FlipdeskItemPage = lazy(() => import("@/pages/flipdesk/item").then(m => ({ default: m.FlipdeskItemPage })));
const FlipdeskPrepPage = lazy(() => import("@/pages/flipdesk/prep").then(m => ({ default: m.FlipdeskPrepPage })));
const FlipdeskExpensesPage = lazy(() => import("@/pages/flipdesk/expenses").then(m => ({ default: m.FlipdeskExpensesPage })));
const FlipdeskAnalyticsPage = lazy(() => import("@/pages/flipdesk/analytics").then(m => ({ default: m.FlipdeskAnalyticsPage })));
const FlipdeskListingPerformancePage = lazy(() => import("@/pages/flipdesk/listing-performance").then(m => ({ default: m.FlipdeskListingPerformancePage })));
const FlipdeskIntakePage = lazy(() => import("@/pages/flipdesk/intake").then(m => ({ default: m.FlipdeskIntakePage })));
const FlipdeskImportPage = lazy(() => import("@/pages/flipdesk/import").then(m => ({ default: m.FlipdeskImportPage })));
const FlipdeskMarketplacesPage = lazy(() => import("@/pages/flipdesk/marketplaces").then(m => ({ default: m.FlipdeskMarketplacesPage })));
const FlipdeskMarketplacesGooglePage = lazy(() => import("@/pages/flipdesk/marketplaces-google").then(m => ({ default: m.FlipdeskMarketplacesGooglePage })));
const FlipdeskReconciliationPage = lazy(() => import("@/pages/flipdesk/reconciliation").then(m => ({ default: m.FlipdeskReconciliationPage })));
const FlipdeskReconcilePage = lazy(() => import("@/pages/flipdesk/reconcile").then(m => ({ default: m.FlipdeskReconcilePage })));
const FlipdeskRepricingPage = lazy(() => import("@/pages/flipdesk/repricing").then(m => ({ default: m.FlipdeskRepricingPage })));
const FlipdeskAutomationsPage = lazy(() => import("@/pages/flipdesk/automations").then(m => ({ default: m.FlipdeskAutomationsPage })));
const FlipdeskScoutPage = lazy(() => import("@/pages/flipdesk/scout").then(m => ({ default: m.FlipdeskScoutPage })));
const FlipdeskScoutBuyPage = lazy(() => import("@/pages/flipdesk/scout-buy").then(m => ({ default: m.FlipdeskScoutBuyPage })));
const FlipdeskSourcesPage = lazy(() => import("@/pages/flipdesk/sources").then(m => ({ default: m.FlipdeskSourcesPage })));
const FlipdeskAutolisterPage = lazy(() => import("@/pages/flipdesk/autolister").then(m => ({ default: m.FlipdeskAutolisterPage })));
const FlipdeskAutolisterQueuePage = lazy(() => import("@/pages/flipdesk/autolister-queue").then(m => ({ default: m.FlipdeskAutolisterQueuePage })));
const FlipdeskAutolisterBulkEditPage = lazy(() => import("@/pages/flipdesk/autolister-bulk-edit").then(m => ({ default: m.FlipdeskAutolisterBulkEditPage })));
const FlipdeskAutolisterDraftsPage = lazy(() => import("@/pages/flipdesk/autolister-drafts").then(m => ({ default: m.FlipdeskAutolisterDraftsPage })));
const FlipdeskScheduledDropsPage = lazy(() => import("@/pages/flipdesk/scheduled-drops").then(m => ({ default: m.FlipdeskScheduledDropsPage })));
const BlogListPage = lazy(() => import("@/pages/content/blog-list").then(m => ({ default: m.BlogListPage })));
const BlogEditorPage = lazy(() => import("@/pages/content/blog-editor").then(m => ({ default: m.BlogEditorPage })));
const SocialListPage = lazy(() => import("@/pages/content/social-list").then(m => ({ default: m.SocialListPage })));
const SocialEditorPage = lazy(() => import("@/pages/content/social-editor").then(m => ({ default: m.SocialEditorPage })));
const TopicBankPage = lazy(() => import("@/pages/content/topic-bank").then(m => ({ default: m.TopicBankPage })));
const KnowledgePage = lazy(() => import("@/pages/content/knowledge").then(m => ({ default: m.KnowledgePage })));
const ContentSettingsPage = lazy(() => import("@/pages/content/content-settings").then(m => ({ default: m.ContentSettingsPage })));
const ContentAnalyticsPage = lazy(() => import("@/pages/content/analytics").then(m => ({ default: m.ContentAnalyticsPage })));
const NotFoundPage = lazy(() => import("@/pages/not-found").then(m => ({ default: m.NotFoundPage })));
// US-443: in-shell 404 that keeps the dashboard/admin chrome (sidebar + header).
const InShellNotFound = lazy(() => import("@/pages/not-found").then(m => ({ default: m.InShellNotFound })));
const AdminDashboardPage = lazy(() => import("@/pages/admin/dashboard").then(m => ({ default: m.AdminDashboardPage })));
const AdminUsersPage = lazy(() => import("@/pages/admin/users").then(m => ({ default: m.AdminUsersPage })));
const AdminSubmissionsPage = lazy(() => import("@/pages/admin/submissions").then(m => ({ default: m.AdminSubmissionsPage })));
const AdminReviewsPage = lazy(() => import("@/pages/admin/reviews").then(m => ({ default: m.AdminReviewsPage })));
const AdminAiModelsPage = lazy(() => import("@/pages/admin/ai-models").then(m => ({ default: m.AdminAiModelsPage })));
const AdminReliabilityPage = lazy(() => import("@/pages/admin/reliability").then(m => ({ default: m.AdminReliabilityPage })));
const AdminSeoPage = lazy(() => import("@/pages/admin/seo").then(m => ({ default: m.AdminSeoPage })));
const AdminUserDetailPage = lazy(() => import("@/pages/admin/user-detail").then(m => ({ default: m.AdminUserDetailPage })));
const AdminDisputesPage = lazy(() => import("@/pages/admin/disputes").then(m => ({ default: m.AdminDisputesPage })));
const AdminSystemPage = lazy(() => import("@/pages/admin/system").then(m => ({ default: m.AdminSystemPage })));
const AdminJobsPage = lazy(() => import("@/pages/admin/jobs").then(m => ({ default: m.AdminJobsPage })));
const AdminAuditLogPage = lazy(() => import("@/pages/admin/audit-log").then(m => ({ default: m.AdminAuditLogPage })));
const AdminModerationPage = lazy(() => import("@/pages/admin/moderation").then(m => ({ default: m.AdminModerationPage })));
const AdminFraudPage = lazy(() => import("@/pages/admin/fraud").then(m => ({ default: m.AdminFraudPage })));
const AdminCouponsPage = lazy(() => import("@/pages/admin/coupons").then(m => ({ default: m.AdminCouponsPage })));
const AdminPricingPage = lazy(() => import("@/pages/admin/pricing").then(m => ({ default: m.AdminPricingPage })));
const AdminWaitlistPage = lazy(() => import("@/pages/admin/waitlist").then(m => ({ default: m.AdminWaitlistPage })));
const AdminTasksPage = lazy(() => import("@/pages/admin/tasks").then(m => ({ default: m.AdminTasksPage })));
const AdminTaskBoardPage = lazy(() => import("@/pages/admin/task-board").then(m => ({ default: m.AdminTaskBoardPage })));
const GrowthDashboardPage = lazy(() => import("@/pages/admin/growth/dashboard").then(m => ({ default: m.GrowthDashboardPage })));
const GrowthSegmentsPage = lazy(() => import("@/pages/admin/growth/segments").then(m => ({ default: m.GrowthSegmentsPage })));
const GrowthCampaignsPage = lazy(() => import("@/pages/admin/growth/campaigns").then(m => ({ default: m.GrowthCampaignsPage })));
const GrowthAnnouncementsPage = lazy(() => import("@/pages/admin/growth/announcements").then(m => ({ default: m.GrowthAnnouncementsPage })));
const GrowthReferralsPage = lazy(() => import("@/pages/admin/growth/referrals").then(m => ({ default: m.GrowthReferralsPage })));
const ReferralsPage = lazy(() => import("@/pages/referrals").then(m => ({ default: m.ReferralsPage })));

function PageLoader() {
  // Live region (US-452): the bare spinner is decorative, so announce the load
  // politely with an sr-only label rather than leaving SR users in silence.
  return (
    <div
      className="flex h-64 items-center justify-center"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="sr-only">Loading page…</span>
      <div
        className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"
        aria-hidden="true"
      />
    </div>
  );
}

function SuspenseWrapper({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageLoader />}>{children}</Suspense>;
}

// The content module moved from /dashboard/content/* into the admin dashboard
// (/admin/content/*). This redirect keeps old bookmarks/links working by
// swapping the path prefix while preserving the sub-path, params and query.
function ContentRedirect() {
  const { pathname, search } = useLocation();
  const target = pathname.replace(/^\/dashboard\/content/, "/admin/content");
  return <Navigate to={`${target}${search}`} replace />;
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
      // GradeThread Verified — public seller trust profile. Dynamic (like
      // /cert/:id): served by the SSR Pages Function in prod; this SPA route is
      // the dev / in-app fallback. NOT registered in PUBLIC_ROUTES (dynamic).
      { path: "/verified/:handle", element: <SuspenseWrapper><VerifiedSellerPage /></SuspenseWrapper> },

      // Marketing pages (public, prerendered — US-302)
      { path: "/how-it-works", element: <SuspenseWrapper><HowItWorksPage /></SuspenseWrapper> },
      { path: "/pricing", element: <SuspenseWrapper><PricingPage /></SuspenseWrapper> },
      { path: "/for-resellers", element: <SuspenseWrapper><ForResellersPage /></SuspenseWrapper> },
      { path: "/faq", element: <SuspenseWrapper><FaqPage /></SuspenseWrapper> },
      { path: "/condition-grading", element: <SuspenseWrapper><ConditionGradingPage /></SuspenseWrapper> },
      { path: "/grading-standard", element: <SuspenseWrapper><GradingStandardPage /></SuspenseWrapper> },
      { path: "/transparency", element: <SuspenseWrapper><TransparencyPage /></SuspenseWrapper> },
      { path: "/verify", element: <SuspenseWrapper><VerifyGradePage /></SuspenseWrapper> },
      { path: "/developers", element: <SuspenseWrapper><DevelopersPage /></SuspenseWrapper> },
      // Glossary hub spokes (US-303): one page per grade tier + factor, served
      // by a single dynamic route. The indexable set is registered in
      // PUBLIC_ROUTES (via glossaryRoutes()) and prerendered individually.
      { path: "/grading/:slug", element: <SuspenseWrapper><GradingGlossaryPage /></SuspenseWrapper> },

      // System status (public, US-500)
      { path: "/status", element: <SuspenseWrapper><StatusPage /></SuspenseWrapper> },

      // US-585: waitlist-pending — shown when a signed-in account isn't yet
      // approved while the launch gate is active (edge-fetch redirects here).
      { path: "/waitlist-pending", element: <SuspenseWrapper><WaitlistPendingPage /></SuspenseWrapper> },

      // Legal pages (public)
      { path: "/privacy", element: <SuspenseWrapper><PrivacyPage /></SuspenseWrapper> },
      { path: "/terms", element: <SuspenseWrapper><TermsPage /></SuspenseWrapper> },
      { path: "/cookies", element: <SuspenseWrapper><CookiesPage /></SuspenseWrapper> },
      { path: "/acceptable-use", element: <SuspenseWrapper><AcceptableUsePage /></SuspenseWrapper> },
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

      // Workspace invitation acceptance — works for both signed-in and
      // signed-out users. The page redirects to /signup or /login as
      // needed and resumes after auth.
      { path: "/accept-invite", element: <SuspenseWrapper><AcceptInvitePage /></SuspenseWrapper> },

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
              { path: "/dashboard/analytics/suggestions", element: <SuspenseWrapper><PriceSuggestionsPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk", element: <SuspenseWrapper><FlipdeskOverviewPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/overview", element: <SuspenseWrapper><FlipdeskOverviewPage /></SuspenseWrapper> },
              // ── Consolidated Inventory surface ──────────────────────────
              // /inventory is the new canonical home (table view); /grid and
              // /kanban host the photo-card + pipeline shapes of the same data.
              // The pre-consolidation URLs (/items, /grid, /pipeline, /listings,
              // /prep) stay live below so saved views + bookmarks keep working.
              { path: "/dashboard/flipdesk/inventory", element: <SuspenseWrapper><FlipdeskListingsPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/inventory/grid", element: <SuspenseWrapper><FlipdeskGridPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/inventory/kanban", element: <SuspenseWrapper><FlipdeskPipelinePage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/inventory/prep", element: <SuspenseWrapper><FlipdeskPrepPage /></SuspenseWrapper> },
              // Legacy paths — still resolve so links don't break.
              // /items now redirects to /inventory (preserving query params).
              { path: "/dashboard/flipdesk/items", element: <Navigate to="/dashboard/flipdesk/inventory" replace /> },
              { path: "/dashboard/flipdesk/grid", element: <SuspenseWrapper><FlipdeskGridPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/items/:id", element: <SuspenseWrapper><FlipdeskItemPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/items/:id/draft", element: <SuspenseWrapper><FlipdeskComposerPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/intake", element: <SuspenseWrapper><FlipdeskIntakePage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/prep", element: <SuspenseWrapper><FlipdeskPrepPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/import", element: <SuspenseWrapper><FlipdeskImportPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/autolister", element: <SuspenseWrapper><FlipdeskAutolisterPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/autolister/queue", element: <SuspenseWrapper><FlipdeskAutolisterQueuePage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/autolister/bulk-edit", element: <SuspenseWrapper><FlipdeskAutolisterBulkEditPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/autolister/drafts", element: <SuspenseWrapper><FlipdeskAutolisterDraftsPage /></SuspenseWrapper> },
          { path: "/dashboard/flipdesk/scheduled-drops", element: <SuspenseWrapper><FlipdeskScheduledDropsPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/pipeline", element: <SuspenseWrapper><FlipdeskPipelinePage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/listings", element: <SuspenseWrapper><FlipdeskListingsPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/verified", element: <SuspenseWrapper><FlipdeskVerifiedPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/sources", element: <SuspenseWrapper><FlipdeskSourcesPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/marketplaces", element: <SuspenseWrapper><FlipdeskMarketplacesPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/marketplaces/google", element: <SuspenseWrapper><FlipdeskMarketplacesGooglePage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/reconciliation", element: <SuspenseWrapper><FlipdeskReconciliationPage /></SuspenseWrapper> },
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
              { path: "/dashboard/account", element: <SuspenseWrapper><AccountPage /></SuspenseWrapper> },
              { path: "/dashboard/settings", element: <SuspenseWrapper><SettingsPage /></SuspenseWrapper> },
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
        ],
      },

      // Admin routes (admin/super_admin only)
      {
        element: <SuspenseWrapper><AdminRoute /></SuspenseWrapper>,
        children: [
          {
            element: <SuspenseWrapper><AdminLayout /></SuspenseWrapper>,
            children: [
              { path: "/admin", element: <SuspenseWrapper><AdminDashboardPage /></SuspenseWrapper> },
              { path: "/admin/users", element: <SuspenseWrapper><AdminUsersPage /></SuspenseWrapper> },
              { path: "/admin/users/:id", element: <SuspenseWrapper><AdminUserDetailPage /></SuspenseWrapper> },
              { path: "/admin/submissions", element: <SuspenseWrapper><AdminSubmissionsPage /></SuspenseWrapper> },
              { path: "/admin/reviews", element: <SuspenseWrapper><AdminReviewsPage /></SuspenseWrapper> },
              { path: "/admin/disputes", element: <SuspenseWrapper><AdminDisputesPage /></SuspenseWrapper> },
              { path: "/admin/ai-models", element: <SuspenseWrapper><AdminAiModelsPage /></SuspenseWrapper> },
              { path: "/admin/reliability", element: <SuspenseWrapper><AdminReliabilityPage /></SuspenseWrapper> },
              { path: "/admin/seo", element: <SuspenseWrapper><AdminSeoPage /></SuspenseWrapper> },
              { path: "/admin/system", element: <SuspenseWrapper><AdminSystemPage /></SuspenseWrapper> },
              { path: "/admin/jobs", element: <SuspenseWrapper><AdminJobsPage /></SuspenseWrapper> },
              { path: "/admin/audit-log", element: <SuspenseWrapper><AdminAuditLogPage /></SuspenseWrapper> },
              { path: "/admin/coupons", element: <SuspenseWrapper><AdminCouponsPage /></SuspenseWrapper> },
              { path: "/admin/pricing", element: <SuspenseWrapper><AdminPricingPage /></SuspenseWrapper> },
              { path: "/admin/waitlist", element: <SuspenseWrapper><AdminWaitlistPage /></SuspenseWrapper> },
              { path: "/admin/moderation", element: <SuspenseWrapper><AdminModerationPage /></SuspenseWrapper> },
              { path: "/admin/fraud", element: <SuspenseWrapper><AdminFraudPage /></SuspenseWrapper> },
              { path: "/admin/tasks", element: <SuspenseWrapper><AdminTasksPage /></SuspenseWrapper> },
              { path: "/admin/tasks/:id", element: <SuspenseWrapper><AdminTaskBoardPage /></SuspenseWrapper> },
              // Growth / Promote suite (US-632) — admin + super_admin; the
              // broadcast/send action is additionally super_admin-gated server-side.
              { path: "/admin/growth", element: <SuspenseWrapper><GrowthDashboardPage /></SuspenseWrapper> },
              { path: "/admin/growth/segments", element: <SuspenseWrapper><GrowthSegmentsPage /></SuspenseWrapper> },
              { path: "/admin/growth/campaigns", element: <SuspenseWrapper><GrowthCampaignsPage /></SuspenseWrapper> },
              { path: "/admin/growth/announcements", element: <SuspenseWrapper><GrowthAnnouncementsPage /></SuspenseWrapper> },
              { path: "/admin/growth/referrals", element: <SuspenseWrapper><GrowthReferralsPage /></SuspenseWrapper> },
              // Content module — blog, social, topic bank, knowledge base,
              // analytics + settings. Lives in the admin dashboard (admin +
              // super_admin), behind the AdminMfaGate like every other admin
              // surface. Moved here from /dashboard/content/* (US: content move).
              { path: "/admin/content/blog", element: <SuspenseWrapper><BlogListPage /></SuspenseWrapper> },
              { path: "/admin/content/blog/editor/:id", element: <SuspenseWrapper><BlogEditorPage /></SuspenseWrapper> },
              { path: "/admin/content/social", element: <SuspenseWrapper><SocialListPage /></SuspenseWrapper> },
              { path: "/admin/content/social/editor/:id", element: <SuspenseWrapper><SocialEditorPage /></SuspenseWrapper> },
              { path: "/admin/content/topics", element: <SuspenseWrapper><TopicBankPage /></SuspenseWrapper> },
              { path: "/admin/content/knowledge", element: <SuspenseWrapper><KnowledgePage /></SuspenseWrapper> },
              { path: "/admin/content/analytics", element: <SuspenseWrapper><ContentAnalyticsPage /></SuspenseWrapper> },
              { path: "/admin/content/settings", element: <SuspenseWrapper><ContentSettingsPage /></SuspenseWrapper> },
              // In-shell 404: an unknown /admin/* path keeps the admin chrome.
              { path: "/admin/*", element: <SuspenseWrapper><InShellNotFound homeTo="/admin" homeLabel="Back to admin" /></SuspenseWrapper> },
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
