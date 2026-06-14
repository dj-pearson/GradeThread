// US-629 / US-864: referral reward sizes (grade credits).
//
// Kept in a tiny leaf module so every importer — the grant path
// (lib/referrals.ts), the admin route, the user-facing /referrals/me endpoint,
// and the public leaderboard feed (content-public.ts) — can read the same
// numbers WITHOUT pulling in the notify/email graph that lib/referrals.ts needs
// for the actual grant.

// Credits granted to the referrer when one of their referrals is rewarded.
export const REFERRER_REWARD_CREDITS = 5;
// Credits granted to the referred (new) user on the same event.
export const REFERRED_REWARD_CREDITS = 3;

export interface ReferrerLeaderboardRow {
  display_name: string;
  referrals: number;
  credits_earned: number;
}

// Pure ranking for the public top-referrers leaderboard (US-864). Takes the
// opted-in users (alias only — no PII) and a map of referrer-id → granted
// referral count, and returns the board: rows with at least one rewarded
// referral, ranked by count desc, capped. Unit-tested.
export function rankReferrers(
  users: Array<{ id: string; display_name: string }>,
  grantedCounts: Map<string, number>,
  limit = 100,
): ReferrerLeaderboardRow[] {
  return users
    .map((u) => {
      const referrals = grantedCounts.get(u.id) ?? 0;
      return {
        display_name: u.display_name,
        referrals,
        credits_earned: referrals * REFERRER_REWARD_CREDITS,
      };
    })
    .filter((r) => r.referrals > 0)
    .sort((a, b) => b.referrals - a.referrals)
    .slice(0, limit);
}
