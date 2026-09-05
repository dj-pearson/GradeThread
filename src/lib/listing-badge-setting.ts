// US-3060: reading the seller's on-marketplace badge preference.
//
// Split out of listing-badge-toggle.tsx so that file exports only components
// (react-refresh), the same shape lib/calculator-funnel.ts uses.
//
// ⚠ THE WHOLE POINT OF THIS FILE IS SURVIVING ITS OWN COLUMN NOT EXISTING.
// Migration 00727 is applied separately from the deploy, so between the two
// this runs against a schema with no `listing_badge_opt_out`.

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";

export const LISTING_BADGE_QUERY_KEY = "flipdesk-listing-badge-opt-out";

/**
 * True when the column is genuinely ABSENT rather than the read having failed.
 *
 * PostgREST answers 42703 for an undefined column and names it in the message;
 * both are checked because the code is the reliable half and the message is the
 * half that survives a client that drops the code.
 */
export function isMissingBadgeColumn(
  err: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!err) return false;
  return err.code === "42703" || /listing_badge_opt_out/.test(err.message ?? "");
}

export interface BadgeSetting {
  /** True when the seller has switched the badge OFF. */
  optOut: boolean;
  /** False while migration 00727 has not been applied to this environment. */
  writable: boolean;
}

/**
 * Turn a settings read into the switch's state.
 *
 * Pure, and separated from the query so the three cases can be tested without
 * a database. The interesting one is the middle: a MISSING COLUMN answers "not
 * opted out", which is the TRUE answer rather than a lenient one — with no
 * column and no switch, nobody can have opted out yet. What is genuinely
 * broken in that window is the WRITE, and `writable: false` is what says so,
 * rather than the switch accepting a click and reporting a save that did not
 * happen.
 *
 * Any OTHER read failure also shows "not opted out", because a toggle rendering
 * a preference we could not read would be a claim we cannot support — but it
 * stays writable, so a retry is a real save.
 */
export function badgeSettingFrom(
  row: { listing_badge_opt_out?: boolean | null } | null,
  err: { code?: string; message?: string } | null | undefined,
): BadgeSetting {
  if (err) return { optOut: false, writable: !isMissingBadgeColumn(err) };
  return { optOut: row?.listing_badge_opt_out === true, writable: true };
}

export function useListingBadgeSetting() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: [LISTING_BADGE_QUERY_KEY, user?.id],
    enabled: !!user,
    staleTime: 30 * 60 * 1000,
    queryFn: async (): Promise<BadgeSetting> => {
      const { data, error } = await supabase
        .from("flipdesk_settings")
        .select("listing_badge_opt_out")
        .eq("user_id", user!.id)
        .maybeSingle();
      return badgeSettingFrom(
        data as { listing_badge_opt_out?: boolean | null } | null,
        error,
      );
    },
  });
}
