import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { FLIPDESK_PLANS } from "@/lib/constants";
import type { FlipdeskPlanKey } from "@/lib/constants";
import type { BillingInterval } from "@/types/database";
import {
  useBillingSummary,
  useScheduleDowngrade,
} from "@/hooks/use-billing-summary";
import { cn } from "@/lib/utils";
import { AlertTriangle, ArrowDown, Check, Loader2, X } from "lucide-react";

interface DowngradePreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The plan the user clicked. */
  targetPlan: Exclude<FlipdeskPlanKey, "free">;
  /** The interval to switch to — defaults to the user's current interval. */
  targetInterval?: BillingInterval;
}

const FEATURE_ROWS: Array<{
  flag: keyof typeof FLIPDESK_PLANS.free.gateFlags;
  label: string;
}> = [
  { flag: "bulkActions",      label: "Bulk actions" },
  { flag: "scheduledActions", label: "Scheduled actions" },
  { flag: "compPulls",        label: "AI comp pulls" },
  { flag: "autoRelist",       label: "Auto-relist" },
  { flag: "subAccounts",      label: "Sub-accounts" },
  { flag: "apiAccess",        label: "Programmatic API" },
  { flag: "reconciliation",   label: "Payout reconciliation" },
  { flag: "prioritySupport",  label: "Priority support" },
];

function formatLimit(n: number): string {
  if (n === -1) return "Unlimited";
  return n.toLocaleString();
}

function dateLabel(iso: string | null | undefined): string {
  if (!iso) return "the end of the current period";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function DowngradePreviewDialog({
  open,
  onOpenChange,
  targetPlan,
  targetInterval,
}: DowngradePreviewDialogProps) {
  const { data: summary } = useBillingSummary();
  const downgrade = useScheduleDowngrade();

  if (!summary) return null;

  const current = FLIPDESK_PLANS[summary.subscription.plan as FlipdeskPlanKey];
  const next = FLIPDESK_PLANS[targetPlan];
  const interval = targetInterval ?? summary.subscription.interval ?? "monthly";
  const effectiveAt = summary.subscription.period_end;

  // Caps that will exceed after the downgrade.
  const overListings =
    next.activeListingCap !== -1 &&
    summary.usage.active_listings > next.activeListingCap;
  const overMarketplaces =
    next.marketplacesCap !== -1 &&
    summary.usage.marketplaces_connected > next.marketplacesCap;
  const overAi =
    next.aiActionsPerMonth !== -1 &&
    summary.usage.ai_actions_used_this_month > next.aiActionsPerMonth;
  const overIncluded =
    summary.grades.included_used_this_month > next.includedStandardGradesPerMonth;

  const featureLosses = FEATURE_ROWS.filter(
    (r) => current.gateFlags[r.flag] && !next.gateFlags[r.flag],
  );

  function handleConfirm() {
    downgrade.mutate(
      { plan: targetPlan, interval },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  const hasWarnings = overListings || overMarketplaces || overAi || overIncluded || featureLosses.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowDown className="h-5 w-5" />
            Downgrade to {next.name}
          </DialogTitle>
          <DialogDescription>
            Takes effect on <strong>{dateLabel(effectiveAt)}</strong>. You keep
            full access to {current.name} until then.
          </DialogDescription>
        </DialogHeader>

        {/* Side-by-side comparison */}
        <div className="grid gap-4 sm:grid-cols-2">
          <ComparisonColumn
            title={`Now on ${current.name}`}
            badgeVariant="secondary"
            plan={current}
            usage={summary.usage}
            included={summary.grades.included_used_this_month}
            isTarget={false}
          />
          <ComparisonColumn
            title={`Starting ${dateLabel(effectiveAt)}: ${next.name}`}
            badgeVariant="default"
            plan={next}
            usage={summary.usage}
            included={summary.grades.included_used_this_month}
            isTarget
            overListings={overListings}
            overMarketplaces={overMarketplaces}
            overAi={overAi}
            overIncluded={overIncluded}
            currentFlags={current.gateFlags}
          />
        </div>

        {hasWarnings && (
          <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
            <div className="flex items-center gap-2 font-semibold text-amber-900 dark:text-amber-200">
              <AlertTriangle className="h-4 w-4" />
              What changes on {dateLabel(effectiveAt)}
            </div>
            <ul className="space-y-1 text-amber-900/80 dark:text-amber-200/80">
              {overListings && (
                <li>
                  Listings #{next.activeListingCap === -1 ? "—" : next.activeListingCap + 1}–
                  {summary.usage.active_listings} will be hidden from active
                  sync until you end, sell, or upgrade. Data stays safe.
                </li>
              )}
              {overMarketplaces && (
                <li>
                  Extra marketplace connections beyond{" "}
                  {formatLimit(next.marketplacesCap)} will be disabled.
                </li>
              )}
              {overAi && (
                <li>
                  Your AI-action counter ({summary.usage.ai_actions_used_this_month})
                  already exceeds the {next.name} monthly allowance of{" "}
                  {next.aiActionsPerMonth} — AI will be blocked until next cycle.
                </li>
              )}
              {overIncluded && (
                <li>
                  You've already used more included grades this month than{" "}
                  {next.name} provides ({next.includedStandardGradesPerMonth}) — new
                  grades will need to come from credits or per-grade checkout.
                </li>
              )}
              {featureLosses.length > 0 && (
                <li>
                  Features lost:{" "}
                  {featureLosses.map((f) => f.label).join(", ")}.
                </li>
              )}
            </ul>
          </div>
        )}

        <Separator />

        <div className="text-sm">
          <div className="flex items-baseline justify-between">
            <span className="text-muted-foreground">New {interval} rate</span>
            <span className="text-2xl font-bold">
              ${interval === "yearly"
                ? (next.priceYearlyCents / 100).toFixed(0)
                : (next.priceMonthlyCents / 100).toFixed(0)}
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                / {interval === "yearly" ? "year" : "month"}
              </span>
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            First charge at the new rate runs on {dateLabel(effectiveAt)}. No
            prorated refund — you keep what you already paid for.
          </p>
        </div>

        <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-between">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Never mind
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={downgrade.isPending}
          >
            {downgrade.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Schedule downgrade to {next.name}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ComparisonColumnProps {
  title: string;
  badgeVariant: "default" | "secondary";
  plan: typeof FLIPDESK_PLANS.free;
  usage: {
    active_listings: number;
    marketplaces_connected: number;
    ai_actions_used_this_month: number;
  };
  included: number;
  isTarget: boolean;
  overListings?: boolean;
  overMarketplaces?: boolean;
  overAi?: boolean;
  overIncluded?: boolean;
  currentFlags?: typeof FLIPDESK_PLANS.free.gateFlags;
}

function ComparisonColumn({
  title,
  badgeVariant,
  plan,
  isTarget,
  overListings,
  overMarketplaces,
  overAi,
  overIncluded,
  currentFlags,
}: ComparisonColumnProps) {
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div>
        <Badge variant={badgeVariant} className="mb-1">
          {title}
        </Badge>
      </div>
      <div className="space-y-1.5 text-sm">
        <Stat
          label="Active listings"
          value={formatLimit(plan.activeListingCap)}
          warn={isTarget && overListings}
        />
        <Stat
          label="AI actions / mo"
          value={formatLimit(plan.aiActionsPerMonth)}
          warn={isTarget && overAi}
        />
        <Stat
          label="Marketplaces"
          value={plan.marketplacesCap === -1 ? "All" : `${plan.marketplacesCap}`}
          warn={isTarget && overMarketplaces}
        />
        <Stat
          label="Included grades / mo"
          value={`${plan.includedStandardGradesPerMonth}`}
          warn={isTarget && overIncluded}
        />
      </div>
      <Separator />
      <ul className="space-y-1 text-xs">
        {FEATURE_ROWS.map(({ flag, label }) => {
          const enabled = plan.gateFlags[flag];
          const wasEnabled = currentFlags ? currentFlags[flag] : false;
          const lost = isTarget && !enabled && wasEnabled;
          return (
            <li
              key={flag}
              className={cn(
                "flex items-center gap-2",
                lost && "text-red-700",
                !enabled && !lost && "text-muted-foreground/60",
              )}
            >
              {enabled ? (
                <Check className="h-3.5 w-3.5 text-emerald-600" />
              ) : (
                <X className={cn("h-3.5 w-3.5", lost && "text-red-600")} />
              )}
              <span>{label}</span>
              {lost && (
                <span className="text-[10px] uppercase tracking-wide text-red-600">
                  lost
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Stat({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between",
        warn && "rounded-sm bg-red-50 px-1 dark:bg-red-950/30",
      )}
    >
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-medium tabular-nums", warn && "text-red-700")}>
        {warn && <X className="mr-1 inline h-3 w-3" />}
        {value}
      </span>
    </div>
  );
}
