import { useState } from "react";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  FLIPDESK_PLANS,
  formatListingAllowance,
  formatMarketplacesCap,
} from "@/lib/constants";
import type { FlipdeskPlanKey } from "@/lib/constants";
import type { BillingInterval } from "@/types/database";
import { usePricingPlans } from "@/hooks/use-pricing-plans";
import { cn } from "@/lib/utils";
import { Check, X, Crown } from "lucide-react";

// ── FlipdeskPlanComparison (US-211) ─────────────────────────────
//
// Read-only 4-tier comparison grid shown on the Billing page below the two
// product cards. Mirrors the US-212 plan-picker card layout (stats + feature
// checklist + monthly/annual toggle) but performs NO subscription mutations
// itself — the current plan is badged and each other card's CTA opens the
// full plan picker (US-212) pre-highlighted, where the actual change happens.

const PLAN_ORDER: FlipdeskPlanKey[] = ["free", "starter", "pro", "business"];

const FEATURE_ROWS: Array<{
  flag: keyof typeof FLIPDESK_PLANS.free.gateFlags;
  label: string;
}> = [
  { flag: "bulkActions", label: "Bulk actions" },
  { flag: "scheduledActions", label: "Scheduled actions" },
  { flag: "compPulls", label: "AI comp pulls" },
  { flag: "autoRelist", label: "Auto-relist" },
  { flag: "subAccounts", label: "Sub-accounts" },
  { flag: "apiAccess", label: "Programmatic API" },
  { flag: "reconciliation", label: "Payout reconciliation" },
  { flag: "prioritySupport", label: "Priority support" },
];

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(0)}`;
}

function priceLabel(
  plan: typeof FLIPDESK_PLANS.free,
  interval: BillingInterval,
): string {
  const cents =
    interval === "monthly" ? plan.priceMonthlyCents : plan.priceYearlyCents;
  if (cents === 0) return "Free";
  if (interval === "yearly") return `$${(cents / 12 / 100).toFixed(0)}`;
  return dollars(cents);
}

function annualSavingsPct(plan: typeof FLIPDESK_PLANS.free): number | null {
  if (plan.priceMonthlyCents === 0) return null;
  const fullYear = plan.priceMonthlyCents * 12;
  return ((fullYear - plan.priceYearlyCents) / fullYear) * 100;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

interface FlipdeskPlanComparisonProps {
  currentPlan: FlipdeskPlanKey;
  currentInterval: BillingInterval | null;
  /** Opens the US-212 plan picker pre-highlighting the chosen tier. */
  onChoosePlan: (plan: FlipdeskPlanKey) => void;
}

export function FlipdeskPlanComparison({
  currentPlan,
  currentInterval,
  onChoosePlan,
}: FlipdeskPlanComparisonProps) {
  const [interval, setInterval] = useState<BillingInterval>(
    currentInterval ?? "monthly",
  );
  // US-587: live, operator-editable plan config (falls back to FLIPDESK_PLANS).
  const { plans } = usePricingPlans();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold">Compare plans</h2>
        <div className="flex items-center gap-2">
          <Label
            htmlFor="comparison-interval"
            className="text-sm text-muted-foreground"
          >
            Monthly
          </Label>
          <Switch
            id="comparison-interval"
            checked={interval === "yearly"}
            onCheckedChange={(v) => setInterval(v ? "yearly" : "monthly")}
          />
          <Label
            htmlFor="comparison-interval"
            className="text-sm text-muted-foreground"
          >
            Annual <span className="text-emerald-700 dark:text-emerald-300">(save ~17%)</span>
          </Label>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {PLAN_ORDER.map((planKey) => {
          const plan = plans[planKey];
          const isCurrent =
            planKey === currentPlan &&
            (currentInterval == null || interval === currentInterval);
          const isPopular = planKey === "pro";
          const savings = annualSavingsPct(plan);

          return (
            <Card
              key={planKey}
              className={cn(
                "relative flex flex-col",
                isCurrent && "border-brand-navy border-2",
                !isCurrent && isPopular && "border-brand-navy/60 border-2",
              )}
            >
              {isCurrent ? (
                <Badge
                  variant="default"
                  className="bg-brand-navy absolute -top-2 right-3 z-10"
                >
                  Current
                </Badge>
              ) : (
                isPopular && (
                  <Badge variant="secondary" className="absolute -top-2 right-3 z-10">
                    <Crown className="mr-1 h-3 w-3" />
                    Popular
                  </Badge>
                )
              )}

              <CardHeader className="space-y-2 pb-3">
                <div className="text-lg font-semibold">{plan.name}</div>
                <div>
                  <div className="flex items-baseline gap-1 whitespace-nowrap">
                    <span className="text-3xl font-bold">
                      {priceLabel(plan, interval)}
                    </span>
                    {plan.priceMonthlyCents > 0 && (
                      <span className="text-sm text-muted-foreground">/mo</span>
                    )}
                  </div>
                  {interval === "yearly" && savings != null && (
                    <div className="mt-0.5 text-xs text-emerald-700 dark:text-emerald-300">
                      {dollars(plan.priceYearlyCents)} billed yearly
                    </div>
                  )}
                </div>
              </CardHeader>

              <CardContent className="flex-1 space-y-3 pb-3 text-sm">
                <div className="space-y-1.5 border-b border-border pb-3">
                  {/* US-2483: the shared formatter, so this row and the public
                      pricing page cannot describe the same cap differently. */}
                  <Stat
                    label="Active listings"
                    value={formatListingAllowance(plan.activeListingCap)}
                  />
                  <Stat
                    label="AI actions / mo"
                    value={plan.aiActionsPerMonth.toLocaleString()}
                  />
                  <Stat
                    label="Marketplaces"
                    value={formatMarketplacesCap(plan.marketplacesCap)}
                  />
                  <Stat
                    label="Included grades / mo"
                    value={plan.includedStandardGradesPerMonth.toString()}
                  />
                </div>
                <ul className="space-y-1.5">
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
                          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        ) : (
                          <X className="h-3.5 w-3.5 shrink-0" />
                        )}
                        <span className="text-xs leading-tight">{label}</span>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>

              <CardFooter>
                {isCurrent ? (
                  <Button variant="outline" className="w-full" disabled>
                  aria-label={`${plan.name} is your current plan`}
                    Current plan
                  </Button>
                ) : (
                  <Button
                    variant={isPopular ? "default" : "outline"}
                    className="w-full"
                    onClick={() => onChoosePlan(planKey)}
                  >
                    Choose {plan.name}
                  </Button>
                )}
              </CardFooter>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
