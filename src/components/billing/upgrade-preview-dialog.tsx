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
import { FLIPDESK_PLANS } from "@/lib/constants";
import type { FlipdeskPlanKey } from "@/lib/constants";
import type { BillingInterval } from "@/types/database";
import {
  useFlipdeskSubscribe,
  useUpgradePreview,
} from "@/hooks/use-billing-summary";
import { track } from "@/lib/analytics";
import { ArrowUp, Loader2 } from "lucide-react";

interface UpgradePreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The plan the user clicked. */
  targetPlan: Exclude<FlipdeskPlanKey, "free">;
  /** The interval to switch to — defaults to the user's current interval. */
  targetInterval: BillingInterval;
  /** The plan the user is on now, for the "from" label. */
  fromPlan: FlipdeskPlanKey;
}

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
export function UpgradePreviewDialog({
  open,
  onOpenChange,
  targetPlan,
  targetInterval,
  fromPlan,
}: UpgradePreviewDialogProps) {
  const preview = useUpgradePreview();
  const subscribe = useFlipdeskSubscribe();
  const next = FLIPDESK_PLANS[targetPlan];

  const { mutate: fetchPreview, reset: resetPreview } = preview;
  useEffect(() => {
    if (open) {
      track("subscription.upgrade_previewed", { from: fromPlan, to: targetPlan });
      fetchPreview({ plan: targetPlan, interval: targetInterval });
    } else {
      resetPreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetPlan, targetInterval]);

  const data = preview.data;
  const currency = data?.currency ?? "usd";

  function handleConfirm() {
    subscribe.mutate(
      { plan: targetPlan, interval: targetInterval, confirmUpgrade: true },
      {
        onSuccess: () => {
          track("subscription.upgrade_confirmed", { from: fromPlan, to: targetPlan });
          onOpenChange(false);
        },
      },
    );
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
            <p className="pt-1 text-xs text-muted-foreground">
              The prorated amount covers the rest of your current period at the
              new rate. After that, {money(data.new_recurring_cents, currency)}{" "}
              renews automatically on {dateLabel(data.next_renewal_at)}. Cancel
              any time.
            </p>
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
