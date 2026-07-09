import { NavLink } from "react-router-dom";
import { Lock, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { BUYER_NAV } from "@/lib/buyer-nav";
import { useBuyerEntitlements } from "@/hooks/use-buyer-entitlements";
import { BUYER_PLANS } from "@/lib/constants";

// US-1802: buyer app sidebar. Entitlement-aware — a nav item whose `requiresFlag`
// is not unlocked by the buyer's plan renders locked (dimmed + lock icon) and
// routes to /buyer/billing so the upgrade prompt is one click away, rather than
// hiding the feature (buyers should see what a higher tier unlocks).
export function BuyerSidebar() {
  const ent = useBuyerEntitlements();

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card md:flex">
      <div className="flex items-center gap-2 px-5 py-4">
        <ShieldCheck className="h-5 w-5 text-primary" />
        <span className="text-sm font-bold">GradeThread Buyer</span>
        <span className="ml-auto rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
          {BUYER_PLANS[ent.plan].name}
        </span>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
        {BUYER_NAV.map((item) => {
          const locked = item.requiresFlag ? !ent.has(item.requiresFlag) : false;
          const Icon = item.icon;

          if (locked) {
            // Route locked items to billing with the intended feature as context.
            return (
              <NavLink
                key={item.to}
                to={`/buyer/billing?upgrade=${item.requiresFlag ?? ""}`}
                className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground/70 hover:bg-accent/40"
                title={`${item.label} — upgrade to unlock`}
              >
                <Icon className="h-4 w-4" />
                <span className="flex-1">{item.label}</span>
                <Lock className="h-3.5 w-3.5" />
              </NavLink>
            );
          }

          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-foreground/80 hover:bg-accent hover:text-foreground",
                )
              }
            >
              <Icon className="h-4 w-4" />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
}
