// US-1851: named level TIERS and the cosmetic perks they unlock.
//
// US-1849 shipped the number — `levelForXp` turns XP into an integer. A number
// is not an identity, so this module gives the ladder names a seller can say out
// loud ("I'm a Curator") and hangs the only rewards on it that cost nothing:
// profile flair and share-card frames.
//
// Two rules the rest of the codebase depends on:
//
//  1. **Level never decreases.** XP comes from an append-only log, so it is
//     already monotone in the normal case — but a voided event, a `verified`
//     flip, or a catalog re-weighting could all pull a recomputed total DOWN,
//     and a status that can be taken away is not status. `monotonicLevel` is
//     the floor, applied where the cache is written (rewards-engine.ts).
//  2. **No perk here is ever plan-gated.** Every unlock is a function of level
//     and nothing else. Levels are earned by contributing; selling them would
//     make the ladder a price list, and the pinned test in
//     rewards-levels_test.ts fails if a plan/entitlement ever appears here.
//
// Pure — no DB, no env, no clock.

import { levelForXp, monotonicLevel, xpForLevel } from "./rewards-engine.ts";

// The floor itself lives beside the level curve in rewards-engine.ts (importing
// the other way would close a module cycle); it is re-exported here because this
// is where a reader looks for the ladder's rules.
export { monotonicLevel };

export type LevelTierKey = "thrifter" | "picker" | "curator" | "archivist" | "legend";

/** A share-card frame key. Rendered by cert-og-template.ts's slab builder. */
export type LevelFrameKey = "copper" | "slate" | "gold" | "crimson";

export interface LevelTier {
  key: LevelTierKey;
  name: string;
  /** First level in the band. */
  minLevel: number;
  /** Flair shown beside the seller's name on their public profile. */
  flair: string;
  /** One-line "what this says about you", for the progress surface. */
  blurb: string;
  /** The frame this tier unlocks, or null for the plain card. */
  frame: LevelFrameKey | null;
}

/**
 * The ladder. Bands are placed against the quadratic curve (level N = N²×100 XP)
 * so each promotion lands near a TANGIBLE milestone from rewards-tangible.ts —
 * 900 / 3 600 / 10 000 / 25 600 XP — and the cosmetic and the concrete arrive
 * together rather than on two unrelated clocks.
 *
 * Ordered ascending by minLevel; `tierForLevel` relies on that.
 */
export const LEVEL_TIERS: readonly LevelTier[] = [
  {
    key: "thrifter",
    name: "Thrifter",
    minLevel: 0,
    flair: "Thrifter",
    blurb: "Getting started — every grade you post builds the record.",
    frame: null,
  },
  {
    key: "picker",
    name: "Picker",
    minLevel: 3, // 900 XP
    flair: "Picker",
    blurb: "You grade consistently and your listings show it.",
    frame: "copper",
  },
  {
    key: "curator",
    name: "Curator",
    minLevel: 6, // 3,600 XP
    flair: "Curator",
    blurb: "Your grades travel — buyers find you through them.",
    frame: "slate",
  },
  {
    key: "archivist",
    name: "Archivist",
    minLevel: 10, // 10,000 XP
    flair: "Archivist",
    blurb: "A deep, verified catalogue. You are part of the reference set.",
    frame: "gold",
  },
  {
    key: "legend",
    name: "Legend",
    minLevel: 16, // 25,600 XP
    flair: "Legend",
    blurb: "Top of the ladder. Nothing above this to buy or grind.",
    frame: "crimson",
  },
] as const;

/**
 * How each frame paints. The ink is chosen for contrast against its own edge —
 * never a muted gray on a coloured fill, which is the tell the house style
 * refuses. Kept beside the tiers, and the LABEL is the tier's own name, so the
 * renderer (cert-og-template.ts) stays a dumb painter and there is no second
 * copy of the ladder's vocabulary to drift.
 */
export const FRAME_STYLES: Record<LevelFrameKey, { edge: string; ink: string }> = {
  copper: { edge: "#A97142", ink: "#FFFFFF" },
  slate: { edge: "#A8AEB8", ink: "#12151A" },
  gold: { edge: "#C9A227", ink: "#12151A" },
  crimson: { edge: "#F03D5F", ink: "#FFFFFF" },
};

export interface FrameStyle {
  key: LevelFrameKey;
  label: string;
  edge: string;
  ink: string;
}

/** The frame a level's share cards wear, or null below the first unlock. */
export function frameStyleForLevel(level: number): FrameStyle | null {
  const key = perksForLevel(level).activeFrame;
  if (!key) return null;
  const tier = LEVEL_TIERS.find((t) => t.frame === key);
  return { key, label: tier?.name ?? key, ...FRAME_STYLES[key] };
}

/** The tier a level sits in. Never null — level 0 is a Thrifter. */
export function tierForLevel(level: number): LevelTier {
  const lvl = Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
  let current = LEVEL_TIERS[0]!;
  for (const t of LEVEL_TIERS) {
    if (lvl >= t.minLevel) current = t;
    else break;
  }
  return current;
}

/** The next tier up, or null at the top of the ladder. */
export function nextTierAfter(level: number): LevelTier | null {
  const lvl = Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
  return LEVEL_TIERS.find((t) => t.minLevel > lvl) ?? null;
}

export interface LevelProgress {
  xpTotal: number;
  level: number;
  tier: LevelTier;
  nextTier: LevelTier | null;
  /** XP earned since the current level's floor. */
  xpIntoLevel: number;
  /** XP the current level's band is wide. */
  xpForNextLevel: number;
  /** XP still needed for the next level (0 only if the curve had no next). */
  xpToNextLevel: number;
  /** 0–100, whole numbers — how far through the current level. */
  pctToNextLevel: number;
  /** XP still needed to reach the next TIER, or null at the top. */
  xpToNextTier: number | null;
}

/**
 * Everything a progress bar needs, from one number. `level` may be passed in
 * when a stored (already floored) level is authoritative — otherwise it is
 * derived from XP.
 */
export function levelProgress(xpTotal: number, storedLevel?: number | null): LevelProgress {
  const xp = Number.isFinite(xpTotal) ? Math.max(0, Math.floor(xpTotal)) : 0;
  const level = monotonicLevel(storedLevel, levelForXp(xp));
  const floor = xpForLevel(level);
  const ceil = xpForLevel(level + 1);
  const band = Math.max(1, ceil - floor);
  // A floored level can outrun its XP (rule 1) — clamp so the bar never reads
  // negative or over-full after a downward recompute.
  const into = Math.min(band, Math.max(0, xp - floor));
  const nextTier = nextTierAfter(level);
  return {
    xpTotal: xp,
    level,
    tier: tierForLevel(level),
    nextTier,
    xpIntoLevel: into,
    xpForNextLevel: band,
    xpToNextLevel: band - into,
    pctToNextLevel: Math.round((into / band) * 100),
    xpToNextTier: nextTier ? Math.max(0, xpForLevel(nextTier.minLevel) - xp) : null,
  };
}

export interface LevelPerks {
  /** Profile flair for the current tier. */
  flair: string;
  /** Every frame unlocked at or below this level — earned frames stay earned. */
  frames: LevelFrameKey[];
  /** The frame applied by default to this seller's share cards. */
  activeFrame: LevelFrameKey | null;
}

/** The cosmetics a level has unlocked. Level in, cosmetics out — nothing else. */
export function perksForLevel(level: number): LevelPerks {
  const lvl = Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
  const frames = LEVEL_TIERS.filter((t) => lvl >= t.minLevel)
    .map((t) => t.frame)
    .filter((f): f is LevelFrameKey => f !== null);
  return {
    flair: tierForLevel(lvl).flair,
    frames,
    activeFrame: frames.length > 0 ? frames[frames.length - 1]! : null,
  };
}

/** Is `frame` unlocked at `level`? The gate a render path asks before applying one. */
export function isFrameUnlocked(frame: string, level: number): boolean {
  return perksForLevel(level).frames.includes(frame as LevelFrameKey);
}
