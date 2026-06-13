import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { ErrorBoundary } from "@/components/error-boundary";
import { CookieConsent } from "@/components/cookie-consent";
import { captureAffiliateRef } from "@/lib/affiliate";

// The billing dialogs (UpgradeRequiredDialog / GlobalPlanPicker) used to live
// here but were moved into the authenticated layouts (see AppBillingDialogs) so
// their radix + Supabase weight stays off public marketing pages. Everything
// kept here is needed on every route, including the landing page.
export function RootLayout() {
  // US-603: capture a ?ref= earned-link code the moment a visitor lands, on any
  // route. redeemStoredAffiliateRef() (in use-auth) attributes it once they sign in.
  useEffect(() => {
    captureAffiliateRef();
  }, []);

  return (
    <ErrorBoundary>
      <Outlet />
      <Toaster position="bottom-right" richColors />
      {/* Consent banner — gates Google Analytics + PostHog (GDPR/CCPA). */}
      <CookieConsent />
    </ErrorBoundary>
  );
}
