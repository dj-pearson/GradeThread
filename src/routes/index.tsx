import { createBrowserRouter } from "react-router-dom";
import { RootLayout } from "@/layouts/root-layout";
import { AuthLayout } from "@/layouts/auth-layout";
import { DashboardLayout } from "@/layouts/dashboard-layout";
import { ProtectedRoute } from "@/components/auth/protected-route";
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
import { SettingsPage } from "@/pages/settings";
import { BillingPage } from "@/pages/billing";
import { ApiKeysPage } from "@/pages/api-keys";
import { CertificatePage } from "@/pages/certificate";
import { NotFoundPage } from "@/pages/not-found";

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
              { path: "/dashboard/settings", element: <SettingsPage /> },
              { path: "/dashboard/billing", element: <BillingPage /> },
              { path: "/dashboard/api-keys", element: <ApiKeysPage /> },
            ],
          },
        ],
      },

      // 404
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
