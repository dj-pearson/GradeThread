import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toastError } from "@/lib/toast-error";
import { supabase } from "@/lib/supabase";
import { edgeApiUrl } from "@/lib/edge-api";
import { edgeAuthHeaders } from "@/lib/edge-fetch";
import { bulkBatchKey } from "@/lib/bulk-batch-key";
import { useAuthStore } from "@/stores/auth-store";

export type GradingTier = "standard" | "premium" | "express";

// Mirror of the canonical backend tier prices in lib/grade-billing.ts
// (TIER_PRICE_CENTS). Kept here so the UI can show "$2.99" before the validate
// call returns. If costs ever drift, the validate response is authoritative —
// UI re-reads from there.
export const GRADING_TIER_COSTS: Record<GradingTier, number> = {
  standard: 2.99,
  premium: 7.99,
  express: 12.99,
};

export const GRADING_TIER_LABELS: Record<GradingTier, string> = {
  standard: "Standard (~7 days)",
  premium: "Premium (~24h)",
  express: "Express (~4h)",
};

// Credits a single grade of each tier consumes — mirrors the backend
// TIER_CREDIT_COST (grade-pricing.ts) / GRADETHREAD_TIERS.creditCost. The
// monthly included bundle only covers Standard grades; Premium/Express always
// draw credits (or a one-time charge).
export const GRADING_TIER_CREDIT_COST: Record<GradingTier, number> = {
  standard: 1,
  premium: 3,
  express: 5,
};

export interface ValidationItem {
  inventory_item_id: string;
  tier: GradingTier;
  cost: number;
  ready: boolean;
  blockers: string[];
  // US-2397: non-blocking notices from the server validator. Optional because an
  // edge deployed before this field still answers without it, and the card must
  // render against the older shape rather than crash on undefined.map.
  warnings?: string[];
  title: string | null;
  garment_type: string | null;
  garment_category: string | null;
  required_photo_types_missing: string[];
}

export interface ValidationResult {
  user: {
    plan: string;
    grades_used_this_month: number;
    plan_limit: number;
    grades_remaining: number;
    // Precedence inputs (returned by the edge): the monthly included grades
    // still available and the standing credit balance. Used to show the real
    // effective cost (free / credits / charge) rather than the gross price.
    included_remaining?: number;
    credit_balance?: number;
  };
  items: ValidationItem[];
  total_cost: number;
  can_submit: boolean;
  limit_exceeded: boolean;
}

// Pre-flight check. Returns per-item readiness + plan-limit info without
// creating any records. UI uses this to disable the submit button on
// items with blockers and to show estimated cost.
export function useValidateGrading() {
  return useMutation<
    ValidationResult,
    Error,
    { inventoryItemId: string; tier: GradingTier }
  >({
    mutationFn: async ({ inventoryItemId, tier }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/grading/validate`,
        {
          method: "POST",
          headers: await edgeAuthHeaders(),
          body: JSON.stringify({
            items: [{ inventory_item_id: inventoryItemId, tier }],
          }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Validation failed.");
      }
      return json as ValidationResult;
    },
    onError: (err) => toastError(err),
  });
}

export interface SubmitResult {
  submitted: number;
  failed: number;
  results: Array<
    | {
        ok: true;
        inventory_item_id: string;
        submission_id: string;
        flipdesk_grading_submission_id: string;
        tier: GradingTier;
        cost: number;
      }
    | {
        ok: false;
        inventory_item_id: string;
        error: string;
      }
  >;
}

export function useSubmitForGrading() {
  const qc = useQueryClient();
  return useMutation<
    SubmitResult,
    Error & { status?: number; validation?: ValidationResult },
    { inventoryItemId: string; tier: GradingTier; batchKey?: string }
  >({
    mutationFn: async ({ inventoryItemId, tier, batchKey }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/grading/submit`,
        {
          method: "POST",
          headers: await edgeAuthHeaders(),
          body: JSON.stringify({
            items: [{ inventory_item_id: inventoryItemId, tier }],
            // US-2564: the charge is keyed on this, so pressing Grade twice on
            // the same item at the same tier debits once.
            //
            // DERIVED, not a fresh UUID. A per-attempt token is unique by
            // definition, which makes it useless for the case that actually
            // costs money — the seller whose first press failed and who presses
            // again. bulkBatchKey over the single id gives the same stability
            // the bulk sheet has, and changes with the tier so a genuine upgrade
            // re-grade still goes through.
            batch_key: batchKey ?? bulkBatchKey([inventoryItemId], tier),
          }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err: Error & {
          status?: number;
          validation?: ValidationResult;
        } = new Error(json.error || "Submission failed.");
        err.status = res.status;
        if (json.validation) err.validation = json.validation;
        throw err;
      }
      return json as SubmitResult;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flipdesk_grading_submissions"] });
      qc.invalidateQueries({ queryKey: ["items_full"] });
    },
  });
}

// ── Bulk variants ──────────────────────────────────────────────────────
// The validate/submit endpoints already accept an `items` array, so bulk
// grading (e.g. the Kanban "Submit selected for grading" action, US-1458) is
// a single round-trip rather than N calls. All items share one tier.

export function useValidateGradingBulk() {
  return useMutation<
    ValidationResult,
    Error,
    { inventoryItemIds: string[]; tier: GradingTier }
  >({
    mutationFn: async ({ inventoryItemIds, tier }) => {
      const res = await fetch(`${edgeApiUrl()}/api/flipdesk/grading/validate`, {
        method: "POST",
        headers: await edgeAuthHeaders(),
        body: JSON.stringify({
          items: inventoryItemIds.map((id) => ({
            inventory_item_id: id,
            tier,
          })),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Validation failed.");
      }
      return json as ValidationResult;
    },
    onError: (err) => toastError(err),
  });
}

export function useSubmitGradingBulk() {
  const qc = useQueryClient();
  return useMutation<
    SubmitResult,
    Error & { status?: number; validation?: ValidationResult },
    { inventoryItemIds: string[]; tier: GradingTier; batchKey?: string }
  >({
    mutationFn: async ({ inventoryItemIds, tier, batchKey }) => {
      const res = await fetch(`${edgeApiUrl()}/api/flipdesk/grading/submit`, {
        method: "POST",
        headers: await edgeAuthHeaders(),
        body: JSON.stringify({
          items: inventoryItemIds.map((id) => ({
            inventory_item_id: id,
            tier,
          })),
          // US-2564: the caller passes the token it holds for this selection;
          // the fallback derives the same thing from the arguments, so a caller
          // that forgets is still protected. Never a fresh UUID — a per-attempt
          // token is unique by definition and would make every retry a new set
          // of charges, which is the defect this closes.
          batch_key: batchKey ?? bulkBatchKey(inventoryItemIds, tier),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err: Error & {
          status?: number;
          validation?: ValidationResult;
        } = new Error(json.error || "Submission failed.");
        err.status = res.status;
        if (json.validation) err.validation = json.validation;
        throw err;
      }
      return json as SubmitResult;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flipdesk_grading_submissions"] });
      qc.invalidateQueries({ queryKey: ["items_full"] });
    },
  });
}

// List of grading submissions for a given inventory item. The most-recent
// row drives the UI (status badge + ETA). Older completed rows are kept
// for history if the user re-submitted after a return.
export interface FlipdeskGradingSubmissionRow {
  id: string;
  inventory_item_id: string;
  submission_id: string | null;
  tier: GradingTier;
  status: string;
  cost: number;
  submitted_at: string | null;
  graded_at: string | null;
  webhook_received_at: string | null;
  error: string | null;
  created_at: string;
}

export function useItemGradingSubmissions(itemId: string | null) {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["flipdesk_grading_submissions", itemId, user?.id],
    enabled: !!user && !!itemId,
    // Poll while any row is mid-flight. We refetch every 8s — fast enough
    // for the user to see completion within the same dialog session,
    // slow enough not to hammer the DB when many items are in progress.
    refetchInterval: (query) => {
      const rows = (query.state.data as FlipdeskGradingSubmissionRow[] | undefined) ?? [];
      // Keep polling while a grade is mid-flight OR parked in pending_review
      // (a human reviewer can finalize it at any time → status flips to
      // 'completed', and we want the card to update without a manual refresh).
      const inflight = rows.some(
        (r) =>
          r.status === "pending" ||
          r.status === "processing" ||
          r.status === "pending_review",
      );
      return inflight ? 8_000 : false;
    },
    queryFn: async (): Promise<FlipdeskGradingSubmissionRow[]> => {
      if (!itemId) return [];
      const { data, error } = await supabase
        .from("flipdesk_grading_submissions")
        .select(
          "id, inventory_item_id, submission_id, tier, status, cost, submitted_at, graded_at, webhook_received_at, error, created_at",
        )
        .eq("inventory_item_id", itemId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as FlipdeskGradingSubmissionRow[];
    },
  });
}
