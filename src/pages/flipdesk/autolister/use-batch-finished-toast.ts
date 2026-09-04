// Notify once when the generation batch finishes (US-325 AC4). Lifted out of
// autolister-queue.tsx under the US-2520 ratchet (2026-09-03).

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { BatchStatusResponse } from "@/hooks/use-autolister";

export function useBatchFinishedToast(
  data: BatchStatusResponse | undefined,
  batchId: string | null,
) {
  const notifiedRef = useRef<string | null>(null);
  const batchStatus = data?.batch.status;
  useEffect(() => {
    if (!data || !batchId) return;
    const terminal = batchStatus === "completed" || batchStatus === "partial" ||
      batchStatus === "failed";
    if (!terminal || notifiedRef.current === batchId) return;
    notifiedRef.current = batchId;
    const { succeeded_count: ok, failed_count: bad } = data.batch;
    if (bad === 0) {
      toast.success(`Generated ${ok} listing${ok === 1 ? "" : "s"}.`);
    } else {
      toast.warning(`Generation finished — ${ok} ready, ${bad} failed.`, {
        description: "Use “Retry failed” to re-run the ones that didn't generate.",
      });
    }
  }, [data, batchId, batchStatus]);
}
