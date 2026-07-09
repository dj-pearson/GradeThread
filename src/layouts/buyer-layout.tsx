import { Outlet, Link } from "react-router-dom";
import { Store } from "lucide-react";
import { BuyerSidebar } from "@/components/buyer/buyer-sidebar";
import { ErrorBoundary } from "@/components/error-boundary";
import { useAuthStore } from "@/stores/auth-store";

// US-1802: buyer app shell. A surface parallel to DashboardLayout (seller) with
// its own sidebar. A dual-role account (is_seller) gets a one-click context
// switch to the seller/FlipDesk app without re-auth — the two apps share the same
// Supabase session.
export function BuyerLayout() {
  const profile = useAuthStore((s) => s.profile);
  const canSwitchToSeller = profile?.is_seller === true;

  return (
    <div className="flex h-screen overflow-hidden">
      <a
        href="#buyer-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-lg"
      >
        Skip to content
      </a>
      <BuyerSidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background px-6">
          <span className="text-sm font-semibold">Buyer</span>
          {canSwitchToSeller && (
            <Link
              to="/dashboard"
              className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
            >
              <Store className="h-4 w-4" />
              Seller dashboard
            </Link>
          )}
        </header>
        <main
          id="buyer-main"
          tabIndex={-1}
          className="flex-1 overflow-y-auto bg-background p-6 outline-none"
        >
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
