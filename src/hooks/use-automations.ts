import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { edgeFetch } from "@/lib/edge-fetch";
import type { FilterField, FilterOp } from "@/lib/item-filter";

// Price-drop and promo scheduler (US-150) — rule CRUD, per-rule dry-run,
// activity log, and on-demand run. Wire shapes mirror
// services/edge-functions/src/lib/automation-rules.ts.

// Mirrors services/edge-functions/src/lib/automation-rules.ts — the server is
// the authority on shape and bounds; this is the client's copy of the contract.
export type AutomationTrigger =
  | { type: "days_listed_gt"; days: number; cooldown_days: number }
  | { type: "no_views_in_days"; days: number; cooldown_days: number }
  | { type: "watchers_lt_after_days"; watchers: number; days: number; cooldown_days: number }
  // US-2156: the non-aging half — react to the pipeline, not just the calendar.
  | { type: "offer_received"; days: number; cooldown_days: number }
  | { type: "return_opened"; days: number; cooldown_days: number }
  | { type: "compliance_violation"; min_violations: number; cooldown_days: number }
  | { type: "grade_completed"; days: number; max_grade: number | null; cooldown_days: number }
  | { type: "item_status_changed"; status: string; days: number; cooldown_days: number }
  | { type: "comp_price_moved"; direction: "above" | "below"; pct: number; cooldown_days: number }
  // US-2236: judged per OFFER, not per listing. Runs inside the same hourly
  // automations cron; the action is implied by the thresholds, so a rule of
  // this type ignores its action_json.
  | {
    type: "offer_threshold";
    accept_at_pct: number | null;
    decline_below_pct: number | null;
    /** US-2940: counter at this percent of list. Optional on the wire — a rule
     * stored before the counter existed has no field, and absent means null. */
    counter_at_pct?: number | null;
    margin_floor_pct: number;
    cooldown_days: number;
  }
  // US-2938: judged per RETURN, same reasoning as offer_threshold. The action is
  // implied by the limits, so a rule of this type ignores its action_json.
  | {
    type: "return_threshold";
    approve_at_or_below_cents: number | null;
    refund_without_return_at_or_below_cents: number | null;
    cooldown_days: number;
  };

export type AutomationAction =
  | { type: "price_drop_pct"; pct: number; margin_floor_pct: number }
  | { type: "set_promo_rate_pct"; pct: number }
  // US-1448: aged-inventory coded coupon (server generates the code + uses
  // the cover photo as eBay's required promotion image).
  | { type: "create_coded_coupon"; discount_pct: number }
  | { type: "end_listing" }
  // US-2156.
  | { type: "relist" }
  | { type: "crosslist_to"; platform: string }
  | { type: "send_offer_to_watchers"; discount_pct: number }
  | { type: "advance_status"; status: string }
  | { type: "notify"; message: string };

// US-2156 bounds — kept in lockstep with the server validator.
export const AUTOMATION_MESSAGE_MAX = 280;
export const MIN_WATCHER_OFFER_PCT = 5;
export const MAX_WATCHER_OFFER_PCT = 60;

/** Statuses an automation may write (server: AUTOMATION_SETTABLE_STATUSES). */
export const AUTOMATION_SETTABLE_STATUSES = [
  "sourced",
  "acquired",
  "cataloged",
  "measured",
  "photographed",
  "archived",
  "keeping",
  "wearing",
] as const;

/** Marketplaces a crosslist_to action may target. */
export const AUTOMATION_CROSSLIST_PLATFORMS = [
  "shopify",
  "poshmark",
  "mercari",
  "depop",
  "etsy",
  "whatnot",
] as const;

// Same vocabulary the US-143 FilterBuilder edits, plus the discriminator.
// The builder's per-rule `id` keys are accepted and ignored server-side, and
// the server returns rules WITHOUT ids — hence the optional `id`.
export interface AutomationScopeRule {
  id?: string;
  field: FilterField;
  op: FilterOp;
  value: string;
}

export type AutomationScope =
  | { type: "all" }
  | { type: "filter"; combinator: "and" | "or"; rules: AutomationScopeRule[] };

export interface AutomationRule {
  id: string;
  name: string;
  trigger_json: AutomationTrigger;
  action_json: AutomationAction;
  scope_json: AutomationScope;
  is_active: boolean;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutomationRuleInput {
  name: string;
  is_active: boolean;
  trigger_json: AutomationTrigger;
  action_json: AutomationAction;
  scope_json: AutomationScope;
}

export interface AutomationDryRunMatch {
  rule_id: string;
  rule_name: string;
  listing_id: string;
  inventory_item_id: string;
  title: string | null;
  action_type: AutomationAction["type"];
  current_price_cents: number;
  new_price_cents: number | null;
  current_promo_rate_pct: number | null;
  new_promo_rate_pct: number | null;
  floored: boolean;
  /**
   * US-2156: plain-English line for the actions the price/promo columns say
   * nothing about (crosslist, notify, advance status, watcher offer, relist).
   * Null for the price/promo/coupon/end actions.
   */
  effect?: string | null;
}

export interface AutomationActionRow {
  id: string;
  rule_id: string;
  listing_id: string | null;
  inventory_item_id: string | null;
  action_type: AutomationAction["type"];
  before_json: Record<string, unknown> | null;
  after_json: Record<string, unknown> | null;
  ebay_synced: boolean;
  created_at: string;
  inventory_items: { title: string | null; brand: string | null } | null;
}

const RULES_KEY = ["automation_rules"];

export function useAutomationRules() {
  return useQuery({
    queryKey: RULES_KEY,
    staleTime: 30_000,
    queryFn: async (): Promise<AutomationRule[]> => {
      const res = await edgeFetch("/api/flipdesk/automations/rules");
      if (!res.ok) throw new Error("Failed to load automation rules");
      const data = (await res.json()) as { rules: AutomationRule[] };
      return data.rules ?? [];
    },
  });
}

export function useCreateAutomationRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AutomationRuleInput) => {
      const res = await edgeFetch("/api/flipdesk/automations/rules", {
        method: "POST",
        json: input,
      });
      const data = (await res.json().catch(() => ({}))) as {
        rule?: AutomationRule;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Failed to create the rule");
      return data.rule!;
    },
    onSuccess: () => {
      toast.success("Automation rule created.");
      queryClient.invalidateQueries({ queryKey: RULES_KEY });
    },
    onError: (err: Error) => toastError(err),
  });
}

export function useUpdateAutomationRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: AutomationRuleInput }) => {
      const res = await edgeFetch(`/api/flipdesk/automations/rules/${id}`, {
        method: "PUT",
        json: input,
      });
      const data = (await res.json().catch(() => ({}))) as {
        rule?: AutomationRule;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Failed to update the rule");
      return data.rule!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: RULES_KEY });
    },
    onError: (err: Error) => toastError(err),
  });
}

export function useDeleteAutomationRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await edgeFetch(`/api/flipdesk/automations/rules/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Failed to delete the rule");
      }
      return true;
    },
    onSuccess: () => {
      toast.success("Rule deleted.");
      queryClient.invalidateQueries({ queryKey: RULES_KEY });
    },
    onError: (err: Error) => toastError(err),
  });
}

export function useDryRunAutomationRule() {
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await edgeFetch(
        `/api/flipdesk/automations/rules/${id}/dry-run`,
        { method: "POST" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        listings_scanned?: number;
        affected?: AutomationDryRunMatch[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Dry run failed");
      return {
        listings_scanned: data.listings_scanned ?? 0,
        affected: data.affected ?? [],
      };
    },
    onError: (err: Error) => toastError(err),
  });
}

export function useAutomationRuleActions(ruleId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["automation_rule_actions", ruleId],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<AutomationActionRow[]> => {
      const res = await edgeFetch(
        `/api/flipdesk/automations/rules/${ruleId}/actions`,
      );
      if (!res.ok) throw new Error("Failed to load the activity log");
      const data = (await res.json()) as { actions: AutomationActionRow[] };
      return data.actions ?? [];
    },
  });
}

export function useRunAutomations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await edgeFetch("/api/flipdesk/automations/run", {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        skipped?: boolean;
        applied?: number;
        listings_scanned?: number;
        errors?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Run failed");
      return data;
    },
    onSuccess: (r) => {
      if (r.skipped) {
        toast.info("Automations are temporarily disabled.");
        return;
      }
      toast.success(
        `Scanned ${r.listings_scanned ?? 0} listing${r.listings_scanned === 1 ? "" : "s"} — applied ${r.applied ?? 0} action${r.applied === 1 ? "" : "s"}.`,
      );
      queryClient.invalidateQueries({ queryKey: RULES_KEY });
      queryClient.invalidateQueries({ queryKey: ["automation_rule_actions"] });
      queryClient.invalidateQueries({ queryKey: ["items_full"] });
    },
    onError: (err: Error) => toastError(err),
  });
}
