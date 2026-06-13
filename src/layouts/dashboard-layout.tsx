import { Outlet } from "react-router-dom";
import { Sidebar } from "@/components/dashboard/sidebar";
import { Header } from "@/components/dashboard/header";
import { ErrorBoundary } from "@/components/error-boundary";
import { useRealtimeSubmissions } from "@/hooks/use-realtime-submission";
import { useCheckoutReconciler } from "@/hooks/use-checkout-reconciler";
import { CommandPalette } from "@/components/flipdesk/command-palette";
import { ShortcutsHelp } from "@/components/dashboard/shortcuts-help";
import { FlipdeskOnboarding } from "@/components/flipdesk/flipdesk-onboarding";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { UsageAlertWatcher } from "@/components/billing/usage-alert-watcher";
import { AppBillingDialogs } from "@/components/billing/app-billing-dialogs";
import { AnnouncementBanner } from "@/components/announcements/announcement-banner";
import { PastDueBanner } from "@/components/billing/past-due-banner";
import { ImpersonationBanner } from "@/components/admin/impersonation-banner";

export function DashboardLayout() {
  // Subscribe to realtime submission updates for toast notifications
  useRealtimeSubmissions();
  // Keep the billing summary + header plan badge reconciling after a Stripe
  // checkout, even if the user navigates off the billing page (US-797).
  useCheckoutReconciler();

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* US-581: full-width impersonation banner above everything when active. */}
      <ImpersonationBanner />
      <div className="flex flex-1 overflow-hidden">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-lg"
      >
        Skip to content
      </a>
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 overflow-y-auto bg-background p-6 outline-none"
        >
          <ErrorBoundary>
            <FlipdeskOnboarding />
            <AnnouncementBanner />
            <PastDueBanner />
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
      {/* Global Cmd/Ctrl-K command palette */}
      <CommandPalette />
      {/* Global "?" keyboard-shortcuts reference */}
      <ShortcutsHelp />
      {/* First-login onboarding */}
      <OnboardingFlow />
      {/* Soft upgrade triggers — toasts when a plan cap crosses threshold (US-209) */}
      <UsageAlertWatcher />
      {/* Billing dialogs — moved here from RootLayout so their weight stays off
          public pages (402 hard-trigger + usage watcher are authed-only). */}
      <AppBillingDialogs />
      </div>
    </div>
  );
}
