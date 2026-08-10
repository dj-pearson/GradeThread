import { useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { BUYER_PLANS, FLIPDESK_PLANS } from "@/lib/constants";
import type { BuyerPlanKey, FlipdeskPlanKey } from "@/lib/constants";
import type { BillingInterval } from "@/types/database";
import {
  useBuyerSubscribe,
  useBuyerUpgradePreview,
  useFlipdeskSubscribe,
  useUpgradePreview,
} from "@/hooks/use-billing-summary";
import { track } from "@/lib/analytics";
import { AutoRenewalDisclosure } from "@/components/billing/auto-renewal-disclosure";
import { ArrowUp, Loader2 } from "lucide-react";

// US-2118: which subscription product is being changed. Discriminated so a
// buyer tier can never be passed with product:"flipdesk" — the two have
// different plan keys, different price tables and different Stripe
// subscription ids, and mixing them would preview one charge and make another.
type UpgradeTarget =
  | {
    product: "flipdesk";
    /** The plan the user clicked. */
    targetPlan: Exclude<FlipdeskPlanKey, "free">;
    /** The plan the user is on now, for the "from" label. */
    fromPlan: FlipdeskPlanKey;
  }
  | {
    product: "buyer";
    targetPlan: Exclude<BuyerPlanKey, "free">;
    fromPlan: BuyerPlanKey;
  };

type UpgradePreviewDialogProps = UpgradeTarget & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The interval to switch to — defaults to the user's current interval. */
  targetInterval: BillingInterval;
};

function money(cents: number | null | undefined, currency = "usd"): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

function dateLabel(iso: string | null | undefined): string {
  if (!iso) return "your next renewal date";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

// US-2118: an in-place upgrade charges a prorated amount immediately. This dialog
// is the disclosure + affirmative consent a new subscriber would get on the
// Stripe Checkout page — the amount today, the new recurring rate + frequency,
// and the next renewal date — BEFORE the (server-gated) mutation fires.
export function UpgradePreviewDialog(props: UpgradePreviewDialogProps) {
  const { open, onOpenChange, targetPlan, targetInterval, fromPlan, product } = props;
  // Both products' hooks are created unconditionally — they are useMutation
  // pairs with no work until called, and calling hooks behind a branch is the
  // rule this component would otherwise break. Only one pair is ever used.
  const flipdeskPreview = useUpgradePreview();
  const flipdeskSubscribe = useFlipdeskSubscribe();
  const buyerPreview = useBuyerUpgradePreview();
  const buyerSubscribe = useBuyerSubscribe();

  const isBuyer = product === "buyer";
  const preview = isBuyer ? buyerPreview : flipdeskPreview;
  const next = isBuyer
    ? BUYER_PLANS[targetPlan as Exclude<BuyerPlanKey, "free">]
    : FLIPDESK_PLANS[targetPlan as Exclude<FlipdeskPlanKey, "free">];

  const { reset: resetPreview } = preview;
  useEffect(() => {
    if (open) {
      track("subscription.upgrade_previewed", { product, from: fromPlan, to: targetPlan });
      // Narrowed through the prop union rather than the local alias: each hook
      // only accepts its own product's plan keys.
      if (props.product === "buyer") {
        buyerPreview.mutate({ plan: props.targetPlan, interval: targetInterval });
      } else {
        flipdeskPreview.mutate({ plan: props.targetPlan, interval: targetInterval });
      }
    } else {
      resetPreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetPlan, targetInterval, product]);

  const data = preview.data;
  const currency = data?.currency ?? "usd";
  const subscribe = isBuyer ? buyerSubscribe : flipdeskSubscribe;

  function handleConfirm() {
    const onSuccess = () => {
      track("subscription.upgrade_confirmed", { product, from: fromPlan, to: targetPlan });
      onOpenChange(false);
    };
    if (props.product === "buyer") {
      buyerSubscribe.mutate(
        { plan: props.targetPlan, interval: targetInterval, confirmUpgrade: true },
        { onSuccess },
      );
    } else {
      flipdeskSubscribe.mutate(
        { plan: props.targetPlan, interval: targetInterval, confirmUpgrade: true },
        { onSuccess },
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowUp className="h-5 w-5" />
            Upgrade to {next.name}
          </DialogTitle>
          <DialogDescription>
            This takes effect immediately. Here's exactly what you'll be charged
            before you confirm.
          </DialogDescription>
        </DialogHeader>

        {preview.isPending && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Calculating your prorated charge…
          </div>
        )}

        {preview.isError && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            We couldn't calculate the charge just now. Please try again in a
            moment.
          </div>
        )}

        {data && !preview.isPending && (
          <div className="space-y-3 text-sm">
            <Row
              label="Charged today (prorated)"
              value={money(data.amount_due_today_cents, currency)}
              emphasis
            />
            <Separator />
            <Row
              label={`New ${data.interval ?? targetInterval} rate`}
              value={`${money(data.new_recurring_cents, currency)} / ${
                (data.interval ?? targetInterval) === "yearly" ? "year" : "month"
              }`}
            />
            <Row label="Next renewal" value={dateLabel(data.next_renewal_at)} />
            {/* US-2115: this dialog had the only correct renewal copy in the
                repo, hand-written here. It now renders the shared disclosure
                instead — it was the fifth subscription surface and the one most
                likely to drift away from the other four precisely because it
                already looked done. The prorated sentence stays, since it is
                specific to an in-place upgrade and the shared component does
                not model proration. */}
            <p className="pt-1 text-xs text-muted-foreground">
              The prorated amount covers the rest of your current period at the
              new rate.
            </p>
            {/* No recurring amount means the server could not price the
                upgrade. Stating renewal terms without the amount would be a
                worse disclosure than none, and the Row above already shows the
                "—" fallback, so stay silent rather than guess. */}
            {data.new_recurring_cents != null && (
              <AutoRenewalDisclosure
                amountCents={data.new_recurring_cents}
                interval={data.interval ?? targetInterval}
                renewsOn={data.next_renewal_at}
                currency={currency}
              />
            )}
          </div>
        )}

        <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-between">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Never mind
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={subscribe.isPending || preview.isPending || preview.isError}
          >
            {subscribe.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Confirm &amp; pay {money(data?.amount_due_today_cents, currency)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={
          emphasis
            ? "text-2xl font-bold tabular-nums"
            : "font-medium tabular-nums"
        }
      >
        {value}
      </span>
    </div>
  );
}
