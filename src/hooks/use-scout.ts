import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { edgeFetch } from "@/lib/edge-fetch";
import type { ValueBasis } from "@/components/value/value-basis-note";

// ScoutAI sourcing (US-618). A scan grades candidate eBay listings from their own
// photos (private shadow grade) and ranks them by condition-adjusted margin.

export interface ScoutScored {
  itemId: string;
  title: string;
  imageUrl: string | null;
  itemWebUrl: string | null;
  askingCents: number | null;
  shadowGrade: number | null;
  gradeConfidence: number;
  valueLowCents: number | null;
  valueMedianCents: number | null;
  valueHighCents: number | null;
  /** US-2850: what the estimated value is. Absent on an older edge response. */
  valueBasis?: ValueBasis;
  estMarginCents: number | null;
  estMarginPct: number | null;
  underpriced: boolean;
  actionable: boolean;
  reason: string;
}

export interface ScoutScanResult {
  scanned: number;
  candidates: ScoutScored[];
  disclaimer?: string;
  note?: string;
}

export interface ScoutScanInput {
  categoryId: string;
  q?: string;
  brand?: string;
  limit?: number;
}

export function useScoutScan() {
  return useMutation<ScoutScanResult, Error, ScoutScanInput>({
    mutationFn: async (input) => {
      const res = await edgeFetch("/api/flipdesk/scout", {
        method: "POST",
        json: input,
      });
      const data = (await res.json().catch(() => ({}))) as
        & Partial<ScoutScanResult>
        & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Scout scan failed");
      return {
        scanned: data.scanned ?? 0,
        candidates: data.candidates ?? [],
        disclaimer: data.disclaimer,
        note: data.note,
      };
    },
    onSuccess: (r) => {
      const actionable = r.candidates.filter((c) => c.actionable).length;
      toast.success(
        `Scanned ${r.scanned} listing${r.scanned === 1 ? "" : "s"} — ${actionable} deal${actionable === 1 ? "" : "s"} worth a look.`,
      );
    },
    onError: (err) => toastError(err),
  });
}
