import { AlertCircle, Loader2 } from "lucide-react";
import { useBillingSummary, useBillingPortal } from "@/hooks/use-billing-summary";
import { Button } from "@/components/ui/button";

// US-776: a persistent, app-wide banner shown whenever the subscription is
// past_due — so a user whose payment failed (and whose paid benefits are paused
// once the dunning grace elapses) sees it on EVERY page, not only when they
// happen to open /billing. Driven entirely by the subscription status already on
// the user row. Clears automatically when a successful payment flips the status
// back to active (the billing summary re-reads it).
//
// US-2455: it read the SELLER status and was mounted in the seller layout only,
// so a buyer whose card was declined saw nothing anywhere — the dunning email
// (US-2452) was the entire signal, and email is the weakest channel exactly when
// a card has gone stale along with the address. US-776's argument does not get
// weaker for the buyer product.
//
// THE PRODUCT IS A PROP, NOT INFERRED. A person can hold both subscriptions and
// be past_due on one while the other is fine; showing "your plan benefits are
// paused" in the buyer app because their FlipDesk card failed is an alarm about
// something they cannot act on from there — and the button would send them to
// the wrong billing page to fix it.

interface PastDueBannerProps {
  /** Which subscription this surface is about. Defaults to the seller product. */
  product?: "flipdesk" | "buyer";
}

export function PastDueBanner({ product = "flipdesk" }: PastDueBannerProps) {
  const { data: summary } = useBillingSummary();
  // Returning to the billing page for THIS product — see US-2125.
  const portal = useBillingPortal(product);

  const status = product === "buyer"
    ? summary?.buyer.status
    : summary?.subscription.status;
  if (status !== "past_due") return null;

  const planLabel = product === "buyer" ? "buyer plan" : "plan";

  return (
    <div
      role="alert"
      className="mb-4 flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40"
    >
      <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
      <div className="flex-1 text-sm">
        <p className="font-semibold text-red-700 dark:text-red-300">
          Payment failed — your {planLabel} benefits are paused
        </p>
        <p className="text-red-700/80 dark:text-red-300/80">
          We couldn&apos;t charge your card, so your paid {planLabel} is on hold. Update your
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
