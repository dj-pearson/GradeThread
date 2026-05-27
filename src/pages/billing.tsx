import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { FLIPDESK_PLANS, GRADETHREAD_TIERS } from "@/lib/constants";
import type { FlipdeskPlanKey } from "@/lib/constants";
import {
  useBillingSummary,
  useBillingPortal,
  isTrialing,
  planLabel,
} from "@/hooks/use-billing-summary";
import { UsageMeter, UsageMeters } from "@/components/billing/usage-meter";
import { CreditPackDialog } from "@/components/billing/credit-pack-dialog";
import { FlipdeskPlanPickerDialog } from "@/components/billing/flipdesk-plan-picker-dialog";
import { PauseSubscriptionDialog } from "@/components/billing/pause-subscription-dialog";
import { CancelSubscriptionDialog } from "@/components/billing/cancel-subscription-dialog";
import {
  useResumeSubscription,
  useUncancelSubscription,
} from "@/hooks/use-billing-summary";
import {
  AlertCircle,
  Calendar,
  CreditCard,
  ExternalLink,
  Info,
  MoreVertical,
  Pause,
  Play,
  ShoppingCart,
  Sparkles,
  TrendingUp,
  X,
} from "lucide-react";

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function dateLabel(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function BillingPage() {
  const { data: summary, isLoading } = useBillingSummary();
  const portal = useBillingPortal();
  const resume = useResumeSubscription();
  const uncancel = useUncancelSubscription();

  const [planPickerOpen, setPlanPickerOpen] = useState(false);
  const [creditPackOpen, setCreditPackOpen] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [highlightPlan, setHighlightPlan] = useState<FlipdeskPlanKey | undefined>(
    undefined,
  );

  if (isLoading || !summary) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Billing</h1>
          <p className="text-muted-foreground">Manage your subscription and credits.</p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      </div>
    );
  }

  const { subscription, grades, usage } = summary;
  const plan = FLIPDESK_PLANS[subscription.plan as FlipdeskPlanKey];
  const trialing = isTrialing(subscription);
  const pastDue = subscription.status === "past_due";
  const paused = subscription.status === "paused";
  const canceling = subscription.cancel_at_period_end;

  function openPlanPicker(highlight?: FlipdeskPlanKey) {
    setHighlightPlan(highlight);
    setPlanPickerOpen(true);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Billing</h1>
          <p className="text-muted-foreground">
            Manage your FlipDesk subscription and GradeThread credits.
          </p>
        </div>
        {subscription.stripe_customer_id && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => portal.mutate()}
                disabled={portal.isPending}
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                Open Stripe Portal
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Status banners */}
      {pastDue && (
        <div className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
          <div className="flex-1 text-sm">
            <p className="font-semibold text-red-700 dark:text-red-300">
              Your last payment failed
            </p>
            <p className="text-red-700/80 dark:text-red-300/80">
              Update your card to avoid losing access to your{" "}
              {planLabel(subscription.plan)} plan.
            </p>
          </div>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => portal.mutate()}
            disabled={portal.isPending}
          >
            Update card
          </Button>
        </div>
      )}
      {trialing && (
        <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40">
          <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="flex-1 text-sm">
            <p className="font-semibold">Pro free trial active</p>
            <p className="text-muted-foreground">
              Your trial ends on {dateLabel(subscription.trial_ends_at)}. Add a
              card before then to keep your features.
            </p>
          </div>
          <Button size="sm" onClick={() => openPlanPicker("pro")}>
            Add card
          </Button>
        </div>
      )}
      {paused && (
        <div className="flex items-start gap-3 rounded-md border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950/40">
          <Pause className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
          <div className="flex-1 text-sm">
            <p className="font-semibold">Subscription paused</p>
            <p className="text-muted-foreground">
              Resumes on {dateLabel(subscription.pause_until)}. Your caps are
              temporarily at the Free tier; your credits and data are untouched.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => resume.mutate()}
            disabled={resume.isPending}
          >
            <Play className="mr-2 h-4 w-4" />
            Resume now
          </Button>
        </div>
      )}
      {canceling && !pastDue && (
        <div className="flex items-start gap-3 rounded-md border border-orange-200 bg-orange-50 p-4 dark:border-orange-900 dark:bg-orange-950/40">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-orange-600" />
          <div className="flex-1 text-sm">
            <p className="font-semibold">Subscription ending</p>
            <p className="text-muted-foreground">
              Your {planLabel(subscription.plan)} plan ends on{" "}
              {dateLabel(subscription.period_end)}.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => uncancel.mutate()}
            disabled={uncancel.isPending}
          >
            Undo cancel
          </Button>
        </div>
      )}

      {/* Two main cards */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* FlipDesk subscription */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2">
                  FlipDesk Subscription
                  <Badge variant="secondary">{planLabel(subscription.plan)}</Badge>
                </CardTitle>
                <CardDescription>
                  {subscription.plan === "free" ? (
                    "Free forever. Upgrade when you outgrow it."
                  ) : (
                    <>
                      {dollars(
                        subscription.interval === "yearly"
                          ? plan.priceYearlyCents
                          : plan.priceMonthlyCents,
                      )}{" "}
                      / {subscription.interval === "yearly" ? "year" : "month"}
                    </>
                  )}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {subscription.plan !== "free" && subscription.period_end && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Calendar className="h-4 w-4" />
                <span>
                  {canceling ? "Ends" : "Next charge"} on{" "}
                  {dateLabel(subscription.period_end)}
                </span>
              </div>
            )}

            <Separator />

            <div className="space-y-3">
              <UsageMeter
                label="Active listings"
                used={usage.active_listings}
                limit={plan.activeListingCap}
              />
              <UsageMeter
                label="AI actions"
                used={usage.ai_actions_used_this_month}
                limit={effectiveAiLimit(plan.aiActionsPerMonth, usage.ai_action_limit)}
                hint={
                  usage.ai_action_limit != null
                    ? "Self-imposed cap active"
                    : undefined
                }
              />
              <UsageMeter
                label="Marketplaces connected"
                used={usage.marketplaces_connected}
                limit={plan.marketplacesCap}
                hideWhenUnlimited
              />
            </div>

            <Separator />

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => openPlanPicker()}>
                <TrendingUp className="mr-2 h-4 w-4" />
                Change plan
              </Button>
              {subscription.plan !== "free" && !paused && !canceling && (
                <Button variant="outline" onClick={() => setPauseOpen(true)}>
                  <Pause className="mr-2 h-4 w-4" />
                  Pause
                </Button>
              )}
              {subscription.plan !== "free" && !canceling && (
                <Button
                  variant="ghost"
                  className="text-red-700 hover:bg-red-50 hover:text-red-800"
                  onClick={() => setCancelOpen(true)}
                >
                  <X className="mr-2 h-4 w-4" />
                  Cancel
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* GradeThread credits */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle>GradeThread Credits</CardTitle>
                <CardDescription>
                  Pay per grade. Credits never expire.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border border-border bg-muted/30 p-4">
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-medium">Credit balance</span>
                <span className="text-3xl font-bold tabular-nums">
                  {grades.credit_balance}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                1 credit = 1 Standard grade · Premium = 3 · Express = 5
              </p>
            </div>

            <UsageMeter
              label="Included grades this month"
              used={grades.included_used_this_month}
              limit={plan.includedStandardGradesPerMonth}
              hint={`Resets on ${dateLabel(subscription.period_end)}`}
            />

            <div className="grid grid-cols-3 gap-2 text-xs">
              <TierPriceTile tierName="Standard" tier="standard" />
              <TierPriceTile tierName="Premium" tier="premium" />
              <TierPriceTile tierName="Express" tier="express" />
            </div>

            <Separator />

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setCreditPackOpen(true)}>
                <ShoppingCart className="mr-2 h-4 w-4" />
                Buy credits
              </Button>
            </div>

            {summary.recent_ledger.length > 0 && (
              <>
                <Separator />
                <div className="space-y-2">
                  <div className="text-xs font-semibold uppercase text-muted-foreground">
                    Recent activity
                  </div>
                  <ul className="space-y-1.5 text-sm">
                    {summary.recent_ledger.map((entry) => (
                      <li
                        key={entry.id}
                        className="flex items-center justify-between gap-2"
                      >
                        <span className="truncate text-muted-foreground">
                          {ledgerLabel(entry.reason)}
                          {entry.notes ? ` · ${entry.notes}` : ""}
                        </span>
                        <span
                          className={
                            entry.delta > 0
                              ? "tabular-nums font-medium text-emerald-700"
                              : entry.delta < 0
                                ? "tabular-nums font-medium text-red-700"
                                : "tabular-nums text-muted-foreground"
                          }
                        >
                          {entry.delta > 0 ? "+" : ""}
                          {entry.delta}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Compact at-a-glance usage row (mirrors the dashboard) */}
      <div>
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-lg font-semibold">Usage at a glance</h2>
          <span className="text-xs text-muted-foreground">
            <Info className="mr-1 inline h-3 w-3" />
            Same data, compact view
          </span>
        </div>
        <UsageMeters />
      </div>

      {/* Plan comparison footer link */}
      <div className="rounded-md border border-dashed border-border bg-muted/20 p-4 text-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-medium">Want to see what each plan unlocks?</p>
            <p className="text-muted-foreground">
              Open the plan picker to compare Free, Starter, Pro, and Business
              side by side.
            </p>
          </div>
          <Button variant="outline" onClick={() => openPlanPicker()}>
            <CreditCard className="mr-2 h-4 w-4" />
            Compare plans
          </Button>
        </div>
      </div>

      {/* Dialogs */}
      <CreditPackDialog open={creditPackOpen} onOpenChange={setCreditPackOpen} />
      <FlipdeskPlanPickerDialog
        open={planPickerOpen}
        onOpenChange={setPlanPickerOpen}
        highlightPlan={highlightPlan}
      />
      <PauseSubscriptionDialog open={pauseOpen} onOpenChange={setPauseOpen} />
      <CancelSubscriptionDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        periodEnd={subscription.period_end}
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

function ledgerLabel(reason: string): string {
  switch (reason) {
    case "pack_purchase": return "Credit pack purchase";
    case "grade_debit":   return "Grade submitted";
    case "included_grant": return "Included grade used";
    case "admin_grant":   return "Admin comp";
    case "refund":        return "Refund";
    case "expiration":    return "Expired";
    default:              return reason;
  }
}

function TierPriceTile({ tierName, tier }: { tierName: string; tier: keyof typeof GRADETHREAD_TIERS }) {
  const config = GRADETHREAD_TIERS[tier];
  return (
    <div className="rounded-md border border-border p-2 text-center">
      <div className="text-xs text-muted-foreground">{tierName}</div>
      <div className="font-semibold">${(config.priceCents / 100).toFixed(2)}</div>
      <div className="text-xs text-muted-foreground">
        {config.creditCost} cr · {config.slaHours}h
      </div>
    </div>
  );
}
