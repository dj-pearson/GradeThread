import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { edgeFetch } from "@/lib/edge-fetch";

// Condition-aware dynamic repricing — nudges feed + scan/apply/dismiss.

export type ReasonCode = "UNDERPRICED" | "OVERPRICED" | "STALE" | "OK" | "NO_COMPS";

export interface RepriceSuggestion {
  id: string;
  inventory_item_id: string;
  listing_id: string;
  current_price_cents: number;
  suggested_price_cents: number;
  comp_median_cents: number | null;
  comp_count: number;
  condition_id: string | null;
  reason_code: ReasonCode;
  message: string;
  confidence: number;
  status: string;
  updated_at: string;
  inventory_items: {
    title: string | null;
    brand: string | null;
    grade_value: number | null;
    grade_label: string | null;
  } | null;
  listings: {
    listing_status: string;
    listing_url: string | null;
  } | null;
}

// US-565: post-publish performance feedback loop. One actionable suggestion per
// active listing that needs attention, derived from the engagement snapshot.
export type PerformanceSignalCode =
  | "NO_TRAFFIC"
  | "FEW_PHOTOS"
  | "LOW_CTR"
  | "WATCHED_NO_SALE";

export interface PerformanceSuggestion {
  listing_id: string;
  inventory_item_id: string;
  title: string;
  listing_url: string | null;
  code: PerformanceSignalCode;
  title_text: string;
  message: string;
  suggests_price_drop: boolean;
  suggests_best_offer: boolean;
  suggests_content_fix: boolean;
  // US-1899: 90+ days of total zero-engagement → a MANUAL "Sell Similar" last
  // resort may be worth it. A hint only; the UI gates it behind a confirmation.
  sell_similar_eligible: boolean;
}

export function usePerformanceSuggestions() {
  return useQuery({
    queryKey: ["performance_suggestions"],
    staleTime: 60_000,
    queryFn: async (): Promise<PerformanceSuggestion[]> => {
      const res = await edgeFetch("/api/flipdesk/pricing/performance");
      if (!res.ok) throw new Error("Failed to load performance suggestions");
      const data = (await res.json()) as { suggestions: PerformanceSuggestion[] };
      return data.suggestions ?? [];
    },
  });
}

export function useRepricingSuggestions() {
  return useQuery({
    queryKey: ["repricing_suggestions"],
    staleTime: 30_000,
    queryFn: async (): Promise<RepriceSuggestion[]> => {
      const res = await edgeFetch("/api/flipdesk/pricing/suggestions");
      if (!res.ok) throw new Error("Failed to load repricing suggestions");
      const data = (await res.json()) as { suggestions: RepriceSuggestion[] };
      return data.suggestions ?? [];
    },
  });
}

export function useScanRepricing() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (limit?: number) => {
      const res = await edgeFetch("/api/flipdesk/pricing/scan", {
        method: "POST",
        json: limit ? { limit } : {},
      });
      const data = (await res.json().catch(() => ({}))) as {
        scanned?: number;
        actionable?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Scan failed");
      return data;
    },
    onSuccess: (r) => {
      toast.success(
        `Scanned ${r.scanned ?? 0} listing${r.scanned === 1 ? "" : "s"} — ${r.actionable ?? 0} repricing nudge${r.actionable === 1 ? "" : "s"}.`,
      );
      queryClient.invalidateQueries({ queryKey: ["repricing_suggestions"] });
    },
    onError: (err: Error) => toastError(err),
  });
}

export function useApplyReprice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await edgeFetch(`/api/flipdesk/pricing/suggestions/${id}/apply`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        applied?: boolean;
        old_price?: number | null;
        new_price?: number;
        ebay_synced?: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Failed to apply");
      return data;
    },
    onSuccess: (r) => {
      // Both numbers. "New price $42.00" does not say whether that was a cut or
      // a rise, and the row it came from has already moved on.
      const move = typeof r.old_price === "number"
        ? `$${r.old_price.toFixed(2)} to $${(r.new_price ?? 0).toFixed(2)}`
        : `to $${(r.new_price ?? 0).toFixed(2)}`;
      toast.success(
        `Price changed ${move}${r.ebay_synced ? " and pushed to eBay" : ""}.`,
      );
      queryClient.invalidateQueries({ queryKey: ["repricing_suggestions"] });
    },
    onError: (err: Error) => toastError(err),
  });
}

// US-962: bulk match-to-comp reprice. Preview computes a per-listing suggested
// price off the repricing engine; apply pushes it (eBay where present + local),
// respecting the margin floor server-side.
export type BulkRepriceSkip = "no_comps" | "below_margin_floor";

export interface BulkRepricePreviewRow {
  listing_id: string;
  inventory_item_id: string;
  title: string;
  current_price_cents: number;
  suggested_price_cents: number;
  delta_cents: number;
  comp_count: number;
  comp_median_cents: number | null;
  reason_code: ReasonCode;
  margin_floor_cents: number | null;
  skip: BulkRepriceSkip | null;
}

export interface BulkRepricePreview {
  items: BulkRepricePreviewRow[];
  capped: boolean;
}

export interface BulkRepriceApplyResult {
  applied: number;
  ebay_synced: number;
  skipped: Array<{ listing_id: string; reason: BulkRepriceSkip | "not_found" }>;
  errors: Array<{ listing_id: string; message: string }>;
}

export function useBulkRepricePreview() {
  return useMutation({
    mutationFn: async (listingIds: string[]): Promise<BulkRepricePreview> => {
      const res = await edgeFetch("/api/flipdesk/pricing/reprice/preview", {
        method: "POST",
        json: { listingIds },
      });
      const data = (await res.json().catch(() => ({}))) as
        & Partial<BulkRepricePreview>
        & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't build the reprice preview.");
      return { items: data.items ?? [], capped: data.capped ?? false };
    },
    onError: (err: Error) => toastError(err),
  });
}

export function useBulkRepriceApply() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      items: Array<{ listing_id: string; price_cents: number }>,
    ): Promise<BulkRepriceApplyResult> => {
      const res = await edgeFetch("/api/flipdesk/pricing/reprice/apply", {
        method: "POST",
        json: { items },
      });
      const data = (await res.json().catch(() => ({}))) as
        & Partial<BulkRepriceApplyResult>
        & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't apply the new prices.");
      return {
        applied: data.applied ?? 0,
        ebay_synced: data.ebay_synced ?? 0,
        skipped: data.skipped ?? [],
        errors: data.errors ?? [],
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["items_full"] });
      queryClient.invalidateQueries({ queryKey: ["repricing_suggestions"] });
    },
    onError: (err: Error) => toastError(err),
  });
}

export function useDismissReprice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await edgeFetch(
        `/api/flipdesk/pricing/suggestions/${id}/dismiss`,
        { method: "POST" },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Failed to dismiss");
      }
      return true;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repricing_suggestions"] });
    },
    onError: (err: Error) => toastError(err),
  });
}

// US-2171 AC4: the repricing RULES that generate nudges automatically. The
// /api/flipdesk/pricing/rules + /rules/run endpoints were server-only; the
// repricing page now surfaces the rules and lets the seller run them on demand
// (create/edit/delete remain a follow-up — see the story note).
export interface RepriceRule {
  id: string;
  name: string;
  enabled: boolean;
  inventory_item_id: string | null;
  filter_brand: string | null;
  filter_category_id: string | null;
  min_age_days: number;
  drop_pct: number;
  interval_days: number;
  floor_price_cents: number | null;
  auto_accept_confidence: number | null;
  /** US-9205: may the rule move a price the seller set by hand? */
  override_manual: boolean;
  last_run_at: string | null;
}

// The create/update wire shape (snake_case) the server's normalizeRuleInput
// expects. PUT is a FULL replace, so an edit/toggle must round-trip every field
// or it silently wipes the ones it omits — ruleToInput() carries them all.
export interface RepriceRuleInput {
  name: string;
  enabled: boolean;
  inventory_item_id: string | null;
  filter_brand: string | null;
  filter_category_id: string | null;
  min_age_days: number;
  drop_pct: number;
  interval_days: number;
  floor_price_cents: number | null;
  auto_accept_confidence: number | null;
  override_manual: boolean;
}

export function ruleToInput(r: RepriceRule): RepriceRuleInput {
  return {
    name: r.name,
    enabled: r.enabled,
    inventory_item_id: r.inventory_item_id,
    filter_brand: r.filter_brand,
    filter_category_id: r.filter_category_id,
    min_age_days: r.min_age_days,
    drop_pct: r.drop_pct,
    interval_days: r.interval_days,
    floor_price_cents: r.floor_price_cents,
    auto_accept_confidence: r.auto_accept_confidence,
    override_manual: r.override_manual === true,
  };
}

export function useRepriceRules() {
  return useQuery({
    queryKey: ["repricing_rules"],
    queryFn: async (): Promise<RepriceRule[]> => {
      const res = await edgeFetch("/api/flipdesk/pricing/rules");
      const data = (await res.json().catch(() => ({}))) as {
        rules?: RepriceRule[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Couldn't load repricing rules.");
      return data.rules ?? [];
    },
  });
}

export interface RunRulesResult {
  applied: number;
}

export function useRunRepriceRules() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<RunRulesResult> => {
      const res = await edgeFetch("/api/flipdesk/pricing/rules/run", {
        method: "POST",
        json: {},
      });
      const data = (await res.json().catch(() => ({}))) as
        & Partial<RunRulesResult>
        & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't run the rules.");
      return { applied: data.applied ?? 0 };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repricing_suggestions"] });
      queryClient.invalidateQueries({ queryKey: ["repricing_rules"] });
      queryClient.invalidateQueries({ queryKey: ["repricing_actions"] });
    },
    onError: (err: Error) => toastError(err),
  });
}

export function useCreateRepriceRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RepriceRuleInput): Promise<RepriceRule> => {
      const res = await edgeFetch("/api/flipdesk/pricing/rules", {
        method: "POST",
        json: input,
      });
      const data = (await res.json().catch(() => ({}))) as {
        rule?: RepriceRule;
        error?: string;
      };
      if (!res.ok || !data.rule) throw new Error(data.error ?? "Couldn't create the rule.");
      return data.rule;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["repricing_rules"] }),
    onError: (err: Error) => toastError(err),
  });
}

export function useUpdateRepriceRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      args: { id: string; input: RepriceRuleInput },
    ): Promise<RepriceRule> => {
      const res = await edgeFetch(`/api/flipdesk/pricing/rules/${args.id}`, {
        method: "PUT",
        json: args.input,
      });
      const data = (await res.json().catch(() => ({}))) as {
        rule?: RepriceRule;
        error?: string;
      };
      if (!res.ok || !data.rule) throw new Error(data.error ?? "Couldn't update the rule.");
      return data.rule;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["repricing_rules"] }),
    onError: (err: Error) => toastError(err),
  });
}

export function useDeleteRepriceRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const res = await edgeFetch(`/api/flipdesk/pricing/rules/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Couldn't delete the rule.");
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["repricing_rules"] }),
    onError: (err: Error) => toastError(err),
  });
}

export interface RepriceAction {
  id: string;
  listing_id: string | null;
  old_price_cents: number | null;
  new_price_cents: number | null;
  reason: string | null;
  ebay_synced: boolean;
  created_at: string;
  inventory_items: { title: string | null; brand: string | null } | null;
}

// US-2171 AC4: the applied-changes feed (/rules/actions) — what the automation
// actually did, so a run-now isn't a black box.
export function useRepriceActions() {
  return useQuery({
    queryKey: ["repricing_actions"],
    staleTime: 30_000,
    queryFn: async (): Promise<RepriceAction[]> => {
      const res = await edgeFetch("/api/flipdesk/pricing/rules/actions");
      const data = (await res.json().catch(() => ({}))) as {
        actions?: RepriceAction[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Couldn't load applied changes.");
      return data.actions ?? [];
    },
  });
}
