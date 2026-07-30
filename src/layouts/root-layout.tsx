import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { RouteErrorBoundary } from "@/components/error-boundary";
import { CookieConsent } from "@/components/cookie-consent";
import { captureAffiliateRef, flushPendingAffiliateClick } from "@/lib/affiliate";

// The billing dialogs (UpgradeRequiredDialog / GlobalPlanPicker) used to live
// here but were moved into the authenticated layouts (see AppBillingDialogs) so
// their radix + Supabase weight stays off public marketing pages. Everything
// kept here is needed on every route, including the landing page.
export function RootLayout() {
  // US-603: capture a ?ref= earned-link code the moment a visitor lands, on any
  // route. redeemStoredAffiliateRef() (in use-auth) attributes it once they sign in.
  useEffect(() => {
    captureAffiliateRef();
    // US-2108: a ref banked on a standalone SSR page (cert/blog/verified/
    // passport) parked its click ping there — those pages don't mount the SPA
    // and can't reach the edge API. This is the first page that can, so send it.
    flushPendingAffiliateClick();
  }, []);

  return (
    <RouteErrorBoundary>
      <Outlet />
      <Toaster position="bottom-right" richColors />
      {/* Consent banner — gates Google Analytics + PostHog (GDPR/CCPA). */}
      <CookieConsent />
    </RouteErrorBoundary>
  );
}
