import { UpgradeRequiredDialog } from "@/components/billing/upgrade-required-dialog";
import { GlobalPlanPicker } from "@/components/billing/global-plan-picker";

// The globally-mounted billing dialogs (US-209/US-210/US-212), grouped so the
// authenticated layouts mount them in one place. They were previously in
// RootLayout, but that pulled their radix Dialog + Supabase + react-query deps
// into the eager bundle on EVERY page — including the public landing page,
// where they can never fire (the 402 hard-trigger + usage watcher only run for
// signed-in API callers). Mounting them inside DashboardLayout / AdminLayout
// (both lazy-loaded) keeps that weight off the marketing/LCP path. A given URL
// lives under exactly one of those layouts, so only one instance is ever live —
// no double-open from the shared zustand stores.
export function AppBillingDialogs() {
  return (
    <>
      <UpgradeRequiredDialog />
      <GlobalPlanPicker />
    </>
  );
}
