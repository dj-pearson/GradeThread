import { Outlet } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { ErrorBoundary } from "@/components/error-boundary";
import { UpgradeRequiredDialog } from "@/components/billing/upgrade-required-dialog";
import { GlobalPlanPicker } from "@/components/billing/global-plan-picker";
import { CookieConsent } from "@/components/cookie-consent";

export function RootLayout() {
  return (
    <ErrorBoundary>
      <Outlet />
      <Toaster position="bottom-right" richColors />
      {/* Globally mounted — opens automatically from edgeFetch when a 402 fires (US-210). */}
      <UpgradeRequiredDialog />
      {/* Globally mounted — opened from the soft-upgrade toast + usage watcher (US-209/US-212). */}
      <GlobalPlanPicker />
      {/* Consent banner — gates Google Analytics + PostHog (GDPR/CCPA). */}
      <CookieConsent />
    </ErrorBoundary>
  );
}
