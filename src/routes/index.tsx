import { createBrowserRouter } from "react-router-dom";
import { RootLayout } from "@/layouts/root-layout";
import { AuthLayout } from "@/layouts/auth-layout";
import { DashboardLayout } from "@/layouts/dashboard-layout";
import { AdminLayout } from "@/layouts/admin-layout";
import { ProtectedRoute } from "@/components/auth/protected-route";
import { AdminRoute } from "@/components/auth/admin-route";
import { LandingPage } from "@/pages/landing";
import { LoginPage } from "@/pages/login";
import { SignupPage } from "@/pages/signup";
import { AuthCallbackPage } from "@/pages/auth-callback";
import { ResetPasswordPage } from "@/pages/reset-password";
import { DashboardPage } from "@/pages/dashboard";
import { SubmissionsPage } from "@/pages/submissions";
import { NewSubmissionPage } from "@/pages/new-submission";
import { SubmissionDetailPage } from "@/pages/submission-detail";
import { InventoryPage } from "@/pages/inventory";
import { InventoryAddPage } from "@/pages/inventory-add";
import { InventoryDetailPage } from "@/pages/inventory-detail";
import { FinancesPage } from "@/pages/finances";
import { SettingsPage } from "@/pages/settings";
import { BillingPage } from "@/pages/billing";
import { ApiKeysPage } from "@/pages/api-keys";
import { PriceSuggestionsPage } from "@/pages/price-suggestions";
import { CertificatePage } from "@/pages/certificate";
import { NotFoundPage } from "@/pages/not-found";
import { AdminDashboardPage } from "@/pages/admin/dashboard";
import { AdminUsersPage } from "@/pages/admin/users";
import { AdminSubmissionsPage } from "@/pages/admin/submissions";
import { AdminReviewsPage } from "@/pages/admin/reviews";
import { AdminAiModelsPage } from "@/pages/admin/ai-models";
import { AdminSystemPage } from "@/pages/admin/system";

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      // Public routes
      { path: "/", element: <LandingPage /> },
      { path: "/cert/:id", element: <CertificatePage /> },

      // Auth routes (guest only)
      {
        element: <AuthLayout />,
        children: [
          { path: "/login", element: <LoginPage /> },
          { path: "/signup", element: <SignupPage /> },
          { path: "/auth/reset-password", element: <ResetPasswordPage /> },
        ],
      },

      // Auth callback (public, handles redirect)
      { path: "/auth/callback", element: <AuthCallbackPage /> },

      // Protected dashboard routes
      {
        element: <ProtectedRoute />,
        children: [
          {
            element: <DashboardLayout />,
            children: [
              { path: "/dashboard", element: <DashboardPage /> },
              { path: "/dashboard/submissions", element: <SubmissionsPage /> },
              { path: "/dashboard/submissions/new", element: <NewSubmissionPage /> },
              { path: "/dashboard/submissions/:id", element: <SubmissionDetailPage /> },
              { path: "/dashboard/inventory", element: <InventoryPage /> },
              { path: "/dashboard/inventory/new", element: <InventoryAddPage /> },
              { path: "/dashboard/inventory/:id", element: <InventoryDetailPage /> },
              { path: "/dashboard/finances", element: <FinancesPage /> },
              { path: "/dashboard/analytics/suggestions", element: <PriceSuggestionsPage /> },
              { path: "/dashboard/settings", element: <SettingsPage /> },
              { path: "/dashboard/billing", element: <BillingPage /> },
              { path: "/dashboard/api-keys", element: <ApiKeysPage /> },
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
              { path: "/admin", element: <AdminDashboardPage /> },
              { path: "/admin/users", element: <AdminUsersPage /> },
              { path: "/admin/submissions", element: <AdminSubmissionsPage /> },
              { path: "/admin/reviews", element: <AdminReviewsPage /> },
              { path: "/admin/ai-models", element: <AdminAiModelsPage /> },
              { path: "/admin/system", element: <AdminSystemPage /> },
            ],
          },
        ],
      },

      // 404
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
