import { useState } from "react";
import { Link } from "react-router";
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
import { Card, CardContent } from "@/components/ui/card";
import { useUpgradeDialogStore } from "@/stores/upgrade-dialog-store";
import { FlipdeskPlanPickerDialog } from "@/components/billing/flipdesk-plan-picker-dialog";
import { CreditPackDialog } from "@/components/billing/credit-pack-dialog";
import { CREDIT_PACKS, FLIPDESK_PLANS, GRADETHREAD_TIERS } from "@/lib/constants";
import { useBuyCreditPack } from "@/hooks/use-billing-summary";
import { useRedirectStore } from "@/stores/redirect-store";
import { track } from "@/lib/analytics";
import type { CreditPackSize } from "@/lib/constants";
import { ArrowRight, Loader2, Lock, ShoppingCart, Sparkles } from "lucide-react";

const FRIENDLY_CAP: Record<string, string> = {
  activeListings: "active listings",
  aiActions: "AI actions this month",
  marketplaces: "marketplace connections",
  includedGrades: "included Standard grades this month",
};

const FRIENDLY_FEATURE: Record<string, string> = {
  bulkActions: "Bulk actions",
  scheduledActions: "Scheduled actions",
  compPulls: "AI comp pulls",
  autoRelist: "Auto-relist",
  subAccounts: "Sub-accounts",
  apiAccess: "Programmatic API access",
  reconciliation: "Payout reconciliation",
  prioritySupport: "Priority support",
};

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ── UpgradeRequiredDialog (US-210) ──────────────────────────────
//
// Globally mounted (root-layout.tsx). Opens automatically when edgeFetch
// catches a 402 PAYMENT_REQUIRED response. Renders different content based
// on whether the gate is a capacity cap or a feature lock:
//
//   • Cap (activeListings/aiActions/marketplaces): show used/limit, offer
//     the cheapest plan that satisfies the need.
//   • Cap (includedGrades): also offer credit packs inline — they're the
//     non-subscription way to get more grades.
//   • Feature: show the cheapest plan that unlocks the feature.

export function UpgradeRequiredDialog() {
  const { open, reason, currentPlan, requiredPlan, offerCreditPack, hide } =
    useUpgradeDialogStore();
  const [planPickerOpen, setPlanPickerOpen] = useState(false);
  const [creditPackOpen, setCreditPackOpen] = useState(false);
  const buyPack = useBuyCreditPack();
  const isRedirecting = useRedirectStore((s) => s.isRedirecting);

  if (!reason || !requiredPlan) {
    return (
      <>
        <FlipdeskPlanPickerDialog
          open={planPickerOpen}
          onOpenChange={setPlanPickerOpen}
        />
        <CreditPackDialog
          open={creditPackOpen}
          onOpenChange={setCreditPackOpen}
        />
      </>
    );
  }

  const requiredPlanConfig = FLIPDESK_PLANS[requiredPlan];

  // US-210 hard-trigger telemetry. `cap` is the capacity kind or feature key
  // that blocked the action; fired with the action the user ultimately took.
  const capName = reason.type === "cap" ? reason.kind : reason.feature;
  const trackHard = (action: "upgrade" | "pack" | "dismiss") =>
    track("upgrade.trigger.hard", {
      cap: capName,
      plan: currentPlan,
      requiredPlan,
      action,
    });

  let title: string;
  let body: React.ReactNode;

  if (reason.type === "cap") {
    const friendly = FRIENDLY_CAP[reason.kind] ?? reason.kind;
    title = `You've hit your ${friendly} limit`;
    body = (
      <div className="space-y-3">
        <p>
          You're at <strong>{reason.used ?? "the cap"}</strong>
          {reason.limit != null ? ` of ${reason.limit}` : ""} on the{" "}
          <strong>{currentPlan ?? "current"}</strong> plan.{" "}
          {requiredPlanConfig.name === "Business"
            ? "Upgrade to Business for unlimited capacity."
            : `Upgrade to ${requiredPlanConfig.name} for more headroom.`}
        </p>
        {reason.kind === "includedGrades" && (
          <p className="text-sm text-muted-foreground">
            Or buy a credit pack — credits never expire and you can use them
            on any tier (1 = Standard, 3 = Premium, 5 = Express).
          </p>
        )}
      </div>
    );
  } else {
    const friendly = FRIENDLY_FEATURE[reason.feature] ?? reason.feature;
    title = `${friendly} requires ${requiredPlanConfig.name}`;
    body = (
      <p>
        This feature isn't included in the{" "}
        <strong>{currentPlan ?? "current"}</strong> plan. Upgrade to{" "}
        <strong>{requiredPlanConfig.name}</strong> to unlock it.
      </p>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          trackHard("dismiss");
          hide();
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5 text-brand-red-text" />
            {title}
          </DialogTitle>
          <DialogDescription asChild>
            <div>{body}</div>
          </DialogDescription>
        </DialogHeader>

        {/* Suggested-plan card */}
        <Card className="border-brand-navy border-2">
          <CardContent className="space-y-3 pt-6">
            <div className="flex items-center justify-between">
              <div>
                <Badge variant="secondary" className="mb-1">
                  Recommended
                </Badge>
                <div className="text-lg font-semibold">
                  Upgrade to {requiredPlanConfig.name}
                </div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold">
                  {dollars(requiredPlanConfig.priceMonthlyCents)}
                </div>
                <div className="text-xs text-muted-foreground">/mo</div>
              </div>
            </div>
            <div className="text-sm text-muted-foreground">
              {requiredPlanConfig.features.slice(0, 3).join(" · ")}
            </div>
          </CardContent>
        </Card>

        {/* Inline credit packs when the gate is includedGrades */}
        {offerCreditPack && (
          <div>
            <div className="mb-2 mt-3 text-sm font-semibold">
              Or buy credits instead
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {CREDIT_PACKS.map((pack) => {
                const list = pack.credits * GRADETHREAD_TIERS.standard.priceCents;
                const saved = list - pack.priceCents;
                const isBuying =
                  buyPack.isPending && buyPack.variables?.packSize === pack.credits;
                return (
                  <button
                    key={pack.credits}
                    onClick={() => {
                      trackHard("pack");
                      buyPack.mutate({ packSize: pack.credits as CreditPackSize });
                    }}
                    disabled={buyPack.isPending || isRedirecting}
                    className="group rounded-md border border-border p-3 text-left transition-colors hover:border-brand-navy hover:bg-muted/40 disabled:opacity-60"
                  >
                    <div className="text-lg font-semibold tabular-nums">
                      {pack.credits} credits
                    </div>
                    <div className="text-sm">${(pack.priceCents / 100).toFixed(2)}</div>
                    <div className="text-xs text-emerald-700 dark:text-emerald-300">
                      Save ${(saved / 100).toFixed(2)}
                    </div>
                    {isBuying && (
                      <Loader2 className="mt-1 h-3 w-3 animate-spin" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-between">
          <Button
            variant="ghost"
            onClick={() => {
              trackHard("dismiss");
              hide();
            }}
          >
            Not now
          </Button>
          <div className="flex flex-col gap-2 sm:flex-row">
            {offerCreditPack && (
              <Button
                variant="outline"
                onClick={() => {
                  trackHard("pack");
                  hide();
                  setCreditPackOpen(true);
                }}
              >
                <ShoppingCart className="mr-2 h-4 w-4" />
                See all packs
              </Button>
            )}
            <Button
              asChild
              onClick={() => {
                trackHard("upgrade");
                hide();
                setPlanPickerOpen(true);
              }}
            >
              <Link to="/dashboard/billing">
                <Sparkles className="mr-2 h-4 w-4" />
                Upgrade to {requiredPlanConfig.name}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>

      <FlipdeskPlanPickerDialog
        open={planPickerOpen}
        onOpenChange={setPlanPickerOpen}
        highlightPlan={requiredPlan}
      />
      <CreditPackDialog open={creditPackOpen} onOpenChange={setCreditPackOpen} />
    </Dialog>
  );
}
