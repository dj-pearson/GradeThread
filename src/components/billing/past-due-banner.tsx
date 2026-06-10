import { AlertCircle, Loader2 } from "lucide-react";
import { useBillingSummary, useBillingPortal } from "@/hooks/use-billing-summary";
import { Button } from "@/components/ui/button";

// US-776: a persistent, app-wide banner shown whenever the subscription is
// past_due — so a user whose payment failed (and whose paid benefits are paused
// once the dunning grace elapses) sees it on EVERY dashboard page, not only when
// they happen to open /billing. Driven entirely by subscription_status already on
// the user row. Clears automatically when a successful payment flips the status
// back to active (the billing summary re-reads it).

export function PastDueBanner() {
  const { data: summary } = useBillingSummary();
  const portal = useBillingPortal();

  if (summary?.subscription.status !== "past_due") return null;

  return (
    <div
      role="alert"
      className="mb-4 flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40"
    >
      <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
      <div className="flex-1 text-sm">
        <p className="font-semibold text-red-700 dark:text-red-300">
          Payment failed — your plan benefits are paused
        </p>
        <p className="text-red-700/80 dark:text-red-300/80">
          We couldn&apos;t charge your card, so your paid plan is on hold. Update your
          payment method to restore full access right away.
        </p>
      </div>
      <Button
        size="sm"
        variant="destructive"
        onClick={() => portal.mutate()}
        disabled={portal.isPending}
      >
        {portal.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
        Update payment method
      </Button>
    </div>
  );
}
