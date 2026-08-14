import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { ErrorState } from "@/components/ui/error-state";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { track } from "@/lib/analytics";
import { markCheckoutPending } from "@/lib/checkout-pending";
import { useRedirectStore, CHECKOUT_INITIATED_KEY } from "@/stores/redirect-store";
import { FLIPDESK_PLANS, GRADETHREAD_TIERS } from "@/lib/constants";
import type { FlipdeskPlanKey } from "@/lib/constants";
import {
  useBillingSummary,
  useBillingPortal,
  isTrialing,
  storeManaging,
  planLabel,
  ledgerLabel,
  pollBillingSummary,
} from "@/hooks/use-billing-summary";
import { InvoiceHistory } from "@/components/billing/invoice-history";
import { UsageMeter, UsageMeters } from "@/components/billing/usage-meter";
import { CreditPackDialog } from "@/components/billing/credit-pack-dialog";
import { FlipdeskPlanPickerDialog } from "@/components/billing/flipdesk-plan-picker-dialog";
import { FlipdeskPlanComparison } from "@/components/billing/flipdesk-plan-comparison";
import { PauseSubscriptionDialog } from "@/components/billing/pause-subscription-dialog";
import { CancelSubscriptionDialog } from "@/components/billing/cancel-subscription-dialog";
import { ActivityHistoryDialog } from "@/components/billing/activity-history-dialog";
import {
  useResumeSubscription,
  useUncancelSubscription,
  useUndoDowngrade,
} from "@/hooks/use-billing-summary";
import {
  AlertCircle,
  ArrowDown,
  Calendar,
  ExternalLink,
  Info,
  Loader2,
  MoreVertical,
  Pause,
  Play,
  RefreshCw,
  ShoppingCart,
  Smartphone,
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
  const { data: summary, isLoading, isError, refetch } = useBillingSummary();
  const isRedirecting = useRedirectStore((s) => s.isRedirecting);
  const portal = useBillingPortal();
  const resume = useResumeSubscription();
  const uncancel = useUncancelSubscription();
  const undoDowngrade = useUndoDowngrade();

  const [planPickerOpen, setPlanPickerOpen] = useState(false);
  const [creditPackOpen, setCreditPackOpen] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [highlightPlan, setHighlightPlan] = useState<FlipdeskPlanKey | undefined>(
    undefined,
  );

  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  // US-2514: ?buy=credits opens the credit-pack dialog on arrival, so the
  // /pricing credit tiles land on the actual purchase rather than dropping the
  // visitor on this page to hunt for the button. Stripped afterwards so a
  // refresh or a Back press doesn't reopen it.
  useEffect(() => {
    if (searchParams.get("buy") !== "credits") return;
    setCreditPackOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("buy");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // US-2122 AC2: ?cancel=1 opens the cancellation dialog directly.
  //
  // The subscription-started email is legally required to say HOW to cancel, and
  // "go to Billing and look for the button" is not that. This makes the email's
  // link land on the actual flow rather than near it.
  //
  // Only opens when there is something to cancel — a link that pops an empty
  // dialog for a free or already-cancelled user is worse than no link. The param
  // is stripped either way so a refresh or a Back press doesn't reopen it.
  useEffect(() => {
    if (searchParams.get("cancel") !== "1") return;
    const sub = summary?.subscription;
    if (sub && !sub.cancel_at_period_end) setCancelOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("cancel");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, summary]);

  // Returning from Stripe Checkout: the webhook that grants credits / activates
  // the plan lands a beat after this redirect, so poll the summary for a short
  // window instead of showing the pre-webhook snapshot. Strip the params so a
  // later manual refresh doesn't re-trigger the poll.
  useEffect(() => {
    if (searchParams.get("checkout") !== "success") return;
    // US-1631: fire the success toast/analytics/reconcile ONLY for a real
    // checkout round-trip — a flag set when we redirected to Stripe, consumed
    // here. Opening a bookmarked ?checkout=success URL (or hitting Back) has no
    // flag, so it no longer re-fires the conversion event or re-toasts. We still
    // strip the params below in every case.
    let initiated = false;
    try {
      initiated = sessionStorage.getItem(CHECKOUT_INITIATED_KEY) === "1";
      sessionStorage.removeItem(CHECKOUT_INITIATED_KEY);
    } catch {
      initiated = true; // storage unavailable → don't suppress a real return
    }
    if (!initiated) {
      const next = new URLSearchParams(searchParams);
      ["checkout", "product", "credits"].forEach((k) => next.delete(k));
      setSearchParams(next, { replace: true });
      return;
    }
    const product = searchParams.get("product");
    if (product === "credit_pack") {
      const credits = Number.parseInt(searchParams.get("credits") ?? "", 10);
      track("credit_pack.purchased", {
        pack: Number.isFinite(credits) ? credits : undefined,
      });
    }
    toast.success(
      product === "credit_pack"
        ? "Payment received — adding your credits…"
        : "Payment received — updating your subscription…",
    );
    // Durable marker so the layout-level reconciler (US-797) keeps refreshing
    // the summary + header plan badge until the webhook lands, even if the user
    // navigates off this page; also kick an immediate poll for fast feedback
    // while they stay here.
    markCheckoutPending(product === "credit_pack" ? "credit_pack" : "subscription");
    const cancelPoll = pollBillingSummary(qc);

    const next = new URLSearchParams(searchParams);
    ["checkout", "product", "credits"].forEach((k) => next.delete(k));
    setSearchParams(next, { replace: true });

    return cancelPoll;
    // Run once on mount; we immediately clear the params so deps would only
    // ever fire this again after we've already handled it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // US-940: a `?upgrade=<plan>` deep-link (from the trial-conversion drip's
  // subscribe CTA) lands here and auto-opens the plan picker on the recommended
  // plan, so the email's "subscribe" button leads straight into checkout. Wait
  // for the summary so the picker dialog is mounted, then strip the param.
  useEffect(() => {
    const upgrade = searchParams.get("upgrade");
    if (!upgrade || !summary) return;
    const key = upgrade as FlipdeskPlanKey;
    if (key !== "free" && key in FLIPDESK_PLANS) {
      openPlanPicker(key);
    }
    const next = new URLSearchParams(searchParams);
    next.delete("upgrade");
    setSearchParams(next, { replace: true });
    // US-1489: fire once when the summary lands and immediately strip ?upgrade=;
    // searchParams/openPlanPicker/setSearchParams are stable-or-consumed here, so
    // keying only on `summary` is intentional (re-running would reopen the picker).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary]);

  // US-1631: a failed billing-summary fetch previously fell through to the
  // skeleton branch below (summary undefined) and rendered loading skeletons
  // FOREVER. Surface the error with a retry instead.
  if (isError && !summary) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Billing"
          subtitle="Manage your subscription and credits."
        />
        <ErrorState
          title="Couldn't load your billing details"
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  if (isLoading || !summary) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Billing"
          subtitle="Manage your subscription and credits."
        />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      </div>
    );
  }

  const { subscription, grades } = summary;
  const plan = FLIPDESK_PLANS[subscription.plan as FlipdeskPlanKey];
  // US-807: subscription purchased in the iOS app — its lifecycle is owned by
  // Apple, so the web page goes read-only for the subscription (no Stripe CTAs,
  // no Stripe-specific banners) while credit packs + per-grade stay available.
  // US-2126: which store owns the lifecycle, not just "is it Apple". A Google
  // Play subscriber previously fell through to the Stripe CTAs and got a 409
  // from a server that already knew better.
  const managingStore = storeManaging(subscription);
  const appstoreManaged = managingStore !== null;
  const storeName = managingStore === "googleplay" ? "Google Play" : "the App Store";
  const storeApp = managingStore === "googleplay" ? "Android" : "iOS";
  // US-2524: the store's own subscription settings. On the device these open the
  // native sheet; on a desktop browser they land on the account page, which is
  // still one click from cancelling instead of a sentence about where to look.
  const storeSubscriptionsUrl =
    managingStore === "googleplay"
      ? "https://play.google.com/store/account/subscriptions"
      : "https://apps.apple.com/account/subscriptions";
  const trialing = !appstoreManaged && isTrialing(subscription);
  const pastDue = !appstoreManaged && subscription.status === "past_due";
  const paused = subscription.status === "paused";
  const canceling = subscription.cancel_at_period_end;

  // US-400: prefer the REAL upcoming Stripe charge (coupons / grandfathered
  // prices / prorations) over the static plan-table price; fall back to the
  // plan table when Stripe didn't return one.
  const planPriceCents = subscription.interval === "yearly"
    ? plan.priceYearlyCents
    : plan.priceMonthlyCents;
  const nextChargeCents = subscription.upcoming_invoice?.amount_cents ?? planPriceCents;
  const nextChargeDate = subscription.upcoming_invoice?.next_payment_at ?? subscription.period_end;

  // US-393: Free users have no billing period_end. The included-grade counter
  // resets monthly off grade_reset_at; show that date when it's still upcoming,
  // otherwise the allowance has already rolled over.
  const includedResetHint =
    subscription.plan === "free"
      ? grades.reset_at && new Date(grades.reset_at).getTime() > Date.now()
        ? `Resets on ${dateLabel(grades.reset_at)}`
        : "Renews monthly"
      : `Resets on ${dateLabel(subscription.period_end)}`;

  function openPlanPicker(highlight?: FlipdeskPlanKey) {
    setHighlightPlan(highlight);
    setPlanPickerOpen(true);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Billing"
        subtitle="Manage your FlipDesk subscription and GradeThread credits."
        actions={
          subscription.stripe_customer_id ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label="Billing actions">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => portal.mutate()}
                  disabled={portal.isPending || isRedirecting}
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Open Stripe Portal
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined
        }
      />

      {/* Status banners */}
      {appstoreManaged && (
        <div className="flex items-start gap-3 rounded-md border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950/40">
          <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400" />
          <div className="flex-1 text-sm">
            <p className="font-semibold">
              Your subscription is managed in the {storeApp} app
            </p>
            <p className="text-muted-foreground">
              Your {planLabel(subscription.plan)} plan was purchased through{" "}
              {storeName}
              {subscription.status === "past_due"
                ? ` and a recent renewal failed — update your payment in the ${storeApp} app`
                : ""}
              . Credit packs and per-grade purchases are still available here.
            </p>
            {/* US-2524: this used to describe where to look and stop there. Both
                stores expose a subscription-settings URL that opens the native
                sheet on the device and the web account page elsewhere. */}
            <a
              href={storeSubscriptionsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 font-medium underline underline-offset-2"
            >
              Manage it in {storeName}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      )}
      {pastDue && (
        <div className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
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
          <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="flex-1 text-sm">
            {/* US-2524: this named the Pro plan whatever plan was on trial, so
                a Business trial read as a Pro one — on the page whose job is
                telling you what you are paying for. */}
            <p className="font-semibold">
              {planLabel(subscription.plan)} free trial active
            </p>
            <p className="text-muted-foreground">
              Your trial ends on {dateLabel(subscription.trial_ends_at)}. No card
              is on file and you won't be charged — at the end your account simply
              switches to the free plan. Add a card anytime to keep your{" "}
              {planLabel(subscription.plan)} features.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => openPlanPicker(subscription.plan as FlipdeskPlanKey)}
          >
            Add card
          </Button>
        </div>
      )}
      {paused && (
        <div className="flex items-start gap-3 rounded-md border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950/40">
          <Pause className="mt-0.5 h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400" />
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
            onClick={() =>
              resume.mutate(undefined, {
                onSuccess: () => track("subscription.resumed", { auto: false }),
              })
            }
            disabled={resume.isPending}
          >
            {resume.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            Resume now
          </Button>
        </div>
      )}
      {subscription.pending_plan && !canceling && !pastDue && (
        <div className="flex items-start gap-3 rounded-md border border-purple-200 bg-purple-50 p-4 dark:border-purple-900 dark:bg-purple-950/40">
          <ArrowDown className="mt-0.5 h-5 w-5 shrink-0 text-purple-600 dark:text-purple-400" />
          <div className="flex-1 text-sm">
            <p className="font-semibold">Downgrade scheduled</p>
            <p className="text-muted-foreground">
              Your plan switches to{" "}
              <strong>{planLabel(subscription.pending_plan)}</strong> on{" "}
              {dateLabel(subscription.pending_effective_at)}. Until then you
              keep {planLabel(subscription.plan)} features.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => undoDowngrade.mutate()}
            disabled={undoDowngrade.isPending}
          >
            {undoDowngrade.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Undo downgrade
          </Button>
        </div>
      )}
      {canceling && !pastDue && (
        <div className="flex items-start gap-3 rounded-md border border-orange-200 bg-orange-50 p-4 dark:border-orange-900 dark:bg-orange-950/40">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-orange-600 dark:text-orange-400" />
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
            onClick={() =>
              uncancel.mutate(undefined, {
                onSuccess: () => track("subscription.cancel_undone"),
              })
            }
            disabled={uncancel.isPending}
          >
            {uncancel.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
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
                      {dollars(nextChargeCents)}{" "}
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
                  {canceling ? (
                    <>Ends on {dateLabel(subscription.period_end)}</>
                  ) : (
                    <>
                      Next charge{" "}
                      <span className="font-medium text-foreground">
                        {dollars(nextChargeCents)}
                      </span>{" "}
                      on {dateLabel(nextChargeDate)}
                    </>
                  )}
                </span>
              </div>
            )}

            <Separator />

            {/* US-2524: ONE set of meters on this page. There used to be two —
                these three, and the shared four again lower down under "Same
                data, compact view", which is not a thing to ship. The shared
                component now carries the marketplaces meter that was the only
                reason for the second copy. */}
            <UsageMeters className="sm:grid-cols-2 lg:grid-cols-2" />

            <Separator />

            {/* US-807 / US-2126: a store-owned subscription hides every Stripe
                CTA and names the app to open. Google Play joined this branch in
                US-2126 — before that a Play subscriber saw all of them and the
                server refused each one with a 409. */}
            {appstoreManaged ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Smartphone className="h-4 w-4 shrink-0" />
                <span>Manage this plan in the GradeThread {storeApp} app.</span>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => openPlanPicker()}>
                  <TrendingUp className="mr-2 h-4 w-4" />
                  Change plan
                </Button>
                {subscription.plan !== "free" && !paused && !canceling && (
                  <Button
                    variant="outline"
                    onClick={() => openPlanPicker(subscription.plan as FlipdeskPlanKey)}
                  >
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Switch to {subscription.interval === "yearly" ? "monthly" : "annual"}
                  </Button>
                )}
                {subscription.plan !== "free" && !paused && !canceling && (
                  <Button variant="outline" onClick={() => setPauseOpen(true)}>
                    <Pause className="mr-2 h-4 w-4" />
                    Pause
                  </Button>
                )}
                {subscription.plan !== "free" && !canceling && (
                  <Button
                    variant="ghost"
                    className="text-red-700 hover:bg-red-50 hover:text-red-800 dark:text-red-300 dark:hover:bg-red-950/40 dark:hover:text-red-300"
                    onClick={() => setCancelOpen(true)}
                  >
                    <X className="mr-2 h-4 w-4" />
                    Cancel
                  </Button>
                )}
              </div>
            )}
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
              hint={includedResetHint}
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
              <Button
                variant="outline"
                onClick={() => navigate("/dashboard/submissions/new")}
              >
                <Sparkles className="mr-2 h-4 w-4" />
                Buy single grade
              </Button>
            </div>

            {summary.recent_ledger.length > 0 && (
              <>
                <Separator />
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-semibold uppercase text-muted-foreground">
                      Recent activity
                    </div>
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => setActivityOpen(true)}
                    >
                      View all
                    </Button>
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
                              ? "tabular-nums font-medium text-emerald-700 dark:text-emerald-300"
                              : entry.delta < 0
                                ? "tabular-nums font-medium text-red-700 dark:text-red-300"
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

      {/* US-2524: receipts, in the app. Every path to "what was I charged" used
          to leave for the Stripe portal. */}
      <InvoiceHistory />

      {/* Read-only plan comparison grid (US-211 AC #2) */}
      <FlipdeskPlanComparison
        currentPlan={subscription.plan as FlipdeskPlanKey}
        currentInterval={subscription.interval}
        onChoosePlan={(p) => openPlanPicker(p)}
      />

      {/* Tax transparency (US-223) — no hidden charges */}
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3 w-3 flex-shrink-0" />
        <span>
          Prices exclude tax. Any applicable sales tax or VAT is calculated at
          checkout based on your billing location and itemized on every receipt.
          Full invoices with the tax breakdown are available in the{" "}
          <button
            type="button"
            onClick={() => portal.mutate()}
            disabled={portal.isPending}
            className="underline underline-offset-2 hover:text-foreground disabled:opacity-50"
          >
            Stripe billing portal
          </button>
          .
        </span>
      </p>

      {/* Dialogs */}
      <CreditPackDialog open={creditPackOpen} onOpenChange={setCreditPackOpen} />
      <FlipdeskPlanPickerDialog
        open={planPickerOpen}
        onOpenChange={setPlanPickerOpen}
        highlightPlan={highlightPlan}
        // US-2125: picking the Free tile IS a cancellation. It used to open the
        // Stripe billing portal — a second path that skipped the reviewed flow's
        // period-end statement, acknowledgement checkbox, reason capture and undo
        // banner. Route it to the same dialog the Cancel button uses so there is
        // exactly ONE cancellation experience.
        onRequestCancel={() => setCancelOpen(true)}
      />
      <PauseSubscriptionDialog open={pauseOpen} onOpenChange={setPauseOpen} />
      <CancelSubscriptionDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        periodEnd={subscription.period_end}
      />
      <ActivityHistoryDialog open={activityOpen} onOpenChange={setActivityOpen} />
    </div>
  );
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
