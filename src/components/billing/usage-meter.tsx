import { cn } from "@/lib/utils";
import { FLIPDESK_PLANS } from "@/lib/constants";
import type { FlipdeskPlanKey } from "@/lib/constants";
import { useBillingSummary } from "@/hooks/use-billing-summary";
import { Skeleton } from "@/components/ui/skeleton";

// ── UsageMeter (US-214) ─────────────────────────────────────────
//
// Labeled progress bar with used / limit, color thresholds (green < 50,
// amber 50–80, red > 80, brand-red at 100). Pure presentational — caller
// passes used + limit + label. Use UsageMeters below for the dashboard
// row that auto-wires every meter from useBillingSummary.

export interface UsageMeterProps {
  label: string;
  used: number;
  /** -1 = unlimited. Renders just the count, no bar. */
  limit: number;
  /** When kind='balance', the value is a wallet balance — don't render %, just the number. */
  kind?: "cap" | "balance";
  /** Optional sub-label rendered under the bar. */
  hint?: string;
  className?: string;
  /** Hidden when unlimited and kind='cap' (no point showing an empty bar). */
  hideWhenUnlimited?: boolean;
}

function colorClass(pct: number): string {
  if (pct >= 1.0) return "bg-brand-red";
  if (pct >= 0.8) return "bg-red-500";
  if (pct >= 0.5) return "bg-amber-500";
  return "bg-emerald-500";
}

export function UsageMeter({
  label,
  used,
  limit,
  kind = "cap",
  hint,
  className,
  hideWhenUnlimited = false,
}: UsageMeterProps) {
  // Balance meters render the number only (no bar).
  if (kind === "balance") {
    return (
      <div className={cn("space-y-1", className)}>
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="font-medium">{label}</span>
          <span className="text-2xl font-semibold tabular-nums">{used}</span>
        </div>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
    );
  }

  // Unlimited.
  if (limit === -1) {
    if (hideWhenUnlimited) return null;
    return (
      <div className={cn("space-y-1", className)}>
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="font-medium">{label}</span>
          <span className="text-muted-foreground tabular-nums">
            {used} <span className="text-xs">/ unlimited</span>
          </span>
        </div>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
    );
  }

  const pct = Math.min(used / Math.max(limit, 1), 1);
  const pctDisplay = Math.round(pct * 100);

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {used} / {limit}
          <span className="ml-1 text-xs">({pctDisplay}%)</span>
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={cn("h-full rounded-full transition-all", colorClass(pct))}
          style={{ width: `${pct * 100}%` }}
        />
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

// ── UsageMeters: opinionated dashboard row ──────────────────────
//
// Renders the four primary caps (active listings, AI actions, included
// grades, credit balance) for the current user. Hides meters that don't
// apply (e.g. marketplaces meter is dropped when marketplacesCap === 1).

export function UsageMeters({ className }: { className?: string }) {
  const { data, isLoading } = useBillingSummary();

  if (isLoading || !data) {
    return (
      <div className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-4", className)}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  const plan = FLIPDESK_PLANS[data.subscription.plan as FlipdeskPlanKey];

  return (
    <div className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-4", className)}>
      <UsageMeter
        label="Active listings"
        used={data.usage.active_listings}
        limit={plan.activeListingCap}
      />
      <UsageMeter
        label="AI actions"
        used={data.usage.ai_actions_used_this_month}
        limit={effectiveAiLimit(plan.aiActionsPerMonth, data.usage.ai_action_limit)}
        hint={data.usage.ai_action_limit != null ? "Self-imposed cap active" : undefined}
      />
      <UsageMeter
        label="Included grades"
        used={data.grades.included_used_this_month}
        limit={plan.includedStandardGradesPerMonth}
        hint="Standard grades, resets monthly"
      />
      <UsageMeter
        label="Grade credits"
        used={data.grades.credit_balance}
        limit={0}
        kind="balance"
        hint="Never expire"
      />
    </div>
  );
}

function effectiveAiLimit(planLimit: number, userLimit: number | null): number {
  if (planLimit === -1 && userLimit == null) return -1;
  if (planLimit === -1) return userLimit ?? -1;
  if (userLimit == null) return planLimit;
  return Math.min(planLimit, userLimit);
}
