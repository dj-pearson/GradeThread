import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { refreshAuthProfile } from "@/hooks/use-auth";
import type { BillingSummary } from "@/hooks/use-billing-summary";
import {
  billingSignature,
  clearCheckoutPending,
  nextReconcileAction,
  readCheckoutPending,
} from "@/lib/checkout-pending";

// US-797: post-checkout reconciler. Mount ONCE high in the authed tree (the
// dashboard layout) so it survives navigation off the billing page. While a
// checkout-pending marker is set, it re-invalidates the billing summary and
// force-refreshes the auth profile (which drives the header plan badge) every
// few seconds until either the state changes (webhook landed) or a bounded
// window elapses (then it prompts a manual refresh). Also (re)starts on window
// focus so returning to the tab reconciles immediately.

const POLL_INTERVAL_MS = 2500;

export function useCheckoutReconciler(): void {
  const qc = useQueryClient();

  useEffect(() => {
    let intervalId: number | undefined;
    let baseline: string | null = null;
    let running = false;

    function currentSig(): string | null {
      // Match the billing summary regardless of the user-id key suffix.
      const entries = qc.getQueriesData<BillingSummary>({
        queryKey: ["billing_summary"],
      });
      const summary = entries.find(([, data]) => data != null)?.[1];
      return billingSignature(summary);
    }

    function refresh(): void {
      qc.invalidateQueries({ queryKey: ["billing_summary"] });
      void refreshAuthProfile();
    }

    function stop(): void {
      if (intervalId !== undefined) window.clearInterval(intervalId);
      intervalId = undefined;
      running = false;
    }

    function tick(): void {
      const pending = readCheckoutPending();
      if (!pending) {
        stop();
        return;
      }
      const action = nextReconcileAction({
        baseline,
        currentSig: currentSig(),
        since: pending.since,
        now: Date.now(),
      });
      switch (action) {
        case "set-baseline":
          baseline = currentSig();
          refresh();
          break;
        case "poll":
          refresh();
          break;
        case "reconciled":
          clearCheckoutPending();
          refresh();
          stop();
          break;
        case "timeout":
          clearCheckoutPending();
          toast.info(
            "Payment received — still finalizing. Refresh in a moment if your plan or credits haven't updated.",
          );
          stop();
          break;
      }
    }

    function start(): void {
      if (running || !readCheckoutPending()) return;
      running = true;
      baseline = null;
      tick(); // immediate first pass
      if (running) intervalId = window.setInterval(tick, POLL_INTERVAL_MS);
    }

    start();
    const onFocus = () => start();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      stop();
    };
  }, [qc]);
}
