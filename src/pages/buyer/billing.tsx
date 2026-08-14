import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Check, Crown, Loader2, ExternalLink } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import {
  LoadingRegion,
  MetricCardSkeleton,
  SkeletonRows,
} from "@/components/ui/skeletons";
import { cn } from "@/lib/utils";
import {
  BUYER_PLANS,
  BUYER_PLAN_RANK,
  type BuyerGateFlags,
  type BuyerPlanKey,
} from "@/lib/constants";
import { UsageMeter } from "@/components/billing/usage-meter";
import { AutoRenewalDisclosure } from "@/components/billing/auto-renewal-disclosure";
import { UpgradePreviewDialog } from "@/components/billing/upgrade-preview-dialog";
import { useBillingSummary, useBuyerSubscribe, useBuyerCancel, useBuyerUncancel, useBillingPortal } from "@/hooks/use-billing-summary";
import { useBuyerEntitlements } from "@/hooks/use-buyer-entitlements";
import { trackBuyerFunnel } from "@/lib/buyer-analytics";

// US-1801: buyer billing surface. Current plan + renewal + Stripe portal, a
// monthly/yearly plan picker, cancel/resume, and metered-allowance usage. The
// EFFECTIVE plan (useBuyerEntitlements) may exceed the paid subscription when a
// seller's FlipDesk tier bundles buyer functions (US-1887) — in that case there
// is nothing to subscribe to (or cancel) below the bundled tier.

const PLAN_ORDER: BuyerPlanKey[] = ["free", "guard", "connoisseur"];

const dollars = (cents: number) =>
  cents === 0 ? "Free" : `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** The lowest buyer tier that unlocks a given gate flag (for ?upgrade= deep-links). */
function tierForFlag(flag: string): BuyerPlanKey | null {
  for (const key of PLAN_ORDER) {
    if (BUYER_PLANS[key].gateFlags[flag as keyof BuyerGateFlags]) return key;
  }
  return null;
}

export function BuyerBillingPage() {
  const [params, setParams] = useSearchParams();
  const { data: summary, isLoading } = useBillingSummary();
  const ent = useBuyerEntitlements();
  const subscribe = useBuyerSubscribe();
  const cancel = useBuyerCancel();
  const uncancel = useBuyerUncancel();
  // US-2125: return from Stripe to THIS page, not the seller's.
  const portal = useBillingPortal("buyer");
  const [interval, setInterval] = useState<"monthly" | "yearly">("monthly");
  // US-2118: the tier the buyer clicked while ALREADY paying. That click is an
  // in-place change that charges a prorated amount immediately, so it opens the
  // disclosure dialog instead of the mutation. A buyer with no live
  // subscription still goes straight to Stripe Checkout, which discloses on its
  // own hosted page.
  const [upgradeTarget, setUpgradeTarget] =
    useState<Exclude<BuyerPlanKey, "free"> | null>(null);
  // US-2453: ?cancel=1 lands on the cancellation control, mirroring the seller
  // page (US-2122 AC2). The buyer welcome email is required to say HOW to
  // cancel, and it links here — "go to billing and look for the button" is not
  // that. There is no confirmation dialog on this page to open, so the honest
  // equivalent is to move focus to the control: it names the button, puts the
  // keyboard on it, and scrolls it into view without acting for the user.
  const cancelRef = useRef<HTMLButtonElement>(null);

  const upgradeFlag = params.get("upgrade");
  const highlight = upgradeFlag ? tierForFlag(upgradeFlag) : null;

  // Only when there is something to cancel — focusing nothing, or a "Resume
  // plan" button, would be worse than ignoring the link. The param is stripped
  // either way so a refresh or a Back press does not re-fire it.
  useEffect(() => {
    if (params.get("cancel") !== "1") return;
    cancelRef.current?.focus();
    cancelRef.current?.scrollIntoView({ block: "center" });
    const next = new URLSearchParams(params);
    next.delete("cancel");
    setParams(next, { replace: true });
  }, [params, setParams]);

  // US-1845: the conversion itself. Stripe returns to
  // /buyer/billing?checkout=success&product=buyer, so the return URL is the one
  // unambiguous "they paid" moment on this surface — reading the current plan
  // instead would re-fire on every later visit to the page.
  const checkoutSucceeded =
    params.get("checkout") === "success" && params.get("product") === "buyer";
  const paidPlan = summary?.buyer.plan ?? null;
  const paidInterval = summary?.buyer.interval ?? null;
  useEffect(() => {
    if (!checkoutSucceeded) return;
    trackBuyerFunnel("subscribed", {
      buyer_plan: paidPlan ?? undefined,
      interval: paidInterval ?? undefined,
    });
  }, [checkoutSucceeded, paidPlan, paidInterval]);

  if (isLoading || !summary) {
    return (
      <LoadingRegion
        label="Loading billing"
        className="mx-auto max-w-4xl space-y-6"
      >
        <SkeletonRows rows={2} className="space-y-4" />
        <div className="grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <MetricCardSkeleton key={i} />
          ))}
        </div>
      </LoadingRegion>
    );
  }

  const effective = ent.plan; // what the buyer actually has (higher of sub + seller)
  const effectiveRank = BUYER_PLAN_RANK[effective];
  const paid = summary.buyer; // the buyer subscription they pay for directly
  const hasPaidSub = paid.plan !== "free" && (paid.status === "active" || paid.status === "trialing");
  const config = BUYER_PLANS[effective];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title="Buyer plan & billing"
        subtitle="Manage your buyer subscription and see your monthly usage."
      />

      {/* Current plan */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Crown className="h-5 w-5 text-primary" />
            You're on {config.name}
          </CardTitle>
          <CardDescription>
            {ent.fromSellerPlan
              ? "Included with your seller (FlipDesk) plan — no separate buyer charge."
              : hasPaidSub
                ? paid.cancel_at_period_end
                  ? `Your plan ends on ${fmtDate(paid.period_end)}.`
                  : `Renews ${fmtDate(paid.period_end)}${paid.interval ? ` (${paid.interval})` : ""}.`
                : "Free plan — upgrade below for the full confidence suite."}
          </CardDescription>
        </CardHeader>
        {(hasPaidSub || summary.subscription.stripe_customer_id) && (
          <CardContent className="flex flex-wrap gap-2">
            {hasPaidSub && !paid.cancel_at_period_end && (
              <Button
                ref={cancelRef}
                variant="outline"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending}
              >
                {cancel.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Cancel plan
              </Button>
            )}
            {hasPaidSub && paid.cancel_at_period_end && (
              <Button onClick={() => uncancel.mutate()} disabled={uncancel.isPending}>
                {uncancel.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Resume plan
              </Button>
            )}
            {summary.subscription.stripe_customer_id && (
              <Button variant="ghost" onClick={() => portal.mutate()} disabled={portal.isPending}>
                <ExternalLink className="mr-2 h-4 w-4" />
                Manage in Stripe
              </Button>
            )}
          </CardContent>
        )}
      </Card>

      {/* Usage this month */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Usage this month</CardTitle>
          <CardDescription>
            Your {config.name} allowances{summary.buyer.usage_reset_at ? ` · resets ${fmtDate(summary.buyer.usage_reset_at)}` : ""}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <UsageMeter
            label="Extension condition checks"
            used={summary.buyer.usage.extension_checks}
            limit={config.extensionChecksPerMonth}
          />
          <UsageMeter
            label="Authenticity credits"
            used={summary.buyer.usage.authenticity_credits}
            limit={config.authenticityCreditsPerMonth}
          />
          <UsageMeter
            label="Video-grade credits"
            used={summary.buyer.usage.video_grades}
            limit={config.videoGradeCreditsPerMonth}
          />
        </CardContent>
      </Card>

      {/* Plan picker */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-lg">Plans</CardTitle>
            <CardDescription>Upgrade for more confidence tools.</CardDescription>
          </div>
          <div className="flex rounded-md border p-0.5 text-sm">
            {(["monthly", "yearly"] as const).map((iv) => (
              <button
                key={iv}
                type="button"
                onClick={() => setInterval(iv)}
                className={cn(
                  "rounded px-3 py-1 capitalize transition-colors",
                  interval === iv ? "bg-primary text-primary-foreground" : "text-muted-foreground",
                )}
              >
                {iv}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          {PLAN_ORDER.map((key) => {
            const plan = BUYER_PLANS[key];
            const rank = BUYER_PLAN_RANK[key];
            const isCurrent = rank === effectiveRank;
            const isIncluded = rank <= effectiveRank;
            const price = interval === "yearly" ? plan.priceYearlyCents : plan.priceMonthlyCents;
            return (
              <div
                key={key}
                className={cn(
                  "flex flex-col rounded-lg border p-4",
                  (isCurrent || highlight === key) && "border-primary ring-1 ring-primary",
                )}
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">{plan.name}</h3>
                  {isCurrent && <Badge variant="secondary">Current</Badge>}
                </div>
                <p className="mt-1 text-2xl font-bold">
                  {dollars(price)}
                  {price > 0 && <span className="text-sm font-normal text-muted-foreground">/{interval === "yearly" ? "yr" : "mo"}</span>}
                </p>
                <ul className="mt-3 flex-1 space-y-1.5 text-xs text-muted-foreground">
                  {plan.features.slice(0, 5).map((f) => (
                    <li key={f} className="flex items-start gap-1.5">
                      <Check className="mt-0.5 h-3 w-3 flex-shrink-0 text-primary" />
                      {f}
                    </li>
                  ))}
                </ul>
                <div className="mt-4">
                  {key === "free" || isIncluded ? (
                    <Button variant="outline" className="w-full" disabled>
                      {isCurrent ? "Current plan" : isIncluded ? "Included" : "Free"}
                    </Button>
                  ) : (
                    <Button
                      className="w-full"
                      onClick={() => {
                        trackBuyerFunnel("subscribe_start", {
                          buyer_plan: key,
                          interval,
                          from_plan: effective,
                          upgrade_flag: upgradeFlag ?? undefined,
                        });
                        // US-2118: with a live buyer subscription this is an
                        // in-place change — Stripe charges the proration on
                        // the spot and there is no hosted page to disclose it.
                        // The server now refuses without confirmUpgrade, so
                        // firing the mutation here would only produce a 409.
                        if (hasPaidSub) {
                          setUpgradeTarget(key as Exclude<BuyerPlanKey, "free">);
                          return;
                        }
                        subscribe.mutate({ plan: key as "guard" | "connoisseur", interval });
                      }}
                      disabled={subscribe.isPending}
                    >
                      {subscribe.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {effectiveRank > 0 ? "Switch" : "Upgrade"}
                    </Button>
                  )}
                  {/* US-2115: same screen, directly under the button that buys
                      it. Only on tiles that can actually be purchased — the
                      disabled "Current plan"/"Included"/"Free" tiles are not a
                      point of sale. */}
                  {!(key === "free" || isIncluded) && (
                    <AutoRenewalDisclosure
                      className="mt-2"
                      amountCents={price}
                      interval={interval}
                      renewsOn={hasPaidSub ? paid.period_end : null}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {upgradeTarget && (
        <UpgradePreviewDialog
          product="buyer"
          open={!!upgradeTarget}
          onOpenChange={(v) => {
            if (!v) setUpgradeTarget(null);
          }}
          targetPlan={upgradeTarget}
          targetInterval={interval}
          fromPlan={paid.plan}
        />
      )}

      {ent.fromSellerPlan && (
        <p className="text-center text-xs text-muted-foreground">
          Your buyer tools are included with your FlipDesk seller plan. Manage that subscription in{" "}
          <a href="/dashboard/account?tab=billing" className="underline">seller billing</a>.
        </p>
      )}
    </div>
  );
}
