import type { RewardsState } from "@/hooks/use-rewards";

// US-1857: the celebration policy — pure, DOM-free and storage-injectable, so
// the whole thing is unit-testable and the React layer only has to render what
// it returns.
//
// ── Why this is tiered, and why the tiers are narrow ─────────────────────────
// GradeThread sells VERIFIED condition to people running a business. Confetti on
// every event is the fastest way to make a grading service feel like a mobile
// game, and the audience most likely to see it — a FlipDesk power user bulk-
// processing three hundred items — is exactly the audience least willing to
// forgive it. So there are two tiers and no third:
//
//   celebrate — a rare, genuinely-once moment. Level up, integrity-tier change
//               (US-1912), season completion, a first-ever event, a tangible
//               milestone grant. Animated, and carries a one-tap share card.
//   quiet     — routine XP. A plain toast, aggregated across everything that
//               happened between two reads, and rate-limited on top of that.
//
// There is no per-event XP toast anywhere in this file, and adding one would
// undo the point: XP arrives from the ledger in bursts, so a per-event toast is
// a burst of toasts.
//
// ── Why a snapshot diff rather than server-pushed events ────────────────────
// The reward engine already writes everything that matters (level, badges,
// season goals, grants) and the rewards screen already reads it. Diffing the
// read against the last one we showed the user needs no new event stream, and
// it degrades correctly: a user who was away while ten things happened comes
// back to ONE summary, not ten replayed parties.

// ─── Snapshot ───────────────────────────────────────────────────────────────

export interface RewardSnapshot {
  level: number;
  xpTotal: number;
  /** Earned badge keys. */
  badges: string[];
  seasonKey: string;
  seasonGoalsCompleted: number;
  seasonGoalsTotal: number;
  /**
   * US-1912's integrity tier. Nothing emits it yet, so it is null on both sides
   * of every diff today and the branch below cannot fire. That is the point of
   * carrying it now: when the tier ships, the celebration is already wired and
   * gated on a REAL value rather than on the absence of one.
   */
  integrityTier: string | null;
  /** Granted tangible-milestone keys. */
  milestones: string[];
  /**
   * US-1914. Two loyalty facts, both monotonic: the tenure tier RANK (-1 when
   * unknown, so a first real value reads as a promotion — the US-1912 lesson)
   * and the highest anniversary already celebrated.
   */
  tenureRank: number;
  anniversaryYear: number;
}

/** Project the rewards read into the snapshot the diff compares. */
export function snapshotFromRewards(
  state: RewardsState,
  integrityTier: string | null = null,
): RewardSnapshot {
  return {
    level: state.level.level,
    xpTotal: state.level.xp_total,
    badges: state.badges.earned.map((b) => b.key).sort(),
    seasonKey: state.season.key,
    seasonGoalsCompleted: state.season.goals_completed,
    seasonGoalsTotal: state.season.goals_total,
    integrityTier,
    milestones: state.milestones.granted.map((g) => g.milestone_key).sort(),
    tenureRank: state.loyalty?.tier?.rank ?? -1,
    anniversaryYear: state.loyalty?.last_anniversary_year ?? 0,
  };
}

// ─── Events ─────────────────────────────────────────────────────────────────

/**
 * Ladder order for the US-1912 integrity tier, mirroring INTEGRITY_TIER_RANK in
 * services/edge-functions/src/lib/buyer-grade-confirmation.ts. An unknown or
 * absent tier ranks below every real one, so a first tier reads as a promotion
 * and a tier we don't recognise never outranks one we do.
 */
const INTEGRITY_TIER_ORDER = [
  "building",
  "verified",
  "reliable",
  "trusted",
  "elite",
] as const;

function integrityRank(tier: string | null): number {
  if (!tier) return -1;
  const i = INTEGRITY_TIER_ORDER.indexOf(tier as (typeof INTEGRITY_TIER_ORDER)[number]);
  return i < 0 ? -1 : i;
}

export type CelebrationKind =
  | "level_up"
  | "integrity_tier"
  | "season_complete"
  | "badge_earned"
  | "milestone_granted"
  | "anniversary"
  | "tenure_tier"
  | "xp_gain";

export type CelebrationTier = "celebrate" | "quiet";

/** The share card a moment offers, or null when it has none. */
export interface CelebrationShare {
  kind: "badge" | "level";
  /** Badge catalog key, or the level number as a string. */
  key: string;
  title: string;
  text: string;
}

export interface CelebrationEvent {
  /** Stable across re-reads, so a refetch never re-fires the same moment. */
  id: string;
  kind: CelebrationKind;
  tier: CelebrationTier;
  title: string;
  message: string;
  share: CelebrationShare | null;
}

/** Everything the copy needs that the snapshot deliberately doesn't store. */
export interface CelebrationContext {
  /** Display name of the tier the user is now in (e.g. "Curator"). */
  tierName: string;
  badgeName(key: string): string;
  badgeTier(key: string): string;
  milestoneLabel(key: string): string;
  /** US-1914: display name of the tenure tier they now hold (e.g. "Veteran"). */
  tenureName: string;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * The moments between two snapshots, celebrate-tier first.
 *
 * A null `prev` returns NOTHING. The first read for a browser is a baseline, not
 * an achievement: without this, every user's first visit after shipping would
 * throw a level-up party for a level they reached months ago.
 */
export function detectCelebrations(
  prev: RewardSnapshot | null,
  next: RewardSnapshot,
  ctx: CelebrationContext,
): CelebrationEvent[] {
  if (!prev) return [];

  const big: CelebrationEvent[] = [];
  const quiet: CelebrationEvent[] = [];

  if (next.level > prev.level) {
    big.push({
      id: `level:${next.level}`,
      kind: "level_up",
      tier: "celebrate",
      title: `Level ${next.level}`,
      message: `You're a ${ctx.tierName} now. Levels never go down.`,
      share: {
        kind: "level",
        key: String(next.level),
        title: `GradeThread level ${next.level}`,
        text: `Just hit level ${next.level} — ${ctx.tierName} — grading condition on GradeThread.`,
      },
    });
  }

  // Integrity tier (US-1912). Only a PROMOTION celebrates. A bare
  // `next !== prev` would throw confetti at a demotion — the tier string does
  // change — and the seller is told about a drop privately, by the edge, with
  // its driver. Congratulating someone on losing standing is the one outcome
  // this branch must never produce, so it compares RANK, not equality. A null
  // new value ("not wired yet", or dropped back below the display floor) stays
  // silent on both sides.
  if (
    next.integrityTier &&
    next.integrityTier !== prev.integrityTier &&
    integrityRank(next.integrityTier) > integrityRank(prev.integrityTier)
  ) {
    big.push({
      id: `integrity:${next.integrityTier}`,
      kind: "integrity_tier",
      tier: "celebrate",
      title: `Integrity tier: ${next.integrityTier}`,
      message: "Buyers see this on every grade you publish.",
      share: null,
    });
  }

  // Season completion — the same season finishing, not a quarter rolling over.
  if (
    prev.seasonKey === next.seasonKey &&
    next.seasonGoalsTotal > 0 &&
    next.seasonGoalsCompleted >= next.seasonGoalsTotal &&
    prev.seasonGoalsCompleted < next.seasonGoalsTotal
  ) {
    big.push({
      id: `season:${next.seasonKey}`,
      kind: "season_complete",
      tier: "celebrate",
      title: "Season swept",
      message: `All ${next.seasonGoalsTotal} season ${plural(next.seasonGoalsTotal, "goal", "goals")} done.`,
      share: null,
    });
  }

  const hadBadges = new Set(prev.badges);
  const firstEverBadge = prev.badges.length === 0;
  for (const key of next.badges) {
    if (hadBadges.has(key)) continue;
    const name = ctx.badgeName(key);
    // A gold medal or somebody's FIRST medal is a real moment. The bronze rungs
    // in between are a steady drip, and a party for each one is what turns the
    // shelf into noise — those get the quiet toast and stay on the shelf.
    const isBig = firstEverBadge || ctx.badgeTier(key) === "gold";
    (isBig ? big : quiet).push({
      id: `badge:${key}`,
      kind: "badge_earned",
      tier: isBig ? "celebrate" : "quiet",
      title: firstEverBadge ? `First badge: ${name}` : name,
      message: "Added to your badge shelf.",
      share: {
        kind: "badge",
        key,
        title: `GradeThread badge: ${name}`,
        text: `Earned the ${name} badge on GradeThread.`,
      },
    });
  }

  // A tangible grant is first-ever BY CONSTRUCTION: the UNIQUE (user_id,
  // milestone_key) index means each one is granted exactly once, forever. It is
  // also budget-capped, so this can never become a drumbeat.
  const hadMilestones = new Set(prev.milestones);
  for (const key of next.milestones) {
    if (hadMilestones.has(key)) continue;
    big.push({
      id: `milestone:${key}`,
      kind: "milestone_granted",
      tier: "celebrate",
      title: "Reward unlocked",
      message: `${ctx.milestoneLabel(key)} — it's already on your account.`,
      share: null,
    });
  }

  // US-1914: an anniversary. The only celebration here that is not an
  // achievement — it fires for staying, which is why the copy thanks rather than
  // congratulates. Compared as a NUMBER that only grows, so a stale or missing
  // read can never re-fire a year already celebrated.
  if (next.anniversaryYear > prev.anniversaryYear && next.anniversaryYear > 0) {
    const years = next.anniversaryYear;
    big.push({
      id: `anniversary:${years}`,
      kind: "anniversary",
      tier: "celebrate",
      title: years === 1 ? "One year with GradeThread" : `${years} years with GradeThread`,
      message:
        "Thanks for sticking with us. Your level, badges and standing are all exactly where you left them.",
      share: null,
    });
  }

  // Tenure tier. RANK comparison, not string inequality — the same reason the
  // integrity branch above uses it: a config edit can change which tier a rank
  // names, and congratulating somebody on a sideways move (or worse, on a
  // rename) is a party for nothing. -1 ranks below every real tier, so a first
  // known value is a promotion rather than a no-op.
  if (next.tenureRank > prev.tenureRank && next.tenureRank >= 0) {
    big.push({
      id: `tenure:${next.tenureRank}`,
      kind: "tenure_tier",
      tier: "celebrate",
      title: ctx.tenureName,
      message: "Tenure standing. It only ever goes up — a quiet month costs you nothing.",
      share: null,
    });
  }

  // Routine XP. Suppressed entirely when something bigger happened in the same
  // window: "+40 XP" beside "Level 8" is the smaller of two true things.
  if (big.length === 0 && next.xpTotal > prev.xpTotal) {
    const gained = next.xpTotal - prev.xpTotal;
    quiet.push({
      id: `xp:${next.xpTotal}`,
      kind: "xp_gain",
      tier: "quiet",
      title: `+${gained.toLocaleString()} XP`,
      message: `${next.xpTotal.toLocaleString()} XP total.`,
      share: null,
    });
  }

  return [...big, ...quiet];
}

// ─── Frequency cap ──────────────────────────────────────────────────────────

export interface CelebrationLog {
  /** Epoch ms of celebrate-tier moments shown, ascending. */
  celebrations: number[];
  /** Epoch ms of the last quiet toast. */
  lastQuietAt: number;
  /** Event ids already handled, so a refetch never repeats one. */
  seen: string[];
}

export const EMPTY_CELEBRATION_LOG: CelebrationLog = {
  celebrations: [],
  lastQuietAt: 0,
  seen: [],
};

export interface CelebrationPolicy {
  /** Minimum spacing between two celebrations. */
  minGapMs: number;
  /** Rolling window the per-window cap is counted over. */
  windowMs: number;
  maxPerWindow: number;
  /** Minimum spacing between two quiet toasts. */
  quietGapMs: number;
  seenLimit: number;
}

export const CELEBRATION_POLICY: CelebrationPolicy = {
  minGapMs: 45_000,
  windowMs: 60 * 60 * 1000,
  maxPerWindow: 3,
  quietGapMs: 5 * 60 * 1000,
  seenLimit: 300,
};

/**
 * Decide which of `events` actually reach the screen.
 *
 * Suppressed events are still marked SEEN rather than deferred. A celebration
 * replayed twenty minutes after the thing it celebrates is worse than one that
 * never fired — and nothing is lost either way, because the level, the badge and
 * the grant are all sitting on the rewards page permanently. The toast was
 * always the smaller half of the reward.
 */
export function applyCelebrationLimits(
  events: readonly CelebrationEvent[],
  log: CelebrationLog,
  nowMs: number,
  policy: CelebrationPolicy = CELEBRATION_POLICY,
): { show: CelebrationEvent[]; log: CelebrationLog } {
  const seen = new Set(log.seen);
  const celebrations = log.celebrations.filter((t) => nowMs - t < policy.windowMs);
  let lastQuietAt = log.lastQuietAt;
  let quietShown = false;
  const show: CelebrationEvent[] = [];

  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);

    if (event.tier === "celebrate") {
      const last = celebrations[celebrations.length - 1] ?? -Infinity;
      if (celebrations.length >= policy.maxPerWindow) continue;
      if (nowMs - last < policy.minGapMs) continue;
      celebrations.push(nowMs);
      show.push(event);
      continue;
    }

    // At most ONE quiet toast per pass, and only outside the cooldown.
    if (quietShown || nowMs - lastQuietAt < policy.quietGapMs) continue;
    quietShown = true;
    lastQuietAt = nowMs;
    show.push(event);
  }

  // Insertion-ordered, so slicing from the end keeps the NEWEST ids. The tail
  // that falls off is old enough that its event can no longer recur.
  const seenList = Array.from(seen).slice(-policy.seenLimit);

  return { show, log: { celebrations, lastQuietAt, seen: seenList } };
}

// ─── Persistence ────────────────────────────────────────────────────────────

/** Minimal get/set storage abstraction (localStorage in the browser). */
export interface CelebrationStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const memoryStore: Record<string, string> = {};

function defaultStore(): CelebrationStore {
  return {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return memoryStore[key] ?? null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        memoryStore[key] = value;
      }
    },
  };
}

/** Per-user so a shared browser never shows one account another's moments. */
export function celebrationStateKey(userId: string): string {
  return `gt_rewards_celebrations_${userId}`;
}

export interface CelebrationState {
  snapshot: RewardSnapshot | null;
  log: CelebrationLog;
}

const EMPTY_STATE: CelebrationState = { snapshot: null, log: EMPTY_CELEBRATION_LOG };

export function readCelebrationState(
  userId: string,
  store: CelebrationStore = defaultStore(),
): CelebrationState {
  const raw = store.get(celebrationStateKey(userId));
  if (!raw) return EMPTY_STATE;
  try {
    const parsed = JSON.parse(raw) as Partial<CelebrationState>;
    return {
      snapshot: parsed.snapshot ?? null,
      log: {
        celebrations: parsed.log?.celebrations ?? [],
        lastQuietAt: parsed.log?.lastQuietAt ?? 0,
        seen: parsed.log?.seen ?? [],
      },
    };
  } catch {
    // Corrupt state re-baselines rather than throwing: the cost is one missed
    // celebration, and the alternative is a rewards screen that won't mount.
    return EMPTY_STATE;
  }
}

export function writeCelebrationState(
  userId: string,
  state: CelebrationState,
  store: CelebrationStore = defaultStore(),
): void {
  store.set(celebrationStateKey(userId), JSON.stringify(state));
}

// ─── Motion ─────────────────────────────────────────────────────────────────

/**
 * True when the OS asks for reduced motion. Celebrations then land as a plain
 * toast with the same words and the same share button — the reward is not the
 * animation, so nothing is withheld.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
