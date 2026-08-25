import { Outlet } from "react-router";
import { Sidebar } from "@/components/dashboard/sidebar";
import { GuidedPathBar } from "@/components/onboarding/guided-path-bar";
import { Header } from "@/components/dashboard/header";
import { RouteErrorBoundary } from "@/components/error-boundary";
import { useRealtimeSubmissions } from "@/hooks/use-realtime-submission";
import { useRealtimeListingState } from "@/hooks/use-realtime-listing-state";
import { useCheckoutReconciler } from "@/hooks/use-checkout-reconciler";
import { CommandPalette } from "@/components/flipdesk/command-palette";
import { ShortcutsHelp } from "@/components/dashboard/shortcuts-help";
import { FlipdeskActivation } from "@/components/onboarding/flipdesk-activation";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { UsageAlertWatcher } from "@/components/billing/usage-alert-watcher";
import { AppBillingDialogs } from "@/components/billing/app-billing-dialogs";
import { AnnouncementBanner } from "@/components/announcements/announcement-banner";
import { MaintenanceBanner } from "@/components/maintenance/maintenance-banner";
import { PastDueBanner } from "@/components/billing/past-due-banner";
import { ImpersonationBanner } from "@/components/admin/impersonation-banner";
import { SupportChatWidget } from "@/components/support/support-chat-widget";
import { MobileTabBar } from "@/components/dashboard/mobile-tab-bar";

export function DashboardLayout() {
  // Subscribe to realtime submission updates for toast notifications
  useRealtimeSubmissions();
  // US-2174: a sale or status change on a MARKETPLACE is not a local mutation,
  // so nothing invalidated the inventory cache and a sold listing could show as
  // Active until its staleness window expired. Mounted once here — per-page
  // would open a channel per FlipDesk route.
  useRealtimeListingState();
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
        {/* US-2880: below md the bottom tab bar floats over this, so the last
            row of a scrolled list needs somewhere to end -- the bar's height
            plus the home-indicator inset. `md:pb-6` puts it back to normal on
            a desktop, where there is no bar. */}
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 overflow-y-auto bg-background p-6 pb-[calc(5rem+env(safe-area-inset-bottom))] outline-none md:pb-6"
        >
          <RouteErrorBoundary>
            {/* US-2873: one instruction, above whatever real screen the
                seller is on. The screen keeps doing its own job. */}
            <GuidedPathBar />
            <FlipdeskActivation />
            <MaintenanceBanner />
            <AnnouncementBanner />
            <PastDueBanner />
            <Outlet />
          </RouteErrorBoundary>
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
      {/* In-app, tier-gated AI support chat (US-838) */}
      <SupportChatWidget />
      {/* US-2880: five tabs on a phone, matching the iOS shell. Rendered here
          rather than inside Sidebar so the buyer shell -- which uses
          BuyerLayout and BuyerSidebar -- never gets it (AC5). */}
      <MobileTabBar />
      </div>
    </div>
  );
}
