import { lazy, Suspense } from "react";
import { createBrowserRouter } from "react-router-dom";
import { RootLayout } from "@/layouts/root-layout";
import { AuthLayout } from "@/layouts/auth-layout";
import { DashboardLayout } from "@/layouts/dashboard-layout";
import { AdminLayout } from "@/layouts/admin-layout";
import { ProtectedRoute } from "@/components/auth/protected-route";
import { AdminRoute } from "@/components/auth/admin-route";
import { RouteErrorFallback } from "@/components/error-boundary";

// Lazy-loaded pages for code splitting
const LandingPage = lazy(() => import("@/pages/landing").then(m => ({ default: m.LandingPage })));
const LoginPage = lazy(() => import("@/pages/login").then(m => ({ default: m.LoginPage })));
const SignupPage = lazy(() => import("@/pages/signup").then(m => ({ default: m.SignupPage })));
const AuthCallbackPage = lazy(() => import("@/pages/auth-callback").then(m => ({ default: m.AuthCallbackPage })));
const ResetPasswordPage = lazy(() => import("@/pages/reset-password").then(m => ({ default: m.ResetPasswordPage })));
const DashboardPage = lazy(() => import("@/pages/dashboard").then(m => ({ default: m.DashboardPage })));
const SubmissionsPage = lazy(() => import("@/pages/submissions").then(m => ({ default: m.SubmissionsPage })));
const NewSubmissionPage = lazy(() => import("@/pages/new-submission").then(m => ({ default: m.NewSubmissionPage })));
const SubmissionDetailPage = lazy(() => import("@/pages/submission-detail").then(m => ({ default: m.SubmissionDetailPage })));
const InventoryPage = lazy(() => import("@/pages/inventory").then(m => ({ default: m.InventoryPage })));
const InventoryAddPage = lazy(() => import("@/pages/inventory-add").then(m => ({ default: m.InventoryAddPage })));
const InventoryDetailPage = lazy(() => import("@/pages/inventory-detail").then(m => ({ default: m.InventoryDetailPage })));
const FinancesPage = lazy(() => import("@/pages/finances").then(m => ({ default: m.FinancesPage })));
const SettingsPage = lazy(() => import("@/pages/settings").then(m => ({ default: m.SettingsPage })));
const BillingPage = lazy(() => import("@/pages/billing").then(m => ({ default: m.BillingPage })));
const ApiKeysPage = lazy(() => import("@/pages/api-keys").then(m => ({ default: m.ApiKeysPage })));
const PriceSuggestionsPage = lazy(() => import("@/pages/price-suggestions").then(m => ({ default: m.PriceSuggestionsPage })));
const CertificatePage = lazy(() => import("@/pages/certificate").then(m => ({ default: m.CertificatePage })));
const FlipdeskOverviewPage = lazy(() => import("@/pages/flipdesk/overview").then(m => ({ default: m.FlipdeskOverviewPage })));
const FlipdeskPipelinePage = lazy(() => import("@/pages/flipdesk/pipeline").then(m => ({ default: m.FlipdeskPipelinePage })));
const FlipdeskListingsPage = lazy(() => import("@/pages/flipdesk/listings").then(m => ({ default: m.FlipdeskListingsPage })));
const FlipdeskItemsPage = lazy(() => import("@/pages/flipdesk/items").then(m => ({ default: m.FlipdeskItemsPage })));
const FlipdeskGridPage = lazy(() => import("@/pages/flipdesk/grid").then(m => ({ default: m.FlipdeskGridPage })));
const FlipdeskComposerPage = lazy(() => import("@/pages/flipdesk/composer").then(m => ({ default: m.FlipdeskComposerPage })));
const FlipdeskPrepPage = lazy(() => import("@/pages/flipdesk/prep").then(m => ({ default: m.FlipdeskPrepPage })));
const FlipdeskExpensesPage = lazy(() => import("@/pages/flipdesk/expenses").then(m => ({ default: m.FlipdeskExpensesPage })));
const FlipdeskAnalyticsPage = lazy(() => import("@/pages/flipdesk/analytics").then(m => ({ default: m.FlipdeskAnalyticsPage })));
const FlipdeskIntakePage = lazy(() => import("@/pages/flipdesk/intake").then(m => ({ default: m.FlipdeskIntakePage })));
const FlipdeskImportPage = lazy(() => import("@/pages/flipdesk/import").then(m => ({ default: m.FlipdeskImportPage })));
const FlipdeskMarketplacesPage = lazy(() => import("@/pages/flipdesk/marketplaces").then(m => ({ default: m.FlipdeskMarketplacesPage })));
const FlipdeskReconciliationPage = lazy(() => import("@/pages/flipdesk/reconciliation").then(m => ({ default: m.FlipdeskReconciliationPage })));
const FlipdeskSourcesPage = lazy(() => import("@/pages/flipdesk/sources").then(m => ({ default: m.FlipdeskSourcesPage })));
const NotFoundPage = lazy(() => import("@/pages/not-found").then(m => ({ default: m.NotFoundPage })));
const AdminDashboardPage = lazy(() => import("@/pages/admin/dashboard").then(m => ({ default: m.AdminDashboardPage })));
const AdminUsersPage = lazy(() => import("@/pages/admin/users").then(m => ({ default: m.AdminUsersPage })));
const AdminSubmissionsPage = lazy(() => import("@/pages/admin/submissions").then(m => ({ default: m.AdminSubmissionsPage })));
const AdminReviewsPage = lazy(() => import("@/pages/admin/reviews").then(m => ({ default: m.AdminReviewsPage })));
const AdminAiModelsPage = lazy(() => import("@/pages/admin/ai-models").then(m => ({ default: m.AdminAiModelsPage })));
const AdminUserDetailPage = lazy(() => import("@/pages/admin/user-detail").then(m => ({ default: m.AdminUserDetailPage })));
const AdminDisputesPage = lazy(() => import("@/pages/admin/disputes").then(m => ({ default: m.AdminDisputesPage })));
const AdminSystemPage = lazy(() => import("@/pages/admin/system").then(m => ({ default: m.AdminSystemPage })));

function PageLoader() {
  return (
    <div className="flex h-64 items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
    </div>
  );
}

function SuspenseWrapper({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageLoader />}>{children}</Suspense>;
}

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    errorElement: <RouteErrorFallback />,
    children: [
      // Public routes
      { path: "/", element: <SuspenseWrapper><LandingPage /></SuspenseWrapper> },
      { path: "/cert/:id", element: <SuspenseWrapper><CertificatePage /></SuspenseWrapper> },

      // Auth routes (guest only)
      {
        element: <AuthLayout />,
        children: [
          { path: "/login", element: <SuspenseWrapper><LoginPage /></SuspenseWrapper> },
          { path: "/signup", element: <SuspenseWrapper><SignupPage /></SuspenseWrapper> },
          { path: "/auth/reset-password", element: <SuspenseWrapper><ResetPasswordPage /></SuspenseWrapper> },
        ],
      },

      // Auth callback (public, handles redirect)
      { path: "/auth/callback", element: <SuspenseWrapper><AuthCallbackPage /></SuspenseWrapper> },

      // Protected dashboard routes
      {
        element: <ProtectedRoute />,
        children: [
          {
            element: <DashboardLayout />,
            children: [
              { path: "/dashboard", element: <SuspenseWrapper><DashboardPage /></SuspenseWrapper> },
              { path: "/dashboard/submissions", element: <SuspenseWrapper><SubmissionsPage /></SuspenseWrapper> },
              { path: "/dashboard/submissions/new", element: <SuspenseWrapper><NewSubmissionPage /></SuspenseWrapper> },
              { path: "/dashboard/submissions/:id", element: <SuspenseWrapper><SubmissionDetailPage /></SuspenseWrapper> },
              { path: "/dashboard/inventory", element: <SuspenseWrapper><InventoryPage /></SuspenseWrapper> },
              { path: "/dashboard/inventory/new", element: <SuspenseWrapper><InventoryAddPage /></SuspenseWrapper> },
              { path: "/dashboard/inventory/:id", element: <SuspenseWrapper><InventoryDetailPage /></SuspenseWrapper> },
              { path: "/dashboard/finances", element: <SuspenseWrapper><FinancesPage /></SuspenseWrapper> },
              { path: "/dashboard/analytics/suggestions", element: <SuspenseWrapper><PriceSuggestionsPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk", element: <SuspenseWrapper><FlipdeskOverviewPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/overview", element: <SuspenseWrapper><FlipdeskOverviewPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/items", element: <SuspenseWrapper><FlipdeskItemsPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/grid", element: <SuspenseWrapper><FlipdeskGridPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/items/:id/draft", element: <SuspenseWrapper><FlipdeskComposerPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/intake", element: <SuspenseWrapper><FlipdeskIntakePage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/prep", element: <SuspenseWrapper><FlipdeskPrepPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/import", element: <SuspenseWrapper><FlipdeskImportPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/pipeline", element: <SuspenseWrapper><FlipdeskPipelinePage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/listings", element: <SuspenseWrapper><FlipdeskListingsPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/sources", element: <SuspenseWrapper><FlipdeskSourcesPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/marketplaces", element: <SuspenseWrapper><FlipdeskMarketplacesPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/reconciliation", element: <SuspenseWrapper><FlipdeskReconciliationPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/expenses", element: <SuspenseWrapper><FlipdeskExpensesPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/analytics", element: <SuspenseWrapper><FlipdeskAnalyticsPage /></SuspenseWrapper> },
              { path: "/dashboard/flipdesk/analytics/grading-roi", element: <SuspenseWrapper><FlipdeskAnalyticsPage /></SuspenseWrapper> },
              { path: "/dashboard/settings", element: <SuspenseWrapper><SettingsPage /></SuspenseWrapper> },
              { path: "/dashboard/billing", element: <SuspenseWrapper><BillingPage /></SuspenseWrapper> },
              { path: "/dashboard/api-keys", element: <SuspenseWrapper><ApiKeysPage /></SuspenseWrapper> },
            ],
          },
        ],
      },

      // Admin routes (admin/super_admin only)
      {
        element: <AdminRoute />,
        children: [
          {
            element: <AdminLayout />,
            children: [
              { path: "/admin", element: <SuspenseWrapper><AdminDashboardPage /></SuspenseWrapper> },
              { path: "/admin/users", element: <SuspenseWrapper><AdminUsersPage /></SuspenseWrapper> },
              { path: "/admin/users/:id", element: <SuspenseWrapper><AdminUserDetailPage /></SuspenseWrapper> },
              { path: "/admin/submissions", element: <SuspenseWrapper><AdminSubmissionsPage /></SuspenseWrapper> },
              { path: "/admin/reviews", element: <SuspenseWrapper><AdminReviewsPage /></SuspenseWrapper> },
              { path: "/admin/disputes", element: <SuspenseWrapper><AdminDisputesPage /></SuspenseWrapper> },
              { path: "/admin/ai-models", element: <SuspenseWrapper><AdminAiModelsPage /></SuspenseWrapper> },
              { path: "/admin/system", element: <SuspenseWrapper><AdminSystemPage /></SuspenseWrapper> },
            ],
          },
        ],
      },

      // 404
      { path: "*", element: <SuspenseWrapper><NotFoundPage /></SuspenseWrapper> },
    ],
  },
]);
