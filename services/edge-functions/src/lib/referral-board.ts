// The inputs to the public top-referrers board, read once and shared by the
// public feed (content-public.ts) and the caller's own rank on /api/referrals/me,
// so "You're #12" and the board it points at can never be ranked differently.
//
// Reads only opted-in users and their GRANTED referral events. Nothing here is
// tenant data leaving its tenant: the board publishes an alias and two numbers.

import { supabaseAdmin } from "./supabase.ts";
import { chunk, COHORT_IN_CHUNK, validateAlias } from "./leaderboards.ts";
import { referrerTotals, type ReferrerTotals } from "./referral-rewards.ts";

// Opted-in referrers read for the board, and granted rows read per chunk.
export const REFERRAL_BOARD_USER_CAP = 5000;
const GRANTED_ROWS_CAP = 50000;

export interface ReferralBoardInputs {
  eligible: Array<{ id: string; display_name: string; verified_handle: string | null }>;
  totals: Map<string, ReferrerTotals>;
}

function warnIfCapped(label: string, rows: number, cap: number): void {
  if (rows < cap) return;
  console.error(`[referral-board] ${label} returned exactly its ${cap}-row cap; the board is truncated.`);
}

/** Throws the PostgREST error on a failed read, so the caller picks the status. */
export async function loadReferralBoardInputs(): Promise<ReferralBoardInputs> {
  const { data: optedIn, error } = await supabaseAdmin
    .from("users")
    .select("id, referral_display_name, verified_handle, verified_enabled")
    .eq("referral_leaderboard_enabled", true)
    .not("referral_display_name", "is", null)
    .order("id", { ascending: true })
    .limit(REFERRAL_BOARD_USER_CAP);
  if (error) throw error;
  warnIfCapped("opted-in users", (optedIn ?? []).length, REFERRAL_BOARD_USER_CAP);

  const users = (optedIn ?? []) as Array<{
    id: string;
    referral_display_name: string | null;
    // US-1784: only a PUBLICLY-verified seller (verified_enabled) exposes a
    // handle, so the row can link to their /verified profile.
    verified_handle: string | null;
    verified_enabled: boolean | null;
  }>;

  // Aliases pass the same rules as the rewards boards. A stored name that
  // fails them (reserved words, hidden or bidi characters) is not published.
  const eligible: ReferralBoardInputs["eligible"] = [];
  for (const u of users) {
    const v = validateAlias(u.referral_display_name);
    if (!v.ok || !v.alias) continue;
    eligible.push({
      id: u.id,
      display_name: v.alias,
      verified_handle: u.verified_enabled ? u.verified_handle : null,
    });
  }

  // Rewarded referrals and the credits they actually paid. The id list is
  // chunked: one .in() with a few hundred uuids is a URL Kong answers with 414.
  const granted: Array<{ referrer_user_id: string; referrer_reward_credits: number | null }> = [];
  for (const ids of chunk(eligible.map((u) => u.id), COHORT_IN_CHUNK)) {
    const { data: rows, error: gErr } = await supabaseAdmin
      .from("referral_events")
      .select("referrer_user_id, referrer_reward_credits")
      .in("referrer_user_id", ids)
      .eq("reward_status", "granted")
      .limit(GRANTED_ROWS_CAP);
    if (gErr) throw gErr;
    warnIfCapped("granted referrals", (rows ?? []).length, GRANTED_ROWS_CAP);
    granted.push(...((rows ?? []) as typeof granted));
  }

  return { eligible, totals: referrerTotals(granted) };
}
