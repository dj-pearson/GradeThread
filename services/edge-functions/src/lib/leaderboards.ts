// US-1856: the public REWARD LEADERBOARDS — pure policy.
//
// Four boards, two windows each: XP, grades, best finds and share-driven
// signups, ranked over the current week or over all time, and (where the
// underlying rows carry one) filtered to a brand or garment category.
//
// Everything here is a total function of its inputs — no DB, no env, no fetch —
// so the parts that decide who is listed, what number is shown, and how a tie
// breaks are unit-testable without a database. The IMPURE half (the cohort
// query and the four aggregations) lives in leaderboards-data.ts.
//
// ── Why XP is published here but not on a verified profile ──────────────────
// `publicLevelFlair` (rewards-levels.ts) deliberately drops XP from the public
// profile projection: how much someone grades is a business metric, and a
// profile is not consent to publish it. A leaderboard is different in exactly
// one way that matters — the seller ticked a box whose copy says their alias,
// rank and score go on a public page. Consent is what makes the disclosure
// legitimate, so this file publishes the score and 00547's toggle is a separate
// opt-in rather than a reuse of an older one. Do not fold these boards back
// under the referral or buyer toggle; their copy does not cover these numbers.

/**
 * URL-safe brand key. Re-exported rather than re-implemented: a leaderboard
 * brand facet links straight into `/finds/b/<slug>`, and the `brand_slug`
 * expression in migration 00546 is what that page filters on. A second slug rule
 * here would render links into an empty feed.
 */
import { brandSlug } from "./showcase.ts";
export { brandSlug };

/** The four boards. */
export type LeaderboardMetricKey = "xp" | "grades" | "finds" | "shares";

/** The two windows every board is ranked over. */
export type LeaderboardPeriod = "weekly" | "all_time";

export interface LeaderboardMetric {
  key: LeaderboardMetricKey;
  name: string;
  /** One line the page shows under the board's heading. */
  description: string;
  /** Header for the score column. */
  scoreLabel: string;
  /** Header for the secondary column, or null when the board has none. */
  secondaryLabel: string | null;
  /**
   * Whether a brand / garment-category filter means anything for this board.
   * Only the boards whose underlying rows ARE garments can be faceted — an XP
   * total has no brand, and a referral signup has no category. A facet request
   * on a non-facetable board is reported back as `facet_applied: false` rather
   * than silently returning the unfiltered board as if it had been filtered.
   */
  facetable: boolean;
  /** lucide icon name, resolved client-side (the BADGE_CATALOG convention). */
  icon: string;
}

export const LEADERBOARD_METRICS: readonly LeaderboardMetric[] = [
  {
    key: "xp",
    name: "XP",
    description:
      "Reward XP earned for the acts that make a grade trustworthy — full photo coverage, badges embedded off-platform, listings finished properly.",
    scoreLabel: "XP",
    secondaryLabel: "Level",
    facetable: false,
    icon: "Zap",
  },
  {
    key: "grades",
    name: "Grades",
    description:
      "Certificates published. Only certified, review-approved grades count, so the board tracks finished work rather than uploads.",
    scoreLabel: "Grades",
    secondaryLabel: "Avg grade",
    facetable: true,
    icon: "Award",
  },
  {
    key: "finds",
    name: "Best finds",
    description:
      "Reactions earned by the finds sellers chose to publish to the Showcase feed.",
    scoreLabel: "Reactions",
    secondaryLabel: "Finds",
    facetable: true,
    icon: "Sparkles",
  },
  {
    key: "shares",
    name: "Share-driven signups",
    description:
      "People who joined GradeThread through a seller's share or referral link and went on to qualify.",
    scoreLabel: "Signups",
    secondaryLabel: null,
    facetable: false,
    icon: "Share2",
  },
];

// A Map, not an object literal — `"toString" in {}` is TRUE, so an object-backed
// guard would accept every Object.prototype member as a valid metric key and
// then hand the route an undefined metric.
const METRIC_BY_KEY = new Map<string, LeaderboardMetric>(
  LEADERBOARD_METRICS.map((m) => [m.key, m]),
);

export function isLeaderboardMetric(value: unknown): value is LeaderboardMetricKey {
  return typeof value === "string" && METRIC_BY_KEY.has(value);
}

export function metricByKey(key: string): LeaderboardMetric | undefined {
  return METRIC_BY_KEY.get(key);
}

export const LEADERBOARD_PERIODS: readonly LeaderboardPeriod[] = ["weekly", "all_time"];

export function isLeaderboardPeriod(value: unknown): value is LeaderboardPeriod {
  return value === "weekly" || value === "all_time";
}

/** Human label for a window — used in headings, JSON-LD names and copy. */
export function periodLabel(period: LeaderboardPeriod): string {
  return period === "weekly" ? "This week" : "All time";
}

// ─── Query parsing ───────────────────────────────────────────────────────────

export interface LeaderboardQuery {
  /** null = the hub: a short board for every metric. */
  metric: LeaderboardMetricKey | null;
  period: LeaderboardPeriod;
  brandSlug: string | null;
  category: string | null;
  limit: number;
}

export const LEADERBOARD_DEFAULT_LIMIT = 25;
export const LEADERBOARD_MAX_LIMIT = 100;
/** How many rows each board carries on the hub, where four boards share a page. */
export const LEADERBOARD_HUB_LIMIT = 5;

/** Parse a raw query string into a validated, bounded board query. */
export function parseLeaderboardQuery(params: URLSearchParams): LeaderboardQuery {
  const rawMetric = params.get("metric");
  const metric = isLeaderboardMetric(rawMetric) ? rawMetric : null;

  const rawPeriod = params.get("period");
  const period: LeaderboardPeriod = isLeaderboardPeriod(rawPeriod) ? rawPeriod : "all_time";

  const brand = brandSlug(params.get("brand_slug") ?? params.get("brand"));

  // garment_category is an enum on the base table; anything not slug-shaped
  // cannot match a value, so drop it rather than sending junk to PostgREST.
  const rawCategory = (params.get("category") ?? "").trim().toLowerCase();
  const category = /^[a-z0-9_]{1,40}$/.test(rawCategory) ? rawCategory : null;

  const rawLimit = Number(params.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(LEADERBOARD_MAX_LIMIT, Math.floor(rawLimit))
    : LEADERBOARD_DEFAULT_LIMIT;

  return { metric, period, brandSlug: brand, category, limit };
}

// ─── Cohort chunking ─────────────────────────────────────────────────────────

/**
 * How many user ids go into one `.in(...)` filter on a board read. A quoted
 * UUID costs ~37 URL characters, so 200 is ~7.4k: inside the ~15.6k at which
 * prod Kong answers 414, with room for the rest of the query string.
 */
export const COHORT_IN_CHUNK = 200;

/** Split a list into consecutive slices of at most `size`. Pure. */
export function chunk<T>(arr: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr.slice(i, i + step));
  return out;
}

// ─── Public identity ─────────────────────────────────────────────────────────

export const LEADERBOARD_ALIAS_MAX = 40;

// Characters that render as nothing, reorder the text around them, or smuggle
// ASCII invisibly: every control (Cc) and format (Cf) character, which covers
// zero-width spaces and joiners, the bidi controls U+202A-E / U+2066-9, U+FEFF,
// the soft hyphen and the whole U+E0000-E007F tag block, plus lone surrogates
// (Cs). The alias is published on a public, crawlable page, so a name that looks
// like "Alice" but compares unequal to it is exactly what must not get through.
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const INVISIBLE_RE_G = /[\p{Cc}\p{Cf}\p{Cs}]/gu;

/** Bound to LEADERBOARD_ALIAS_MAX by CODE POINT, so an emoji is never halved. */
function boundAlias(s: string): string {
  const points = Array.from(s);
  return points.length > LEADERBOARD_ALIAS_MAX
    ? points.slice(0, LEADERBOARD_ALIAS_MAX).join("").trim()
    : s;
}

/**
 * Trim + bound an alias for DISPLAY. Returns null for anything empty.
 *
 * Lenient on purpose: it also runs over names chosen on other surfaces (the
 * Verified display name, the referral name), so it strips what must never be
 * shown rather than refusing. What a seller TYPES into the boards goes through
 * validateAlias first, which refuses instead.
 */
export function normalizeAlias(raw: unknown): string | null {
  const s = typeof raw === "string"
    ? raw.normalize("NFKC").replace(INVISIBLE_RE_G, "").trim().replace(/\s+/g, " ")
    : "";
  if (!s) return null;
  return boundAlias(s) || null;
}

/**
 * Words a board alias may not contain, matched case-insensitively as whole
 * words. The Verified handle reserve list (routes/verified.ts) plus the words
 * that would let a seller pass as the platform.
 */
export const RESERVED_ALIAS_WORDS: ReadonlySet<string> = new Set([
  "admin", "api", "app", "auth", "billing", "blog", "cert", "dashboard",
  "gradethread", "flipdesk", "help", "login", "logout", "og", "pricing",
  "settings", "signup", "support", "verified", "www",
  "official", "staff", "moderator",
]);

export type AliasValidation = { ok: true; alias: string | null } | { ok: false; error: string };

/**
 * Validate an alias a seller typed for the public boards.
 *
 * `null`, `undefined` and an all-space string mean "clear it". Anything else is
 * NFKC-normalized (so fullwidth and styled letters fold to plain ones), refused
 * if it carries an invisible or bidi character, bounded by code point, and
 * refused if it names the platform.
 */
export function validateAlias(raw: unknown): AliasValidation {
  if (raw === null || raw === undefined) return { ok: true, alias: null };
  if (typeof raw !== "string") return { ok: false, error: "Display name must be text." };
  const folded = raw.normalize("NFKC").replace(/[\t\n\r]+/g, " ");
  if (INVISIBLE_RE.test(folded)) {
    return { ok: false, error: "Display name has a hidden character in it. Retype it." };
  }
  const collapsed = folded.trim().replace(/\s+/g, " ");
  if (!collapsed) return { ok: true, alias: null };
  const alias = boundAlias(collapsed);

  const lower = alias.toLowerCase();
  const words = lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const squashed = words.join("");
  if (words.some((w) => RESERVED_ALIAS_WORDS.has(w)) || squashed.includes("gradethread")) {
    return { ok: false, error: "That display name is reserved. Pick another one." };
  }
  return { ok: true, alias };
}

/** The `users` columns the identity resolver reads. All optional/nullable. */
export interface LeaderboardIdentitySource {
  leaderboard_opt_in?: boolean | null;
  leaderboard_alias?: string | null;
  verified_enabled?: boolean | null;
  verified_handle?: string | null;
  verified_display_name?: string | null;
  referral_display_name?: string | null;
  rewards_display_name?: string | null;
}

export interface LeaderboardIdentity {
  /** The only identity published. Never an email, real name or user id. */
  alias: string;
  /** Set only for a PUBLICLY verified seller, so the row can link to /verified. */
  handle: string | null;
}

/**
 * Resolve what a user would be shown as, or null when they must not be listed.
 *
 * Two independent gates, and BOTH have to pass:
 *   • the 00547 opt-in — the deliberate act of joining the boards;
 *   • a resolvable alias — there is no such thing as an anonymous row here, and
 *     falling back to a user id or an email would be the exact leak the boards
 *     exist to avoid.
 *
 * The alias fallback chain reuses aliases the user has ALREADY chosen to make
 * public, newest surface first, so opting in is one click for anyone who already
 * runs a verified profile or sits on the referral board. It never invents one.
 */
export function leaderboardIdentity(
  user: LeaderboardIdentitySource,
): LeaderboardIdentity | null {
  if (user.leaderboard_opt_in !== true) return null;
  const handle = user.verified_enabled === true ? (user.verified_handle ?? null) : null;
  const alias = normalizeAlias(user.leaderboard_alias) ??
    (handle ? normalizeAlias(user.verified_display_name) ?? handle : null) ??
    normalizeAlias(user.referral_display_name) ??
    normalizeAlias(user.rewards_display_name);
  if (!alias) return null;
  return { alias, handle };
}

// ─── Ranking ─────────────────────────────────────────────────────────────────

export interface LeaderboardCandidate {
  userId: string;
  alias: string;
  handle: string | null;
  /** The published number the board ranks by. */
  score: number;
  /** The board's second column. 0 when the metric has none. */
  secondary: number;
  /** Account age (ISO), the final tie-break. Null sorts last. */
  since: string | null;
}

export interface LeaderboardEntry {
  rank: number;
  alias: string;
  handle: string | null;
  profile_url: string | null;
  score: number;
  secondary: number;
  /** True when another listed entry shares this exact rank. */
  tied: boolean;
  /** Set only for the signed-in caller's own row. */
  is_you?: boolean;
}

/**
 * Rank a board. Pure; does not mutate the input.
 *
 * ANTI-GAMING, the part that lives here (the rest is in the aggregations, which
 * only ever count events that already scored XP / grades that are already
 * certified):
 *   • A ZERO SCORE IS NOT A RANK. An opted-in account with nothing on the board
 *     is not listed at all, so registering aliases cannot pad the tail or push a
 *     real competitor off the visible page.
 *   • The board is CAPPED. `limit` bounds what is published regardless of how
 *     many accounts opted in.
 *
 * TIE-BREAKS are deterministic and, where they can be, meaningful:
 *   score desc → secondary desc → OLDER ACCOUNT FIRST → alias A→Z.
 * Account age is third rather than a coin-flip because it is the one signal a
 * competitor cannot manufacture this week; the alias sort is the final
 * deterministic backstop so two reads never disagree about the order.
 *
 * Genuine ties (same score AND same secondary) SHARE a rank — standard
 * competition ranking, so the next entry's rank skips. Two sellers who did the
 * same amount of work are not separated by their names.
 */
export function rankLeaderboard(
  candidates: LeaderboardCandidate[],
  siteUrl: string,
  limit: number,
  viewerId?: string | null,
): LeaderboardEntry[] {
  const sorted = candidates
    .filter((c) => Number.isFinite(c.score) && c.score > 0 && !!c.alias)
    .sort((a, b) =>
      b.score - a.score ||
      b.secondary - a.secondary ||
      sinceOrder(a.since) - sinceOrder(b.since) ||
      a.alias.localeCompare(b.alias)
    );

  const out: LeaderboardEntry[] = [];
  let rank = 0;
  let prevScore = Number.NaN;
  let prevSecondary = Number.NaN;
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]!;
    const sameAsPrev = c.score === prevScore && c.secondary === prevSecondary;
    if (!sameAsPrev) rank = i + 1;
    prevScore = c.score;
    prevSecondary = c.secondary;
    out.push({
      rank,
      alias: c.alias,
      handle: c.handle,
      profile_url: c.handle ? `${siteUrl}/verified/${c.handle}` : null,
      score: c.score,
      secondary: c.secondary,
      tied: false,
      ...(viewerId && c.userId === viewerId ? { is_you: true } : {}),
    });
  }
  // Second pass: a rank is "tied" only once we know somebody else holds it.
  const rankCounts = new Map<number, number>();
  for (const e of out) rankCounts.set(e.rank, (rankCounts.get(e.rank) ?? 0) + 1);
  for (const e of out) e.tied = (rankCounts.get(e.rank) ?? 0) > 1;

  return out.slice(0, Math.max(1, limit));
}

/** Sortable account age. An unknown date sorts LAST, never first. */
function sinceOrder(since: string | null): number {
  const t = since ? Date.parse(since) : Number.NaN;
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/**
 * The caller's own rank on a board, whether or not they made the visible page.
 * Computed over the FULL ranked set, so "you're 41st" stays true on a top-25
 * board. Null when they are not listed at all (opted out, or a zero score).
 */
export function viewerRank(
  candidates: LeaderboardCandidate[],
  siteUrl: string,
  viewerId: string | null | undefined,
): LeaderboardEntry | null {
  if (!viewerId) return null;
  const all = rankLeaderboard(candidates, siteUrl, candidates.length || 1, viewerId);
  return all.find((e) => e.is_you) ?? null;
}

// ─── URLs ────────────────────────────────────────────────────────────────────

export interface LeaderboardFacet {
  label: string;
  slug: string;
  count: number;
}

/**
 * The canonical path for a board. ONE builder, called by the SSR Pages Function,
 * the sitemap and the SPA, so a link can never point at a shape the renderer
 * does not match.
 *
 * The period is a QUERY parameter, not a path segment: a board page renders both
 * windows, so `/leaderboards/xp` is the indexable URL and `?period=weekly` only
 * chooses which table the SPA opens on. Splitting the windows into two paths
 * would publish two near-identical pages competing for the same query.
 */
export function leaderboardPath(
  metric?: LeaderboardMetricKey | null,
  opts: { brandSlug?: string | null; category?: string | null } = {},
): string {
  if (!metric) return "/leaderboards";
  if (opts.brandSlug) return `/leaderboards/${metric}/b/${opts.brandSlug}`;
  if (opts.category) return `/leaderboards/${metric}/c/${opts.category}`;
  return `/leaderboards/${metric}`;
}
