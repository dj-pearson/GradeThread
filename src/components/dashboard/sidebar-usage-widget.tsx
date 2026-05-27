import { Link } from "react-router-dom";
import { TrendingUp } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { FLIPDESK_PLANS } from "@/lib/constants";
import type { FlipdeskPlanKey } from "@/lib/constants";
import { useBillingSummary } from "@/hooks/use-billing-summary";
import { cn } from "@/lib/utils";

// ── SidebarUsageWidget (US-214 sidebar variant) ─────────────────
//
// Collapsed view of usage in the sidebar footer. Shows the cap closest to
// its limit; hover/click opens a popover with all four meters. Clicking the
// trigger or any "Manage" CTA jumps to /dashboard/billing.

interface Cap {
  label: string;
  used: number;
  limit: number;
}

function effectiveAiLimit(planLimit: number, userLimit: number | null): number {
  if (planLimit === -1 && userLimit == null) return -1;
  if (planLimit === -1) return userLimit ?? -1;
  if (userLimit == null) return planLimit;
  return Math.min(planLimit, userLimit);
}

function pct(c: Cap): number {
  if (c.limit === -1) return 0;
  return c.used / Math.max(c.limit, 1);
}

function colorClass(p: number): string {
  if (p >= 1.0) return "bg-brand-red";
  if (p >= 0.8) return "bg-red-400";
  if (p >= 0.5) return "bg-amber-400";
  return "bg-emerald-400";
}

export function SidebarUsageWidget() {
  const { data, isLoading } = useBillingSummary();

  if (isLoading || !data) return null;

  const plan = FLIPDESK_PLANS[data.subscription.plan as FlipdeskPlanKey];

  const caps: Cap[] = [
    {
      label: "Active listings",
      used: data.usage.active_listings,
      limit: plan.activeListingCap,
    },
    {
      label: "AI actions",
      used: data.usage.ai_actions_used_this_month,
      limit: effectiveAiLimit(plan.aiActionsPerMonth, data.usage.ai_action_limit),
    },
    {
      label: "Included grades",
      used: data.grades.included_used_this_month,
      limit: plan.includedStandardGradesPerMonth,
    },
  ];

  // The "hottest" cap (closest to or over its limit) drives the collapsed view.
  // Unlimited caps (limit=-1) drop out of the running.
  const ranked = caps.filter((c) => c.limit !== -1);
  const hottest = ranked.reduce<Cap | null>((best, c) => {
    if (!best || pct(c) > pct(best)) return c;
    return best;
  }, null);

  const balance = data.grades.credit_balance;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="mx-3 mb-3 flex w-[calc(100%-1.5rem)] flex-col gap-2 rounded-lg border border-white/10 bg-white/5 p-3 text-left text-white/80 transition-colors hover:bg-white/10"
          aria-label="Show usage details"
        >
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5 font-medium">
              <TrendingUp className="h-3.5 w-3.5" />
              {plan.name} usage
            </span>
            <span className="tabular-nums text-white/60">
              {balance}cr
            </span>
          </div>
          {hottest ? (
            <div className="space-y-1">
              <div className="flex items-baseline justify-between gap-2 text-[11px] text-white/60">
                <span>{hottest.label}</span>
                <span className="tabular-nums">
                  {hottest.used}/{hottest.limit}
                </span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    colorClass(pct(hottest)),
                  )}
                  style={{ width: `${Math.min(pct(hottest), 1) * 100}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="text-[11px] text-white/60">All caps healthy</div>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="end" className="w-72">
        <div className="space-y-3">
          <div>
            <div className="text-sm font-semibold">{plan.name} plan</div>
            <div className="text-xs text-muted-foreground">
              Credit balance: {balance}
            </div>
          </div>
          <div className="space-y-2">
            {caps.map((c) => (
              <MiniRow key={c.label} cap={c} />
            ))}
          </div>
          <Link
            to="/dashboard/billing"
            className="block w-full rounded-md bg-brand-navy py-1.5 text-center text-sm font-medium text-white transition-colors hover:bg-brand-navy/90"
          >
            Manage plan
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function MiniRow({ cap }: { cap: Cap }) {
  if (cap.limit === -1) {
    return (
      <div className="space-y-1">
        <div className="flex items-baseline justify-between text-xs">
          <span className="font-medium">{cap.label}</span>
          <span className="tabular-nums text-muted-foreground">
            {cap.used} / unlimited
          </span>
        </div>
      </div>
    );
  }
  const p = pct(cap);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium">{cap.label}</span>
        <span className="tabular-nums text-muted-foreground">
          {cap.used} / {cap.limit}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={cn("h-full rounded-full", colorClass(p))}
          style={{ width: `${Math.min(p, 1) * 100}%` }}
        />
      </div>
    </div>
  );
}
