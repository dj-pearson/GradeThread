import { Outlet } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { ErrorBoundary } from "@/components/error-boundary";
import { UpgradeRequiredDialog } from "@/components/billing/upgrade-required-dialog";

export function RootLayout() {
  return (
    <ErrorBoundary>
      <Outlet />
      <Toaster position="bottom-right" richColors />
      {/* Globally mounted — opens automatically from edgeFetch when a 402 fires (US-210). */}
      <UpgradeRequiredDialog />
    </ErrorBoundary>
  );
}
