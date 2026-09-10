import { useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ACTION_CREDIT_PACKS } from "@/lib/constants";
import { SalePrice } from "@/components/pricing/sale-price";
import type { ActionCreditPackKey } from "@/lib/constants";
import { useBillingSummary, useBuyActionCredits } from "@/hooks/use-billing-summary";
import { useActionCreditDialogStore } from "@/stores/action-credit-dialog-store";
import { useRedirectStore } from "@/stores/redirect-store";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { Loader2, Zap } from "lucide-react";

// US-3138: buying Action Credits. The sibling of credit-pack-dialog.tsx, which
// buys GRADE credits. Two wallets, two prices, two products, kept apart on
// purpose: the failure mode of merging them is a seller paying and receiving the
// wrong currency.

// US-3299: the local dollars() helper is gone — pack prices render through
// SalePrice, whose dollarsExact also handles the cents a discount creates.

/** Cents per credit, unrounded. The number the savings badge is derived from. */
function pricePerCredit(pack: { credits: number; priceCents: number }): number {
  return pack.priceCents / pack.credits;
}

// The smallest pack is the anchor, not a list price we invented. Quoting a
// discount against a made-up "regular price" would be a lie a buyer can check
// with a calculator; quoting it against the pack they would otherwise buy is
// true.
const ANCHOR = ACTION_CREDIT_PACKS[0]!;

function savingsPct(pack: { credits: number; priceCents: number }): number {
  const anchored = pack.credits * pricePerCredit(ANCHOR);
  return ((anchored - pack.priceCents) / anchored) * 100;
}

/**
 * The globally-mounted instance, opened from edgeFetch when a metered endpoint
 * answers 429 with can_top_up. Mounted once beside the upgrade dialog.
 *
 * It renders NOTHING until something opens it, so mounting it costs a store
 * subscription and no dialog weight.
 */
export function GlobalActionCreditDialog() {
  const open = useActionCreditDialogStore((s) => s.open);
  const hide = useActionCreditDialogStore((s) => s.hide);
  const returnPath = useActionCreditDialogStore((s) => s.returnPath);
  const source = useActionCreditDialogStore((s) => s.source);
  const balanceAtRefusal = useActionCreditDialogStore((s) => s.balanceAtRefusal);
  const creditsNeeded = useActionCreditDialogStore((s) => s.creditsNeeded);

  if (!open) return null;
  return (
    <ActionCreditDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) hide();
      }}
      returnPath={returnPath ?? undefined}
      source={source}
      balanceAtRefusal={balanceAtRefusal ?? undefined}
      creditsNeeded={creditsNeeded ?? undefined}
    />
  );
}

interface ActionCreditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Same-origin path to return to after Stripe Checkout. Pass the page the
   * seller ran out on, so they land back on the work they were blocked on
   * rather than having to find their way to it from Billing.
   */
  returnPath?: string;
  /** Where the dialog was opened from, for the conversion funnel. */
  source?: string;
  /**
   * The balance the SERVER reported when it refused, shown while the fresh
   * summary loads. Without it the dialog opens reading "0 credits" for a seller
   * who has 3, which reads as a bug in the very moment they are deciding
   * whether to trust us with money.
   */
  balanceAtRefusal?: number;
  /** How many credits the blocked action needed, when the server said. */
  creditsNeeded?: number;
}

export function ActionCreditDialog({
  open,
  onOpenChange,
  returnPath,
  source,
  balanceAtRefusal,
  creditsNeeded,
}: ActionCreditDialogProps) {
  const { data: summary } = useBillingSummary();
  const buyPack = useBuyActionCredits();
  const isRedirecting = useRedirectStore((s) => s.isRedirecting);

  const balance = summary?.action_credits?.balance ?? balanceAtRefusal ?? 0;

  // Prefer the SERVER's pack table once a summary has loaded: it is the table
  // the checkout actually charges from, so it cannot drift from what the seller
  // pays. The constants copy is the pre-load fallback.
  const packs = summary?.action_credits?.packs?.length
    ? summary.action_credits.packs.map((p) => ({
      key: p.key as ActionCreditPackKey,
      credits: p.credits,
      priceCents: p.price_cents,
      label: ACTION_CREDIT_PACKS.find((c) => c.key === p.key)?.label ?? "",
    }))
    : ACTION_CREDIT_PACKS;

  useEffect(() => {
    if (open) track("action_credits.opened", { balance, source: source ?? "unknown" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {creditsNeeded ? "You are out of AI actions" : "Buy Action Credits"}
          </DialogTitle>
          <DialogDescription>
            {creditsNeeded
              ? (
                <>
                  This needed{" "}
                  <span className="font-semibold tabular-nums">{creditsNeeded}</span>
                  {" "}more action{creditsNeeded === 1 ? "" : "s"} than your plan has
                  left this month. You have{" "}
                  <span className="font-semibold tabular-nums">{balance}</span>{" "}
                  credit{balance === 1 ? "" : "s"}. Top up and try again, or upgrade
                  your plan for a bigger monthly allowance.
                </>
              )
              : (
                <>
                  Current balance:{" "}
                  <span className="font-semibold tabular-nums">{balance}</span>{" "}
                  credit{balance === 1 ? "" : "s"}. They never expire, and they only
                  get used once your monthly allowance runs out.
                </>
              )}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {packs.map((pack) => {
            const isBest = pack.key === "400";
            const isBuying = buyPack.isPending && buyPack.variables?.pack === pack.key;
            const saved = savingsPct(pack);

            return (
              <Card
                key={pack.key}
                className={cn(
                  "relative flex flex-col",
                  isBest && "border-brand-red border-2",
                )}
              >
                {isBest && (
                  <Badge
                    variant="default"
                    className="bg-brand-red absolute -top-2 right-3 z-10"
                  >
                    <Zap className="mr-1 h-3 w-3" />
                    Most popular
                  </Badge>
                )}
                <CardContent className="flex flex-1 flex-col gap-3 pt-6">
                  <div className="space-y-1">
                    <div className="text-3xl font-bold tabular-nums">
                      {pack.credits.toLocaleString()}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      action{pack.credits === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="space-y-0.5">
                    {/* US-3299: struck-through list price + sale price when a
                        campaign covers this pack. Plain price otherwise. */}
                    <div className="text-2xl font-semibold">
                      <SalePrice
                        originalCents={pack.priceCents}
                        target={{ kind: "action_pack", key: pack.key }}
                        originalClassName="text-base font-medium"
                      />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {(pricePerCredit(pack)).toFixed(1)}&cent; per action
                    </div>
                  </div>
                  {saved >= 1
                    ? (
                      <Badge variant="secondary" className="self-start">
                        Save {saved.toFixed(0)}%
                      </Badge>
                    )
                    : <div className="h-5" aria-hidden="true" />}
                  <Button
                    className="mt-auto w-full"
                    onClick={() => {
                      track("action_credits.cta_clicked", {
                        pack: pack.key,
                        source: source ?? "unknown",
                      });
                      buyPack.mutate({ pack: pack.key, returnPath });
                    }}
                    disabled={buyPack.isPending || isRedirecting}
                  >
                    {isBuying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Buy {pack.credits.toLocaleString()}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="mt-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          <strong className="text-foreground">How Action Credits work:</strong>{" "}
          1 credit = 1 AI action. Your plan's monthly allowance is always spent
          first, so credits only come out when you have run past it. They never
          expire, and they keep working even if a payment fails.
        </div>
      </DialogContent>
    </Dialog>
  );
}
