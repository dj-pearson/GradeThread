// US-1851: named LEVELS and the cosmetic perks they unlock.
//
// US-1849 gave XP a number (levelForXp — a quadratic curve). A number is not an
// identity. This file is the part a seller actually says out loud: "I'm a
// Curator." It maps the level curve onto five named tiers, exposes progress
// toward the next level, and declares which cosmetic perks each tier unlocks.
//
// Two rules constrain everything here, and both are acceptance criteria:
//
//   • A LEVEL NEVER DECREASES. It derives from the XP high-water mark
//     (user_reward_state.xp_peak, 00539), not from the live total. Status you
//     earned is status you keep — that is the whole point of putting identity on
//     levels rather than on a streak.
//   • PERKS ARE COSMETIC, AND THERE IS NO HARD PAYWALL. Everything unlocked here
//     is a frame, an overlay or a flair word. Nothing here gates a capability,
//     costs GradeThread money, or can be bought. The tangible half of Rewards
//     lives behind its own kill-switch and budget (rewards-tangible.ts, US-1848)
//     and is deliberately NOT reachable from this file.
//
// Wholly pure — no DB, no env — so the level policy unit-tests as data.

import { levelForXp, xpForLevel } from "./rewards-engine.ts";

// ─── Named tiers ─────────────────────────────────────────────────────────────

export type LevelTierKey = "thrifter" | "picker" | "curator" | "archivist" | "legend";

export interface LevelTier {
  key: LevelTierKey;
  name: string;
  /** The lowest level that belongs to this tier. */
  minLevel: number;
  /** One line the UI can show under the tier name. */
  blurb: string;
  /** lucide icon name, resolved client-side (same convention as BADGE_CATALOG). */
  icon: string;
}

/**
 * The tier ladder, ascending. Thresholds are spaced against the quadratic XP
 * curve (level N costs N² × 100 XP), so each tier is a real step up rather than
 * a rename every few grades:
 *
 *   Thrifter   level 0   —      0 XP   (everyone starts here)
 *   Picker     level 3   —    900 XP
 *   Curator    level 7   —  4,900 XP
 *   Archivist  level 12  — 14,400 XP
 *   Legend     level 20  — 40,000 XP
 */
export const LEVEL_TIERS: readonly LevelTier[] = [
  { key: "thrifter", name: "Thrifter", minLevel: 0, blurb: "Every closet starts somewhere.", icon: "Shirt" },
  { key: "picker", name: "Picker", minLevel: 3, blurb: "You know what's worth pulling.", icon: "Search" },
  { key: "curator", name: "Curator", minLevel: 7, blurb: "Your grades set the standard.", icon: "Gem" },
  { key: "archivist", name: "Archivist", minLevel: 12, blurb: "A record other resellers trust.", icon: "Library" },
  { key: "legend", name: "Legend", minLevel: 20, blurb: "The name on the certificate.", icon: "Crown" },
];

/** The tier a level belongs to. Never null — level 0 is Thrifter. */
export function tierForLevel(level: number): LevelTier {
  let current = LEVEL_TIERS[0];
  for (const t of LEVEL_TIERS) {
    if (level >= t.minLevel) current = t;
    else break;
  }
  return current;
}

/** The next tier up, or null at the top of the ladder. */
export function nextTierAfter(level: number): LevelTier | null {
  for (const t of LEVEL_TIERS) {
    if (t.minLevel > level) return t;
  }
  return null;
}

// ─── Progress toward the next level ──────────────────────────────────────────
//
// The monotonic floor itself (peakXp) lives in rewards-engine.ts next to the
// state it guards — this file imports the curve from there, so putting it here
// too would make the dependency circular.

export interface LevelProgress {
  /** Lifetime XP earned (the live total — may lag the peak after a log shrink). */
  xpTotal: number;
  /** The high-water XP the level is derived from. */
  xpPeak: number;
  level: number;
  tier: LevelTier;
  /** The tier above, or null at Legend. */
  nextTier: LevelTier | null;
  /** XP accumulated inside the current level's band. */
  xpIntoLevel: number;
  /** Width of the current level's band (xpForLevel(level+1) − xpForLevel(level)). */
  xpLevelSpan: number;
  /** XP still needed to reach the next level. */
  xpToNextLevel: number;
  /** 0–100, progress across the current level's band. */
  percentToNextLevel: number;
  /** XP still needed to reach the next TIER, or null at Legend. */
  xpToNextTier: number | null;
}

/**
 * Progress for a given XP peak. `level` is `levelForXp(xpPeak)` — the same curve
 * US-1849 established, read off the high-water mark so it is monotonic.
 */
export function levelProgress(xpPeak: number, xpTotal?: number): LevelProgress {
  const peak = Number.isFinite(xpPeak) ? Math.max(0, xpPeak) : 0;
  const total = xpTotal === undefined ? peak : Math.max(0, xpTotal);
  const level = levelForXp(peak);
  const floor = xpForLevel(level);
  const ceil = xpForLevel(level + 1);
  const span = Math.max(1, ceil - floor);
  const into = Math.max(0, peak - floor);
  const next = nextTierAfter(level);
  return {
    xpTotal: total,
    xpPeak: peak,
    level,
    tier: tierForLevel(level),
    nextTier: next,
    xpIntoLevel: into,
    xpLevelSpan: span,
    xpToNextLevel: Math.max(0, ceil - peak),
    percentToNextLevel: Math.min(100, Math.round((into / span) * 100)),
    xpToNextTier: next ? Math.max(0, xpForLevel(next.minLevel) - peak) : null,
  };
}

// ─── Cosmetic perks ──────────────────────────────────────────────────────────

export type PerkKind = "flair" | "frame";

export interface CosmeticPerk {
  key: string;
  kind: PerkKind;
  name: string;
  description: string;
  /** The tier that unlocks it. */
  tier: LevelTierKey;
  /** Convenience mirror of the tier's minLevel — the level that unlocks it. */
  minLevel: number;
}

/**
 * The cosmetic catalog. `frame` perks are extra share-card render templates
 * (cert-og-template.ts draws the overlay); `flair` perks are profile decoration
 * on the public verified profile.
 *
 * Everything here is free. There is no paid path to any of these and no plan
 * check anywhere in this file — AC4's "no hard paywall" is enforced by the
 * absence, not by a flag. If a future story wants a paid frame it needs its own
 * catalog, because folding one in here would make every existing entry's promise
 * ambiguous.
 */
export const COSMETIC_PERKS: readonly CosmeticPerk[] = [
  {
    key: "flair_thrifter",
    kind: "flair",
    name: "Thrifter flair",
    description: "Your tier name on your public profile.",
    tier: "thrifter",
    minLevel: 0,
  },
  {
    key: "frame_slate",
    kind: "frame",
    name: "Slate frame",
    description: "A clean bordered frame for shared grade cards.",
    tier: "picker",
    minLevel: 3,
  },
  {
    key: "frame_curator",
    kind: "frame",
    name: "Curator frame",
    description: "A crimson-keyline frame with your tier on the card.",
    tier: "curator",
    minLevel: 7,
  },
  {
    key: "frame_archive",
    kind: "frame",
    name: "Archive frame",
    description: "A deep archival frame with a corner tier plate.",
    tier: "archivist",
    minLevel: 12,
  },
  {
    key: "frame_legend",
    kind: "frame",
    name: "Legend frame",
    description: "The gold-keyline frame. Level 20 only.",
    tier: "legend",
    minLevel: 20,
  },
];

const PERK_BY_KEY: Record<string, CosmeticPerk> = Object.fromEntries(
  COSMETIC_PERKS.map((p) => [p.key, p]),
);

export function perkByKey(key: string): CosmeticPerk | undefined {
  return PERK_BY_KEY[key];
}

/** Every perk a level has unlocked, in catalog order. */
export function unlockedPerks(level: number): CosmeticPerk[] {
  return COSMETIC_PERKS.filter((p) => level >= p.minLevel);
}

/** Every perk still ahead — shown as "what's next", never as a paywall. */
export function lockedPerks(level: number): CosmeticPerk[] {
  return COSMETIC_PERKS.filter((p) => level < p.minLevel);
}

/**
 * Frame gate for the share-card renderer. Fail-CLOSED on an unknown key: an
 * unrecognised `?frame=` must render the plain card, never the fanciest one.
 */
export function isFrameUnlocked(frameKey: string | null | undefined, level: number): boolean {
  if (!frameKey) return false;
  const perk = PERK_BY_KEY[frameKey];
  if (!perk || perk.kind !== "frame") return false;
  return level >= perk.minLevel;
}

/** The public flair a level earns — tier name + key, safe to show to anyone. */
export interface PublicLevelFlair {
  level: number;
  tier_key: LevelTierKey;
  tier_name: string;
  tier_blurb: string;
  tier_icon: string;
}

/**
 * Project a level to the PUBLIC flair shown on a verified seller profile.
 *
 * Deliberately drops XP. A tier name is a rank; an XP total is a business
 * metric (how much a seller graded, how often they list) and belongs to them.
 * Same rule the achievement projection follows — catalog metadata leaves, the
 * private stat snapshot does not.
 */
export function publicLevelFlair(level: number): PublicLevelFlair {
  const t = tierForLevel(level);
  return {
    level,
    tier_key: t.key,
    tier_name: t.name,
    tier_blurb: t.blurb,
    tier_icon: t.icon,
  };
}
