import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toastError } from "@/lib/toast-error";
import { supabase } from "@/lib/supabase";
import { edgeApiUrl } from "@/lib/edge-api";
import { useAuthStore } from "@/stores/auth-store";

import { edgeAuthHeaders } from "@/lib/edge-fetch";

export interface PayoutImportRow {
  id: string;
  marketplace: string;
  import_method: string;
  payout_date: string | null;
  amount: number | null;
  reconciled: boolean;
  sale_id: string | null;
  raw_payload: Record<string, unknown>;
  created_at: string;
}

// All imported payout rows for this user. Reconciliation queue is a server
// view on top of this — see useReconciliationQueue (F2). For the F1 import
// surface we just need to display the freshly-loaded rows.
export function usePayoutImports() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["payout_imports", user?.id],
    enabled: !!user,
    queryFn: async (): Promise<PayoutImportRow[]> => {
      const { data, error } = await supabase
        .from("payout_imports")
        .select(
          "id, marketplace, import_method, payout_date, amount, reconciled, sale_id, raw_payload, created_at",
        )
        .order("payout_date", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as PayoutImportRow[];
    },
  });
}

export interface ImportPayoutsCsvResponse {
  imported: number;
  skipped: number;
  duplicates: number;
}

// Reconciliation queue — server-side join of unreconciled payouts with
// candidate sales scored by amount + date proximity. Top 5 candidates per
// payout. Empty array if everything is matched (or nothing's imported yet).
export interface QueueCandidate {
  sale_id: string;
  item_id: string;
  item_title: string | null;
  sale_date: string | null;
  sale_price: number | null;
  payout_amount: number | null;
  payout_reference: string | null;
  score: number;
  reasons: string[];
}

export interface QueueEntry {
  payout_import: {
    id: string;
    payout_date: string | null;
    amount: number | null;
    raw_payload: Record<string, unknown>;
    created_at: string;
  };
  candidates: QueueCandidate[];
}

// US-1452: the edge /queue caps the returned rows (default 100) and reports the
// true unreconciled total + has_more so the UI can flag that rows are hidden and
// point the seller at the Auto-match sweep (which processes ALL of them
// server-side, not just the loaded page).
export interface ReconciliationQueue {
  queue: QueueEntry[];
  total: number;
  hasMore: boolean;
  limit: number;
}

export function useReconciliationQueue() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["reconciliation_queue", user?.id],
    enabled: !!user,
    queryFn: async (): Promise<ReconciliationQueue> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/reconciliation/queue`,
        { headers: await edgeAuthHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Failed to load reconciliation queue.");
      }
      const queue = (json.queue ?? []) as QueueEntry[];
      return {
        queue,
        total: typeof json.total === "number" ? json.total : queue.length,
        hasMore: json.has_more === true,
        limit: typeof json.limit === "number" ? json.limit : queue.length,
      };
    },
  });
}

export interface ReconciliationRunResponse {
  auto_matched: number;
  ambiguous: number;
  no_candidates: number;
  scanned: number;
}

// Sweeps all unreconciled payouts server-side, auto-matching only the
// clearly-unambiguous ones. Anything that scores below the threshold OR
// has a close second-best stays queued for manual review.
export function useReconciliationRun() {
  const qc = useQueryClient();
  return useMutation<ReconciliationRunResponse, Error, void>({
    mutationFn: async () => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/reconciliation/run`,
        {
          method: "POST",
          headers: await edgeAuthHeaders(),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Auto-match failed.");
      }
      return json as ReconciliationRunResponse;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reconciliation_queue"] });
      qc.invalidateQueries({ queryKey: ["payout_imports"] });
      qc.invalidateQueries({ queryKey: ["sales_all"] });
    },
    onError: (err) => toastError(err),
  });
}

// Manually link a payout to a sale. 409 on conflict (sale already linked
// to a different payout); caller should surface that with a clear message.
export function useReconciliationMatch() {
  const qc = useQueryClient();
  return useMutation<
    { ok: true; payout_import_id: string; sale_id: string },
    Error & { status?: number; existingPayoutReference?: string },
    { payoutImportId: string; saleId: string }
  >({
    mutationFn: async ({ payoutImportId, saleId }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/reconciliation/match`,
        {
          method: "POST",
          headers: await edgeAuthHeaders(),
          body: JSON.stringify({
            payout_import_id: payoutImportId,
            sale_id: saleId,
          }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err: Error & {
          status?: number;
          existingPayoutReference?: string;
        } = new Error(json.error || "Match failed.");
        err.status = res.status;
        if (typeof json.existing_payout_reference === "string") {
          err.existingPayoutReference = json.existing_payout_reference;
        }
        throw err;
      }
      return json;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reconciliation_queue"] });
      qc.invalidateQueries({ queryKey: ["payout_imports"] });
      qc.invalidateQueries({ queryKey: ["sales_all"] });
    },
  });
}

export function useReconciliationDismiss() {
  const qc = useQueryClient();
  return useMutation<
    { ok: true; payout_import_id: string },
    Error,
    { payoutImportId: string }
  >({
    mutationFn: async ({ payoutImportId }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/reconciliation/dismiss/${encodeURIComponent(
          payoutImportId,
        )}`,
        {
          method: "POST",
          headers: await edgeAuthHeaders(),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Dismiss failed.");
      }
      return json;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reconciliation_queue"] });
      qc.invalidateQueries({ queryKey: ["payout_imports"] });
    },
    onError: (err) => toastError(err),
  });
}

export function useImportPayoutsCsv() {
  const qc = useQueryClient();
  return useMutation<ImportPayoutsCsvResponse, Error, { csv: string }>({
    mutationFn: async ({ csv }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/payouts/import-csv`,
        {
          method: "POST",
          headers: await edgeAuthHeaders(),
          body: JSON.stringify({ csv }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = json.detail ? ` — ${json.detail}` : "";
        throw new Error(`${json.error || "Import failed."}${detail}`);
      }
      return json as ImportPayoutsCsvResponse;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payout_imports"] });
    },
    onError: (err) =>
      toastError(err, "Could not import that payout file.", {
        duration: 12_000,
      }),
  });
}
