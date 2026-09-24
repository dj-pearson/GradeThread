import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspace } from "@/hooks/use-workspace";

// SRC-2: ONE reader for the four flipdesk_settings sourcing columns.
//
// Scout and the settings card each had their own useQuery under the same
// ["sourcing_target", user.id] key, one caching a bare number and the other an
// object. Whichever mounted second read the other's shape: opening the deal
// filter after Scout loaded blanked every cost draft (and Save then wrote null
// over the seller's real costs), and the reverse order printed "[object
// Object]" and turned Min return into NaN. One query, one shape; callers
// narrow with `select`.
//
// Keyed and filtered on the WORKSPACE owner, because that is whose row the
// edge scan reads. RLS on flipdesk_settings is owner-only (00134), so a member
// cannot read the owner's row from the browser at all: the query is enabled
// only for the owner and members see the card read-only.

export interface SourcingSettings {
  sourcing_target_roi_pct: number | null;
  sourcing_shipping_cost_cents: number | null;
  sourcing_supplies_cost_cents: number | null;
  sourcing_grading_cost_cents: number | null;
}

/** Invalidate with this prefix after a write. */
export const SOURCING_SETTINGS_KEY = "sourcing_settings";

export function useSourcingSettings<T = SourcingSettings | null>(
  select?: (s: SourcingSettings | null) => T,
) {
  const user = useAuthStore((s) => s.user);
  const { workspaceOwnerId } = useWorkspace();
  const isOwner = !!user?.id && user.id === workspaceOwnerId;
  const query = useQuery({
    queryKey: [SOURCING_SETTINGS_KEY, workspaceOwnerId],
    enabled: isOwner,
    queryFn: async (): Promise<SourcingSettings | null> => {
      const { data, error } = await supabase
        .from("flipdesk_settings")
        .select(
          "sourcing_target_roi_pct, sourcing_shipping_cost_cents, sourcing_supplies_cost_cents, sourcing_grading_cost_cents",
        )
        .eq("user_id", workspaceOwnerId ?? "")
        .maybeSingle();
      if (error) throw error;
      return (data as SourcingSettings | null) ?? null;
    },
    select,
  });
  return { ...query, isOwner, workspaceOwnerId };
}

/** Mirrors MAX_SOURCING_TARGET_PCT (the CHECK in 00666). */
const MAX_TARGET_PCT = 1000;

/** Whole percent only: "12.5" and "30abc" are errors, not 12 and 30. */
export function parseTargetPct(text: string): number | null | "invalid" {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return "invalid";
  const n = Number.parseInt(trimmed, 10);
  if (n < 0 || n > MAX_TARGET_PCT) return "invalid";
  return n;
}
