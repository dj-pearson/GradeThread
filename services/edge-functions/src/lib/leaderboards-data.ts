// US-1856: the reward leaderboards — the IMPURE half (cohort + aggregations).
//
// The policy (who may be listed, what is published, how a tie breaks) is pure
// and lives in leaderboards.ts. This file is the four queries that produce the
// scores, and the anti-gaming gates each of them applies at the source.
//
// THE SHAPE OF EVERY BOARD IS THE SAME, and it is what keeps the cost bounded:
// load the OPTED-IN COHORT first (a small, deliberate set), then aggregate only
// their rows. That is the referral-leaderboard pattern (content-public.ts) — a
// board never scans the platform and filters down to the cohort afterwards.
//
// ANTI-GAMING is applied per board rather than bolted on:
//   • XP reuses `xpForEvent`, so an unverified event or an unpaid grading-spend
//     act scores exactly the zero it scores everywhere else (US-1849 AC4). There
//     is one definition of "this action counted" and boards do not get a second.
//   • Grades count only CERTIFIED, review-approved reports — finished, published
//     work, not uploads. A pile of pending submissions moves nothing.
//   • Finds count reactions from OTHER people. A seller reacting to their own
//     showcased find is dropped, which is the one free point the feed's
//     one-vote-per-person rule would otherwise hand out.
//   • Share-driven signups count only GRANTED referrals — the status the
//     referral pipeline sets after the referred account qualified, which already
//     carries the fraud checks.
// Every scan is capped, and a cap that BITES is logged rather than silently
// truncating a board (US-2404's no-silent-caps rule).

import { supabaseAdmin } from "./supabase.ts";
import {
  brandSlug,
  type LeaderboardCandidate,
  type LeaderboardFacet,
  type LeaderboardMetricKey,
  leaderboardIdentity,
  type LeaderboardIdentitySource,
  type LeaderboardPeriod,
} from "./leaderboards.ts";
import { frozenXpAward, REWARD_XP_CATALOG, type RewardEventType, xpForEvent } from "./rewards-engine.ts";
import { questWindow } from "./rewards-quests.ts";

/** How many opted-in accounts one board may rank. The cohort is opt-in, so this
 *  is a safety valve rather than a working limit. */
export const COHORT_MAX = 5000;
/** Upper bound on source rows any single aggregation scans. */
export const SCAN_MAX = 50000;

function warnIfCapped(what: string, rows: number, cap: number): boolean {
  if (rows < cap) return false;
  console.warn(
    `[leaderboards] ${what} hit the ${cap}-row cap — this board is a partial view of the window.`,
  );
  return true;
}

// ─── The cohort ──────────────────────────────────────────────────────────────

export interface CohortMember {
  userId: string;
  alias: string;
  handle: string | null;
  since: string | null;
}

/**
 * Everyone who opted in (00547) AND has a resolvable public alias.
 *
 * This is the ONLY place a user row is read for the boards, and it projects
 * nothing but the alias, the public handle and the account age. No email, no
 * real name and no id ever travels further than this process.
 */
export async function loadCohort(): Promise<CohortMember[]> {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select(
      "id, leaderboard_opt_in, leaderboard_alias, verified_enabled, verified_handle, verified_display_name, referral_display_name, rewards_display_name, created_at",
    )
    .eq("leaderboard_opt_in", true)
    .limit(COHORT_MAX);
  if (error) {
    console.error("[leaderboards] cohort load failed:", error.message);
    return [];
  }
  const rows = (data ?? []) as Array<LeaderboardIdentitySource & { id: string; created_at: string | null }>;
  warnIfCapped("cohort", rows.length, COHORT_MAX);

  const out: CohortMember[] = [];
  for (const r of rows) {
    const identity = leaderboardIdentity(r);
    if (!identity) continue;
    out.push({
      userId: r.id,
      alias: identity.alias,
      handle: identity.handle,
      since: r.created_at ?? null,
    });
  }
  return out;
}

// ─── Windows ─────────────────────────────────────────────────────────────────

export interface BoardWindow {
  period: LeaderboardPeriod;
  /** Inclusive start (ms), or null for all-time. */
  startMs: number | null;
  /** Exclusive end (ms), or null for all-time. */
  endMs: number | null;
}

/**
 * The window a board is ranked over.
 *
 * The weekly window is the SAME Monday-anchored week the quests use — resolved
 * by `questWindow` in the shared season timezone rather than re-derived here, so
 * "this week" means one thing across quests, seasons and leaderboards. A second
 * calendar would put a seller's quest at 3/5 and their weekly board at 4, on the
 * same Monday morning, for no reason a human could explain.
 */
export function boardWindow(
  period: LeaderboardPeriod,
  nowMs: number,
  tz: string,
): BoardWindow {
  if (period !== "weekly") return { period: "all_time", startMs: null, endMs: null };
  const w = questWindow({ cadence: "weekly", starts_at: null, ends_at: null }, nowMs, tz);
  return w
    ? { period: "weekly", startMs: w.startMs, endMs: w.endMs }
    : { period: "all_time", startMs: null, endMs: null };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ─── Facets ──────────────────────────────────────────────────────────────────

interface FacetSeed {
  brand: string | null;
  brandSlug: string | null;
  category: string | null;
}

function buildFacets(seeds: FacetSeed[], max = 24): {
  brands: LeaderboardFacet[];
  categories: LeaderboardFacet[];
} {
  const brands = new Map<string, LeaderboardFacet>();
  const categories = new Map<string, LeaderboardFacet>();
  for (const s of seeds) {
    const bSlug = s.brandSlug ?? brandSlug(s.brand);
    if (bSlug && s.brand) {
      const hit = brands.get(bSlug);
      if (hit) hit.count += 1;
      else brands.set(bSlug, { label: s.brand, slug: bSlug, count: 1 });
    }
    if (s.category) {
      const hit = categories.get(s.category);
      if (hit) hit.count += 1;
      else {
        categories.set(s.category, {
          label: s.category.replace(/_/g, " "),
          slug: s.category,
          count: 1,
        });
      }
    }
  }
  const rank = (m: Map<string, LeaderboardFacet>) =>
    [...m.values()]
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .slice(0, max);
  return { brands: rank(brands), categories: rank(categories) };
}

// ─── The four aggregations ───────────────────────────────────────────────────

export interface BoardFilters {
  brandSlug: string | null;
  category: string | null;
}

export interface BoardData {
  candidates: LeaderboardCandidate[];
  facets: { brands: LeaderboardFacet[]; categories: LeaderboardFacet[] };
  truncated: boolean;
}

const EMPTY_BOARD: BoardData = {
  candidates: [],
  facets: { brands: [], categories: [] },
  truncated: false,
};

function seed(cohort: CohortMember[]): Map<string, LeaderboardCandidate> {
  return new Map(
    cohort.map((m) => [
      m.userId,
      {
        userId: m.userId,
        alias: m.alias,
        handle: m.handle,
        score: 0,
        secondary: 0,
        since: m.since,
      },
    ]),
  );
}

const REWARD_TYPES = new Set<string>(Object.keys(REWARD_XP_CATALOG));

/** XP board. All-time reads the monotonic peak; weekly re-scores the ledger. */
async function xpBoard(cohort: CohortMember[], window: BoardWindow): Promise<BoardData> {
  const byUser = seed(cohort);
  const ids = cohort.map((m) => m.userId);

  // The LEVEL is the second column on both windows — it is the identity number,
  // and it is derived from `xp_peak`, never from the live total (00542).
  const { data: stateRows, error: stateErr } = await supabaseAdmin
    .from("user_reward_state")
    .select("user_id, xp_peak, xp_total, level")
    .in("user_id", ids);
  if (stateErr) {
    console.error("[leaderboards] xp state load failed:", stateErr.message);
    return EMPTY_BOARD;
  }
  for (
    const r of (stateRows ?? []) as Array<{
      user_id: string;
      xp_peak: number | null;
      xp_total: number | null;
      level: number | null;
    }>
  ) {
    const c = byUser.get(r.user_id);
    if (!c) continue;
    c.secondary = r.level ?? 0;
    if (window.period === "all_time") {
      c.score = Math.max(r.xp_peak ?? 0, r.xp_total ?? 0);
    }
  }

  if (window.period === "weekly" && window.startMs != null && window.endMs != null) {
    const { data, error } = await supabaseAdmin
      .from("reputation_events")
      .select("user_id, event_type, verified, metadata")
      .in("user_id", ids)
      .gte("occurred_at", iso(window.startMs))
      .lt("occurred_at", iso(window.endMs))
      .limit(SCAN_MAX);
    if (error) {
      console.error("[leaderboards] xp event load failed:", error.message);
      return EMPTY_BOARD;
    }
    const rows = (data ?? []) as Array<{
      user_id: string;
      event_type: string;
      verified: boolean;
      metadata: Record<string, unknown> | null;
    }>;
    const truncated = warnIfCapped("xp weekly events", rows.length, SCAN_MAX);
    for (const r of rows) {
      if (!REWARD_TYPES.has(r.event_type)) continue;
      const c = byUser.get(r.user_id);
      if (!c) continue;
      // The SAME gate XP itself uses — unverified or unpaid scores nothing.
      c.score += xpForEvent(r.event_type as RewardEventType, {
        paid: r.metadata?.paid === true,
        verified: r.verified,
        xpAward: frozenXpAward(r.metadata),
      });
    }
    return { candidates: [...byUser.values()], facets: { brands: [], categories: [] }, truncated };
  }

  return { candidates: [...byUser.values()], facets: { brands: [], categories: [] }, truncated: false };
}

/** Grades board — certified, review-approved certificates only. */
async function gradesBoard(
  cohort: CohortMember[],
  window: BoardWindow,
  filters: BoardFilters,
): Promise<BoardData> {
  const byUser = seed(cohort);
  const ids = cohort.map((m) => m.userId);

  let q = supabaseAdmin
    .from("grade_reports")
    .select("overall_score, submissions!inner(user_id, brand, garment_category)")
    .in("submissions.user_id", ids)
    // A grade is only on the board once it is a real, public certificate. Same
    // visibility rule the certificate itself lives under (00356) — a board can
    // never count something a buyer could not go and read.
    .not("certificate_id", "is", null)
    .in("review_status", ["approved", "modified"])
    .limit(SCAN_MAX);
  if (window.startMs != null) q = q.gte("created_at", iso(window.startMs));
  if (window.endMs != null) q = q.lt("created_at", iso(window.endMs));
  if (filters.category) q = q.eq("submissions.garment_category", filters.category);

  const { data, error } = await q;
  if (error) {
    console.error("[leaderboards] grades load failed:", error.message);
    return EMPTY_BOARD;
  }
  const rows = (data ?? []) as unknown as Array<{
    overall_score: number;
    submissions: { user_id: string; brand: string | null; garment_category: string | null } | null;
  }>;
  const truncated = warnIfCapped("grades", rows.length, SCAN_MAX);

  const sums = new Map<string, number>();
  const seeds: FacetSeed[] = [];
  for (const r of rows) {
    const s = r.submissions;
    if (!s?.user_id) continue;
    const slug = brandSlug(s.brand);
    seeds.push({ brand: s.brand, brandSlug: slug, category: s.garment_category });
    // Brand is a free-text column, so its slug is derived rather than stored —
    // PostgREST cannot filter on the expression, so the brand facet is applied
    // here. Bounded by the cohort, which is what makes that affordable.
    if (filters.brandSlug && slug !== filters.brandSlug) continue;
    const c = byUser.get(s.user_id);
    if (!c) continue;
    c.score += 1;
    sums.set(s.user_id, (sums.get(s.user_id) ?? 0) + Number(r.overall_score));
  }
  for (const c of byUser.values()) {
    c.secondary = c.score > 0 ? Math.round(((sums.get(c.userId) ?? 0) / c.score) * 10) / 10 : 0;
  }

  return { candidates: [...byUser.values()], facets: buildFacets(seeds), truncated };
}

/** Best-finds board — reactions earned on consented, showcased finds. */
async function findsBoard(
  cohort: CohortMember[],
  window: BoardWindow,
  filters: BoardFilters,
): Promise<BoardData> {
  const byUser = seed(cohort);

  // A find only carries a seller handle when that seller runs a PUBLIC verified
  // profile (00546), so this board can only rank the verified half of the
  // cohort. That is the consent model working, not a gap: an anonymous find was
  // published without a name attached, and a board is a name.
  const byHandle = new Map<string, CohortMember>();
  for (const m of cohort) if (m.handle) byHandle.set(m.handle.toLowerCase(), m);
  if (byHandle.size === 0) return EMPTY_BOARD;

  let q = supabaseAdmin
    .from("public_showcase_finds")
    .select("grade_report_id, showcased_at, brand, brand_slug, category, seller_handle")
    .not("seller_handle", "is", null)
    .limit(SCAN_MAX);
  if (window.startMs != null) q = q.gte("showcased_at", iso(window.startMs));
  if (window.endMs != null) q = q.lt("showcased_at", iso(window.endMs));
  if (filters.brandSlug) q = q.eq("brand_slug", filters.brandSlug);
  if (filters.category) q = q.eq("category", filters.category);

  const { data, error } = await q;
  if (error) {
    console.error("[leaderboards] finds load failed:", error.message);
    return EMPTY_BOARD;
  }
  const rows = (data ?? []) as unknown as Array<{
    grade_report_id: string;
    brand: string | null;
    brand_slug: string | null;
    category: string | null;
    seller_handle: string | null;
  }>;
  const truncated = warnIfCapped("finds", rows.length, SCAN_MAX);

  const ownerByReport = new Map<string, string>();
  const seeds: FacetSeed[] = [];
  for (const r of rows) {
    seeds.push({ brand: r.brand, brandSlug: r.brand_slug, category: r.category });
    const owner = r.seller_handle ? byHandle.get(r.seller_handle.toLowerCase()) : undefined;
    if (!owner) continue;
    ownerByReport.set(r.grade_report_id, owner.userId);
    const c = byUser.get(owner.userId);
    if (c) c.secondary += 1; // the "Finds" column
  }
  if (ownerByReport.size === 0) {
    return { candidates: [], facets: buildFacets(seeds), truncated };
  }

  const reportIds = [...ownerByReport.keys()];
  const { data: reactionRows, error: reactionErr } = await supabaseAdmin
    .from("showcase_reactions")
    .select("grade_report_id, user_id")
    .in("grade_report_id", reportIds)
    .limit(SCAN_MAX);
  if (reactionErr) {
    console.error("[leaderboards] reaction load failed:", reactionErr.message);
    return { candidates: [], facets: buildFacets(seeds), truncated };
  }
  const reactions = (reactionRows ?? []) as Array<{ grade_report_id: string; user_id: string }>;
  const reactionsTruncated = warnIfCapped("finds reactions", reactions.length, SCAN_MAX);
  for (const r of reactions) {
    const ownerId = ownerByReport.get(r.grade_report_id);
    if (!ownerId) continue;
    // A seller upvoting their own find is not applause. The feed allows the
    // reaction (one per person per find) and the board refuses to pay for it.
    if (r.user_id === ownerId) continue;
    const c = byUser.get(ownerId);
    if (c) c.score += 1;
  }

  return {
    candidates: [...byUser.values()],
    facets: buildFacets(seeds),
    truncated: truncated || reactionsTruncated,
  };
}

/** Share-driven-signups board — granted referrals, the existing 00195 metric. */
async function sharesBoard(cohort: CohortMember[], window: BoardWindow): Promise<BoardData> {
  const byUser = seed(cohort);
  const ids = cohort.map((m) => m.userId);

  let q = supabaseAdmin
    .from("referral_events")
    .select("referrer_user_id")
    .in("referrer_user_id", ids)
    // GRANTED only: the pipeline sets that after the referred account actually
    // qualified, so an invite blast that nobody acted on scores nothing.
    .eq("reward_status", "granted")
    .limit(SCAN_MAX);
  // The weekly window is keyed on when the reward LANDED, not when the link was
  // clicked — that is the moment the signup became real.
  if (window.startMs != null) q = q.gte("granted_at", iso(window.startMs));
  if (window.endMs != null) q = q.lt("granted_at", iso(window.endMs));

  const { data, error } = await q;
  if (error) {
    console.error("[leaderboards] shares load failed:", error.message);
    return EMPTY_BOARD;
  }
  const rows = (data ?? []) as Array<{ referrer_user_id: string }>;
  const truncated = warnIfCapped("shares", rows.length, SCAN_MAX);
  for (const r of rows) {
    const c = byUser.get(r.referrer_user_id);
    if (c) c.score += 1;
  }
  return { candidates: [...byUser.values()], facets: { brands: [], categories: [] }, truncated };
}

/**
 * Score one board. Returns raw CANDIDATES — ranking, the zero-score drop and the
 * page cap are the caller's (pure) job, so the same numbers can serve a public
 * top-25 and a private "you're 41st" without being computed twice.
 */
export async function loadBoard(
  metric: LeaderboardMetricKey,
  cohort: CohortMember[],
  window: BoardWindow,
  filters: BoardFilters,
): Promise<BoardData> {
  if (cohort.length === 0) return EMPTY_BOARD;
  try {
    switch (metric) {
      case "xp":
        return await xpBoard(cohort, window);
      case "grades":
        return await gradesBoard(cohort, window, filters);
      case "finds":
        return await findsBoard(cohort, window, filters);
      case "shares":
        return await sharesBoard(cohort, window);
    }
  } catch (err) {
    console.error(
      `[leaderboards] board ${metric} failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return EMPTY_BOARD;
  }
}
