import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { FLIPDESK_PLANS } from "@/lib/constants";
import type { FlipdeskPlanKey } from "@/lib/constants";
import type { BillingInterval } from "@/types/database";
import {
  useBillingSummary,
  useFlipdeskSubscribe,
  useBillingPortal,
} from "@/hooks/use-billing-summary";
import { cn } from "@/lib/utils";
import { Check, X, Crown, Loader2, Sparkles } from "lucide-react";

const PLAN_ORDER: FlipdeskPlanKey[] = ["free", "starter", "pro", "business"];
const PLAN_RANK: Record<FlipdeskPlanKey, number> = {
  free: 0, starter: 1, pro: 2, business: 3,
};

// Feature checklist rows rendered on every card with ✓/✗.
const FEATURE_ROWS: Array<{ flag: keyof typeof FLIPDESK_PLANS.free.gateFlags; label: string }> = [
  { flag: "bulkActions",      label: "Bulk actions" },
  { flag: "scheduledActions", label: "Scheduled actions" },
  { flag: "compPulls",        label: "AI comp pulls" },
  { flag: "autoRelist",       label: "Auto-relist" },
  { flag: "subAccounts",      label: "Sub-accounts" },
  { flag: "apiAccess",        label: "Programmatic API" },
  { flag: "reconciliation",   label: "Payout reconciliation" },
  { flag: "prioritySupport",  label: "Priority support" },
];

function dollars(cents: number): string {
  if (cents === 0) return "$0";
  return `$${(cents / 100).toFixed(0)}`;
}

function priceLabel(plan: typeof FLIPDESK_PLANS.free, interval: BillingInterval): string {
  const cents = interval === "monthly" ? plan.priceMonthlyCents : plan.priceYearlyCents;
  if (cents === 0) return "Free";
  if (interval === "yearly") {
    const perMonth = cents / 12 / 100;
    return `$${perMonth.toFixed(0)}`;
  }
  return dollars(cents);
}

function annualSavingsPct(plan: typeof FLIPDESK_PLANS.free): number | null {
  if (plan.priceMonthlyCents === 0) return null;
  const fullYear = plan.priceMonthlyCents * 12;
  return ((fullYear - plan.priceYearlyCents) / fullYear) * 100;
}

interface FlipdeskPlanPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-scroll to the suggested upgrade tier (US-210). */
  highlightPlan?: FlipdeskPlanKey;
}

export function FlipdeskPlanPickerDialog({
  open,
  onOpenChange,
  highlightPlan,
}: FlipdeskPlanPickerDialogProps) {
  const { data: summary } = useBillingSummary();
  const subscribe = useFlipdeskSubscribe();
  const portal = useBillingPortal();

  const currentPlan = (summary?.subscription.plan ?? "free") as FlipdeskPlanKey;
  const currentInterval: BillingInterval =
    summary?.subscription.interval ?? "monthly";

  const [interval, setInterval] = useState<BillingInterval>(currentInterval);

  // Show trial CTAs only when the user hasn't used their one-trial-ever yet.
  const trialEligible =
    !!summary &&
    !summary.subscription.stripe_customer_id &&
    !!summary.subscription.trial_ends_at &&
    new Date(summary.subscription.trial_ends_at).getTime() > Date.now();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Choose your FlipDesk plan</DialogTitle>
          <DialogDescription>
            Pick the tier that fits your volume. Switch or cancel any time.
          </DialogDescription>
        </DialogHeader>

        {/* Monthly / Annual toggle */}
        <div className="flex items-center justify-center gap-3 py-2">
          <Label
            htmlFor="interval-toggle"
            className={cn(
              "cursor-pointer text-sm",
              interval === "monthly" ? "font-semibold" : "text-muted-foreground",
            )}
          >
            Monthly
          </Label>
          <Switch
            id="interval-toggle"
            checked={interval === "yearly"}
            onCheckedChange={(v) => setInterval(v ? "yearly" : "monthly")}
          />
          <Label
            htmlFor="interval-toggle"
            className={cn(
              "cursor-pointer text-sm",
              interval === "yearly" ? "font-semibold" : "text-muted-foreground",
            )}
          >
            Annual
          </Label>
          <Badge variant="secondary" className="ml-1">
            Save ~17%
          </Badge>
        </div>

        <div className="grid gap-4 lg:grid-cols-4">
          {PLAN_ORDER.map((planKey) => {
            const plan = FLIPDESK_PLANS[planKey];
            const isCurrent =
              planKey === currentPlan && interval === currentInterval;
            const sameTierDiffInterval =
              planKey === currentPlan && interval !== currentInterval;
            const direction =
              PLAN_RANK[planKey] - PLAN_RANK[currentPlan];
            const isUpgrade = direction > 0;
            const isDowngrade = direction < 0 && planKey !== "free";
            const isCancelToFree = direction < 0 && planKey === "free";
            const showTrialChip = trialEligible && (planKey === "pro" || planKey === "business");
            const isHighlighted = highlightPlan === planKey;
            const isPopular = planKey === "pro";
            const savings = annualSavingsPct(plan);

            const isLoading =
              (subscribe.isPending && subscribe.variables?.plan === planKey) ||
              portal.isPending;

            return (
              <Card
                key={planKey}
                className={cn(
                  "relative flex flex-col",
                  isCurrent && "border-brand-navy border-2",
                  !isCurrent && isHighlighted && "border-brand-red border-2",
                  !isCurrent && !isHighlighted && isPopular && "border-brand-navy/60 border-2",
                )}
              >
                {isPopular && !isCurrent && (
                  <Badge
                    variant="secondary"
                    className="absolute -top-2 right-3 z-10"
                  >
                    <Crown className="mr-1 h-3 w-3" />
                    Popular
                  </Badge>
                )}
                {isCurrent && (
                  <Badge
                    variant="default"
                    className="bg-brand-navy absolute -top-2 right-3 z-10"
                  >
                    Current
                  </Badge>
                )}

                <CardHeader className="space-y-2 pb-3">
                  <div className="text-lg font-semibold">{plan.name}</div>
                  <div>
                    <span className="text-3xl font-bold">
                      {priceLabel(plan, interval)}
                    </span>
                    {plan.priceMonthlyCents > 0 && (
                      <span className="text-muted-foreground">/mo</span>
                    )}
                    {interval === "yearly" && savings != null && (
                      <div className="mt-0.5 text-xs text-emerald-700">
                        {dollars(plan.priceYearlyCents)} billed yearly
                      </div>
                    )}
                  </div>
                  {showTrialChip && (
                    <Badge variant="secondary" className="self-start">
                      <Sparkles className="mr-1 h-3 w-3" />
                      14-day free trial
                    </Badge>
                  )}
                </CardHeader>

                <CardContent className="flex-1 space-y-3 pb-3 text-sm">
                  <div className="space-y-1 border-b border-border pb-3">
                    <Stat
                      label="Active listings"
                      value={
                        plan.activeListingCap === -1
                          ? "Unlimited"
                          : plan.activeListingCap.toLocaleString()
                      }
                    />
                    <Stat
                      label="AI actions / mo"
                      value={plan.aiActionsPerMonth.toLocaleString()}
                    />
                    <Stat
                      label="Marketplaces"
                      value={
                        plan.marketplacesCap === -1
                          ? "All"
                          : `${plan.marketplacesCap}`
                      }
                    />
                    <Stat
                      label="Included grades / mo"
                      value={plan.includedStandardGradesPerMonth.toString()}
                    />
                  </div>
                  <ul className="space-y-1">
                    {FEATURE_ROWS.map(({ flag, label }) => {
                      const enabled = plan.gateFlags[flag];
                      return (
                        <li
                          key={flag}
                          className={cn(
                            "flex items-center gap-2",
                            enabled ? "" : "text-muted-foreground/60",
                          )}
                        >
                          {enabled ? (
                            <Check className="h-3.5 w-3.5 text-emerald-600" />
                          ) : (
                            <X className="h-3.5 w-3.5" />
                          )}
                          <span className="text-xs">{label}</span>
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>

                <CardFooter>
                  {renderCta({
                    planKey,
                    isCurrent,
                    sameTierDiffInterval,
                    isUpgrade,
                    isDowngrade,
                    isCancelToFree,
                    isLoading,
                    onSubscribe: () => {
                      if (planKey === "free") return;
                      subscribe.mutate({ plan: planKey, interval });
                    },
                    onOpenPortal: () => portal.mutate(),
                  })}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

function renderCta(args: {
  planKey: FlipdeskPlanKey;
  isCurrent: boolean;
  sameTierDiffInterval: boolean;
  isUpgrade: boolean;
  isDowngrade: boolean;
  isCancelToFree: boolean;
  isLoading: boolean;
  onSubscribe: () => void;
  onOpenPortal: () => void;
}) {
  const { isCurrent, sameTierDiffInterval, isUpgrade, isDowngrade, isCancelToFree, isLoading, planKey, onSubscribe, onOpenPortal } = args;

  if (isCurrent) {
    return (
      <Button variant="outline" className="w-full" disabled>
        Current plan
      </Button>
    );
  }

  if (sameTierDiffInterval) {
    return (
      <Button
        variant="outline"
        className="w-full"
        onClick={onOpenPortal}
        disabled={isLoading}
      >
        {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Switch interval
      </Button>
    );
  }

  if (isUpgrade && planKey !== "free") {
    return (
      <Button className="w-full" onClick={onSubscribe} disabled={isLoading}>
        {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Upgrade to {planKey}
      </Button>
    );
  }

  if (isDowngrade) {
    // Downgrade goes through the Stripe portal until US-217's preview dialog ships.
    return (
      <Button
        variant="outline"
        className="w-full"
        onClick={onOpenPortal}
        disabled={isLoading}
      >
        {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Downgrade
      </Button>
    );
  }

  if (isCancelToFree) {
    // Cancelling to Free goes through the portal until US-216's cancel flow ships.
    return (
      <Button
        variant="outline"
        className="w-full"
        onClick={onOpenPortal}
        disabled={isLoading}
      >
        {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Cancel subscription
      </Button>
    );
  }

  return (
    <Button variant="outline" className="w-full" disabled>
      —
    </Button>
  );
}
