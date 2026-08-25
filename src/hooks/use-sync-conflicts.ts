import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { edgeFetch } from "@/lib/edge-fetch";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";

// Cross-source sync conflicts (US-148): FlipDesk ↔ eBay ↔ Google Sheets
// disagreements written by the sync cycles. RLS has no policies on
// flipdesk_sync_conflicts (service-role only), so reads/writes go through the
// edge endpoints — never supabase-js directly.

export type ConflictFieldName = "price" | "quantity" | "listing_status" | "title";
export type ConflictSource = "flipdesk" | "ebay" | "sheets";

export interface SyncConflict {
  id: string;
  listing_id: string;
  field_name: ConflictFieldName;
  flipdesk_value: string | null;
  ebay_value: string | null;
  sheets_value: string | null;
  suggested_action: string | null;
  detected_at: string;
  listing_title: string | null;
  item_title: string | null;
  listing_url: string | null;
}

export interface SyncConflictsResponse {
  conflicts: SyncConflict[];
  total: number;
  showing: number;
  has_more: boolean;
}

export function useSyncConflicts() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["sync_conflicts", user?.id],
    enabled: !!user,
    staleTime: 30_000,
    queryFn: async (): Promise<SyncConflictsResponse> => {
      // silentGate: this read runs on page mount (tab badge) — a non-Business
      // user visiting Reconciliation shouldn't get the upgrade dialog from a
      // background query. Mutations below keep the gate UI.
      const res = await edgeFetch("/api/flipdesk/reconciliation/conflicts", {
        silentGate: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Failed to load sync conflicts.");
      }
      return json as SyncConflictsResponse;
    },
  });
}

export interface ResolveConflictsResult {
  ok: boolean;
  resolved: number;
  failed: Array<{ conflict_id: string; error: string }>;
}

// Resolves one or more conflicts by picking the winning source. The same
// endpoint covers a single field pick, "accept all from X" on one listing,
// and "accept all from X for selection" — just more entries in the array.
export function useResolveConflicts() {
  const qc = useQueryClient();
  return useMutation<
    ResolveConflictsResult,
    Error,
    { resolutions: Array<{ conflict_id: string; source: ConflictSource }> }
  >({
    mutationFn: async ({ resolutions }) => {
      const res = await edgeFetch("/api/flipdesk/reconciliation/conflicts/resolve", {
        method: "POST",
        json: { resolutions },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Failed to resolve conflicts.");
      }
      return json as ResolveConflictsResult;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["sync_conflicts"] });
      // Resolutions write through to listings (price/status/title/quantity).
      qc.invalidateQueries({ queryKey: ["items_full"] });
      if (data.resolved > 0) {
        toast.success(
          `Resolved ${data.resolved} conflict${data.resolved === 1 ? "" : "s"}.`,
        );
      }
      for (const f of data.failed.slice(0, 3)) {
        toast.error(f.error);
      }
      if (data.failed.length > 3) {
        toast.error(`…and ${data.failed.length - 3} more failed.`);
      }
    },
    onError: (err) => toastError(err),
  });
}

// ── Email alert threshold ───────────────────────────────────────────
//
// users.sync_conflict_email_threshold — one email per upward crossing of this
// open-conflict count; NULL disables. The users row is RLS-scoped to self, so
// plain supabase-js reads/writes work here.

export function useConflictThreshold() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["sync_conflict_threshold", user?.id],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<number | null> => {
      const { data, error } = await supabase
        .from("users")
        .select("sync_conflict_email_threshold")
        .eq("id", user!.id)
        .single();
      if (error) throw error;
      return (
        (data as { sync_conflict_email_threshold: number | null })
          .sync_conflict_email_threshold ?? null
      );
    },
  });
}

export function useSetConflictThreshold() {
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  return useMutation<void, Error, { threshold: number | null }>({
    mutationFn: async ({ threshold }) => {
      const { error } = await supabase
        .from("users")
        .update({ sync_conflict_email_threshold: threshold } as never)
        .eq("id", user!.id);
      if (error) throw error;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["sync_conflict_threshold"] });
      toast.success(
        vars.threshold == null
          ? "Conflict email alerts disabled."
          : `You'll get an email when open conflicts reach ${vars.threshold}.`,
      );
    },
    onError: (err) => toastError(err),
  });
}
