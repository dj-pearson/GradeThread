import { CreditCard, Sparkles, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import { GRADETHREAD_TIERS } from "@/lib/constants";
import type { GradeTierKey } from "@/lib/constants";

// US-950: the billing method that will apply for a grade, mirroring the server
// precedence in grade-billing.ts — included monthly grades first (Standard
// only), then credits, then a one-time charge at checkout.
export type GradeBillingMethod = "included" | "credits" | "checkout";

interface GradePricingSummaryProps {
  tier: GradeTierKey;
  onTierChange: (tier: GradeTierKey) => void;
  creditBalance: number;
  includedUsed: number;
  includedLimit: number;
  planName: string;
}

// Mirrors the server precedence (grade-billing.ts) for a SINGLE tier so the
// step-1 summary can show, per tier, exactly which method would apply — without
// touching the actual charge logic (display only).
export function billingMethodForTier(
  tier: GradeTierKey,
  ctx: { creditBalance: number; includedUsed: number; includedLimit: number }
): GradeBillingMethod {
  const includedAvailable =
    tier === "standard" &&
    ctx.includedLimit > 0 &&
    ctx.includedUsed < ctx.includedLimit;
  if (includedAvailable) return "included";
  if (ctx.creditBalance >= GRADETHREAD_TIERS[tier].creditCost) return "credits";
  return "checkout";
}

function MethodBadge({ method }: { method: GradeBillingMethod }) {
  if (method === "included") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
        <Sparkles className="h-3 w-3" />
        Included
      </span>
    );
  }
  if (method === "credits") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
        <Wallet className="h-3 w-3" />
        Credits
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-brand-red/10 px-2 py-0.5 text-[11px] font-medium text-brand-red-text">
      <CreditCard className="h-3 w-3" />
      Checkout
    </span>
  );
}

/**
 * US-950: a persistent, interactive cost summary shown from step 1 so sellers
 * see each tier's price + credit cost and which billing method will apply
 * (included grade / credits / one-time checkout) BEFORE uploading photos — no
 * surprise payment wall after the work is done. Selecting a tier here updates
 * the same `tier` state used by the step-3 review, so the two stay in sync.
 * Display only — it reuses the precedence logic and never changes the charge.
 */
export function GradePricingSummary({
  tier,
  onTierChange,
  creditBalance,
  includedUsed,
  includedLimit,
  planName,
}: GradePricingSummaryProps) {
  const ctx = { creditBalance, includedUsed, includedLimit };
  const selectedMethod = billingMethodForTier(tier, ctx);
  const tierConfig = GRADETHREAD_TIERS[tier];

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Pricing &amp; billing</h3>
        <span className="text-xs text-muted-foreground">
          {creditBalance} credit{creditBalance === 1 ? "" : "s"} ·{" "}
          {Math.max(0, includedLimit - includedUsed)} included left
        </span>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {(Object.keys(GRADETHREAD_TIERS) as GradeTierKey[]).map((key) => {
          const t = GRADETHREAD_TIERS[key];
          const selected = tier === key;
          const method = billingMethodForTier(key, ctx);
          return (
            <button
              key={key}
              type="button"
              onClick={() => onTierChange(key)}
              aria-pressed={selected}
              className={cn(
                "rounded-lg border bg-background p-3 text-left transition-colors",
                selected
                  ? "border-primary ring-2 ring-primary/30"
                  : "border-border hover:border-primary/40"
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{t.label}</span>
                <span className="text-sm font-semibold tabular-nums">
                  ${(t.priceCents / 100).toFixed(2)}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t.slaHours <= 1 ? "~1 hour" : `~${t.slaHours} hours`} ·{" "}
                {t.creditCost} credit{t.creditCost === 1 ? "" : "s"}
              </p>
              <div className="mt-2">
                <MethodBadge method={method} />
              </div>
            </button>
          );
        })}
      </div>

      {/* Applicable-method summary for the selected tier — mirrors the step-3
          payment estimate so the outcome is clear from the start. */}
      <div className="rounded-md bg-background p-3 text-sm">
        {selectedMethod === "included" ? (
          <p className="font-medium text-emerald-600 dark:text-emerald-400">
            Free with your {planName} plan — {includedUsed} of {includedLimit}{" "}
            included grades used this month.
          </p>
        ) : selectedMethod === "credits" ? (
          <p className="font-medium">
            Uses {tierConfig.creditCost} credit
            {tierConfig.creditCost === 1 ? "" : "s"} (balance {creditBalance}) —
            no checkout needed.
          </p>
        ) : (
          <p className="font-medium text-brand-red-text">
            No included grades or credits left — a one-time{" "}
            {tierConfig.label} charge of $
            {(tierConfig.priceCents / 100).toFixed(2)} applies at checkout after
            you submit.
          </p>
        )}
      </div>
    </div>
  );
}
