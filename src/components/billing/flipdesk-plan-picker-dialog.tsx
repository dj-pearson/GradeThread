import { useEffect, useState } from "react";
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
import { FLIPDESK_PLANS, formatMarketplacesCap, TRIAL_DAYS } from "@/lib/constants";
import { AutoRenewalDisclosure } from "@/components/billing/auto-renewal-disclosure";
import type { FlipdeskPlanKey } from "@/lib/constants";
import type { BillingInterval } from "@/types/database";
import {
  useBillingSummary,
  useFlipdeskSubscribe,
  useBillingPortal,
} from "@/hooks/use-billing-summary";
import { useRedirectStore } from "@/stores/redirect-store";
import { DowngradePreviewDialog } from "@/components/billing/downgrade-preview-dialog";
import { UpgradePreviewDialog } from "@/components/billing/upgrade-preview-dialog";
import { track } from "@/lib/analytics";
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
  /**
   * US-2125: what to do when the user picks the Free tile — i.e. cancels.
   *
   * Selecting Free used to open the STRIPE BILLING PORTAL, a second cancellation
   * path that bypassed the reviewed flow entirely: no period-end statement, no
   * acknowledgement checkbox, no reason capture, no undo banner. The reviewed
   * dialog is the one that was designed and audited; a divergent second route is
   * how the audited one stops being the one users actually hit.
   *
   * Passed as a callback rather than rendering the cancel dialog HERE because
   * CancelSubscriptionDialog itself opens this picker as its "switch to a
   * cheaper plan" off-ramp — self-rendering would make those two mutually
   * recursive. The parent owns the flow; this component only reports intent.
   *
   * When omitted (the picker was opened FROM the cancel dialog) the Free tile
   * simply closes this dialog, returning the user to the cancel flow they are
   * already in.
   */
  onRequestCancel?: () => void;
}

export function FlipdeskPlanPickerDialog({
  open,
  onOpenChange,
  highlightPlan,
  onRequestCancel,
}: FlipdeskPlanPickerDialogProps) {
  const { data: summary } = useBillingSummary();
  const subscribe = useFlipdeskSubscribe();
  const isRedirecting = useRedirectStore((s) => s.isRedirecting);
  const portal = useBillingPortal();

  const currentPlan = (summary?.subscription.plan ?? "free") as FlipdeskPlanKey;
  const currentInterval: BillingInterval =
    summary?.subscription.interval ?? "monthly";

  const [interval, setInterval] = useState<BillingInterval>(currentInterval);
  const [downgradeTarget, setDowngradeTarget] = useState<
    Exclude<FlipdeskPlanKey, "free"> | null
  >(null);
  // US-2118: an in-place upgrade (user already on a paid plan) must disclose the
  // prorated charge + capture consent before it fires. A free → paid upgrade is
  // a fresh Stripe Checkout, which discloses on its own hosted page, so it skips
  // this dialog.
  const [upgradeTarget, setUpgradeTarget] = useState<
    Exclude<FlipdeskPlanKey, "free"> | null
  >(null);

  // US-212 telemetry: fire once each time the dialog opens.
  useEffect(() => {
    if (open) track("plan_picker.opened", { from: currentPlan, interval });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Show trial CTAs only when the user hasn't used their one-trial-ever yet.
  const trialEligible =
    !!summary &&
    !summary.subscription.stripe_customer_id &&
    !!summary.subscription.trial_ends_at &&
    new Date(summary.subscription.trial_ends_at).getTime() > Date.now();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl max-h-[90dvh] overflow-y-auto">
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

        {downgradeTarget && (
          <DowngradePreviewDialog
            open={!!downgradeTarget}
            onOpenChange={(v) => {
              if (!v) {
                setDowngradeTarget(null);
                onOpenChange(false);
              }
            }}
            targetPlan={downgradeTarget}
            targetInterval={interval}
          />
        )}
        {upgradeTarget && (
          <UpgradePreviewDialog
            product="flipdesk"
            open={!!upgradeTarget}
            onOpenChange={(v) => {
              if (!v) {
                setUpgradeTarget(null);
                onOpenChange(false);
              }
            }}
            targetPlan={upgradeTarget}
            targetInterval={interval}
            fromPlan={currentPlan}
          />
        )}
        <div className="grid items-stretch gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
              portal.isPending ||
              isRedirecting;

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
                  {showTrialChip && (
                    <Badge variant="secondary" className="self-start">
                      <Sparkles className="mr-1 h-3 w-3" />
                      {TRIAL_DAYS}-day free trial
                    </Badge>
                  )}
                </CardHeader>

                <CardContent className="flex-1 space-y-3 pb-3 text-sm">
                  <div className="space-y-1.5 border-b border-border pb-3">
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

                <CardFooter className="flex-col items-stretch gap-2">
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
                      track("plan_picker.cta_clicked", {
                        from: currentPlan,
                        to: planKey,
                        interval,
                      });
                      // US-2118: on a live paid plan → in-place upgrade, which
                      // charges immediately. Disclose + confirm first. From free
                      // (no subscription) it's a fresh Checkout that discloses on
                      // Stripe's page, so go straight there.
                      if (currentPlan === "free") {
                        subscribe.mutate({ plan: planKey, interval });
                      } else {
                        setUpgradeTarget(planKey);
                      }
                    },
                    onDowngrade: () => {
                      if (planKey === "free") return;
                      track("plan_picker.cta_clicked", {
                        from: currentPlan,
                        to: planKey,
                        interval,
                      });
                      setDowngradeTarget(planKey);
                    },
                    onOpenPortal: () => {
                      track("plan_picker.cta_clicked", {
                        from: currentPlan,
                        to: planKey,
                        interval,
                      });
                      portal.mutate();
                    },
                    // US-2125: the Free tile is a CANCELLATION, and it gets its
                    // own prop rather than a branch inside onOpenPortal. One
                    // handler meaning two things is how the portal path survived
                    // here in the first place: the routing was corrected while a
                    // comment two hundred lines away still described the old
                    // behaviour, and nothing could disagree with it. Separate
                    // props cannot drift like that.
                    onCancel: () => {
                      track("plan_picker.cta_clicked", {
                        from: currentPlan,
                        to: planKey,
                        interval,
                      });
                      onOpenChange(false);
                      onRequestCancel?.();
                    },
                  })}
                  {/* US-2115: directly under the CTA, in the card the user is
                      reading. Shown on every PAID tile that is not already the
                      current plan — an upgrade, a downgrade and an interval
                      switch all change the recurring terms, so all three owe
                      the disclosure. The free tile is a cancellation and the
                      current tile is not a point of sale. */}
                  {planKey !== "free" && !isCurrent && (
                    <AutoRenewalDisclosure
                      amountCents={
                        interval === "yearly"
                          ? plan.priceYearlyCents
                          : plan.priceMonthlyCents
                      }
                      interval={interval}
                      trialDays={showTrialChip ? TRIAL_DAYS : null}
                    />
                  )}
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
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="shrink-0 text-right font-medium tabular-nums">{value}</span>
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
  onDowngrade: () => void;
  onOpenPortal: () => void;
  onCancel: () => void;
}) {
  const { isCurrent, sameTierDiffInterval, isUpgrade, isDowngrade, isCancelToFree, isLoading, planKey, onSubscribe, onDowngrade, onOpenPortal, onCancel } = args;

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
    return (
      <Button
        variant="outline"
        className="w-full"
        onClick={onDowngrade}
        disabled={isLoading}
      >
        {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Downgrade
      </Button>
    );
  }

  if (isCancelToFree) {
    // US-2125: goes through the reviewed cancellation dialog, NOT the Stripe
    // portal. The portal skipped the period-end statement, the acknowledgement
    // checkbox, the reason capture and the undo banner, and showed
    // portal-native copy nobody here had reviewed.
    return (
      <Button
        variant="outline"
        className="w-full"
        onClick={onCancel}
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
