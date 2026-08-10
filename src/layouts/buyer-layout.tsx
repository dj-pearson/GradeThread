import { Outlet, Link } from "react-router";
import { Store } from "lucide-react";
import { BuyerSidebar } from "@/components/buyer/buyer-sidebar";
import { RouteErrorBoundary } from "@/components/error-boundary";
import { PastDueBanner } from "@/components/billing/past-due-banner";
import { useAuthStore } from "@/stores/auth-store";

// US-1802: buyer app shell. A surface parallel to DashboardLayout (seller) with
// its own sidebar. A dual-role account (is_seller) gets a one-click context
// switch to the seller/FlipDesk app without re-auth — the two apps share the same
// Supabase session.
export function BuyerLayout() {
  const profile = useAuthStore((s) => s.profile);
  // US-1888: everyone can reach the seller app — a dual-role seller switches
  // back; a pure buyer discovers selling (the flywheel's other side).
  const isSeller = profile?.is_seller === true;

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
          <Link
            to="/dashboard"
            className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
          >
            <Store className="h-4 w-4" />
            {isSeller ? "Switch to selling" : "Start selling"}
          </Link>
        </header>
        <main
          id="buyer-main"
          tabIndex={-1}
          className="flex-1 overflow-y-auto bg-background p-6 outline-none"
        >
          {/* US-2455: a declined card must be visible on EVERY buyer page, not
              only on billing — the same argument US-776 made for the seller
              app. `product` is explicit: a dual-role account past_due on their
              FlipDesk card must not see the alarm here, where they cannot act
              on it. */}
          <PastDueBanner product="buyer" />
          <RouteErrorBoundary>
            <Outlet />
          </RouteErrorBoundary>
        </main>
      </div>
    </div>
  );
}
