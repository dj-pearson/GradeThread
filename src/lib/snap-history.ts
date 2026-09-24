import type { SnapResult } from "@/hooks/use-snap";

// US-2554: Snap results survive a reload.
//
// Every snap was thrown away the moment the page unmounted, with no list and no
// way back to one, so a seller working a rail did the same photo twice and had
// nothing to compare. Submissions persist; snaps did not.
//
// This keeps them on the DEVICE, and that is a deliberate choice rather than a
// shortcut:
//
//  - The snap endpoint stores nothing by design. The photo is validated,
//    stripped of EXIF and passed to the model, never written (US-276), and only
//    the usage COUNT is reserved. Adding a server table would put a row per free
//    snap, for every visitor, behind the funnel's most generous free feature.
//  - Snapping happens standing in a shop, on one phone. That is also where the
//    history is wanted.
//  - The result is small and derived (a grade estimate and a value range), so
//    losing it to a cleared cache costs a re-snap, not a record.
//
// The PHOTO is not kept even here: a thumbnail per snap would push a data URI
// into a 5MB storage quota and evict the history it belongs to. What is stored
// is what the seller needs to recognize the entry.
//
// SNAP-01: the history is SCOPED to the signed-in user. The v1 key had no user
// in it, so on a shared browser the next person to sign in saw the last
// person's brands, grades and dollar values. The key now carries the user id,
// nothing is read or written without one, and sign-out wipes every snap key
// (clearAllSnapHistory, called from use-auth's SIGNED_OUT branch).
//
// SNAP-06: every write works on the CALLER's list and reports whether it
// persisted. Re-reading storage inside a write meant that with storage blocked a
// delete returned [] and wiped the visible list, and an append never grew past
// one entry.

const PREFIX = "gt.snap-history.";
/** The pre-SNAP-01 unscoped key. Removed on sight, never migrated: it cannot
 *  be tied to a user. */
export const LEGACY_SNAP_HISTORY_KEY = "gt.snap-history.v1";
/** Newest first, and bounded: this shares a small per-origin storage quota. */
const MAX_ENTRIES = 20;
/** How many survive when the full list does not fit. */
const QUOTA_FALLBACK = 5;

/** Rehydrated on read rather than stored twenty times over. */
export const SNAP_DISCLAIMER =
  "This is an AI condition + value ESTIMATE from one photo, not a certified GradeThread grade or a guaranteed sale price. Get a full certified grade to list with confidence.";

export function snapHistoryKey(userId: string): string {
  return `${PREFIX}v2:${userId}`;
}

export interface SnapHistoryEntry {
  id: string;
  /** ISO timestamp of when the snap was taken. */
  at: string;
  brand: string | null;
  keyword: string | null;
  grade: number;
  gradeTier: string;
  /** Median comp value in cents, when the snap resolved one. */
  valueCents: number | null;
  /** The result, trimmed to what the card renders, so revisiting one shows
   *  what it showed. */
  result: SnapResult;
}

export interface SnapHistoryWrite {
  entries: SnapHistoryEntry[];
  /** False when storage refused the write. The page still shows `entries`. */
  persisted: boolean;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNullableCents(v: unknown): boolean {
  return v === null || v === undefined || isFiniteNumber(v);
}

/** Deep enough that anything the card dereferences is really there: this is
 *  user-writable storage, and `{result:{}}` used to crash the route at
 *  `overall_score.toFixed`. */
function isValidEntry(e: unknown): e is SnapHistoryEntry {
  if (!e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  if (typeof x.id !== "string") return false;
  if (typeof x.at !== "string" || Number.isNaN(Date.parse(x.at))) return false;
  if (!isFiniteNumber(x.grade)) return false;
  if (typeof x.gradeTier !== "string") return false;
  if (!isNullableCents(x.valueCents)) return false;
  const r = x.result as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== "object") return false;
  const g = r.grade as Record<string, unknown> | null | undefined;
  if (!g || typeof g !== "object") return false;
  if (!isFiniteNumber(g.overall_score) || !isFiniteNumber(g.confidence)) return false;
  if (typeof g.grade_tier !== "string") return false;
  const v = r.value as Record<string, unknown> | null | undefined;
  if (v != null) {
    if (typeof v !== "object") return false;
    if (!isNullableCents(v.lowCents) || !isNullableCents(v.medianCents) || !isNullableCents(v.highCents)) {
      return false;
    }
  }
  return true;
}

function rehydrate(e: SnapHistoryEntry): SnapHistoryEntry {
  const r = e.result;
  const factor = r.grade.factor_scores;
  return {
    ...e,
    valueCents: e.valueCents ?? null,
    result: {
      ...r,
      grade: {
        ...r.grade,
        factor_scores: factor && typeof factor === "object" ? factor : {},
      },
      value: r.value ?? null,
      garment: r.garment ?? null,
      estimate: true,
      disclaimer: SNAP_DISCLAIMER,
    },
  };
}

/** What is written: the fields the card renders, no disclaimer, no extras. */
function trimResult(result: SnapResult): SnapResult {
  const v = result.value;
  const g = result.grade;
  return {
    grade: {
      overall_score: g.overall_score,
      grade_tier: g.grade_tier,
      confidence: g.confidence,
      factor_scores: g.factor_scores ?? {},
      ...(g.needs_review != null ? { needs_review: g.needs_review } : {}),
      ...(g.screenshot_detected != null ? { screenshot_detected: g.screenshot_detected } : {}),
    },
    value: v
      ? {
          lowCents: v.lowCents,
          medianCents: v.medianCents,
          highCents: v.highCents,
          sampleSize: v.sampleSize,
          confidence: v.confidence,
          sufficient: v.sufficient,
          currency: v.currency,
          ...(v.category_name ? { category_name: v.category_name } : {}),
        }
      : null,
    garment: result.garment ?? null,
    estimate: true,
    disclaimer: "",
  };
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function dropLegacy(ls: Storage): void {
  try {
    ls.removeItem(LEGACY_SNAP_HISTORY_KEY);
  } catch {
    /* nothing to do */
  }
}

export function readSnapHistory(userId: string | null | undefined): SnapHistoryEntry[] {
  const ls = storage();
  if (!ls) return [];
  dropLegacy(ls);
  if (!userId) return [];
  try {
    const raw = ls.getItem(snapHistoryKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Anything without the fields the page renders is dropped rather than
    // rendered as a blank row or a crash.
    return parsed.filter(isValidEntry).map(rehydrate);
  } catch {
    // Private mode, quota, or a corrupt value: history is a convenience, never
    // a reason the page fails to render.
    return [];
  }
}

/** Persist `entries` as-is, best effort. Also the Undo path for Clear/delete. */
export function writeSnapHistory(
  userId: string | null | undefined,
  entries: SnapHistoryEntry[],
): SnapHistoryWrite {
  const ls = storage();
  if (!ls || !userId) return { entries, persisted: false };
  const serial = entries.map((e) => ({ ...e, result: trimResult(e.result) }));
  try {
    if (serial.length === 0) ls.removeItem(snapHistoryKey(userId));
    else ls.setItem(snapHistoryKey(userId), JSON.stringify(serial));
    return { entries, persisted: true };
  } catch {
    // Over quota: keep the newest few rather than dropping the write entirely,
    // and return exactly what was stored so the page matches the device.
    try {
      ls.setItem(snapHistoryKey(userId), JSON.stringify(serial.slice(0, QUOTA_FALLBACK)));
      return { entries: entries.slice(0, QUOTA_FALLBACK), persisted: true };
    } catch {
      return { entries, persisted: false };
    }
  }
}

export function appendSnapHistory(
  userId: string | null | undefined,
  current: SnapHistoryEntry[],
  result: SnapResult,
  opts: { brand?: string; keyword?: string; now?: Date; id?: string } = {},
): SnapHistoryWrite {
  const entry: SnapHistoryEntry = rehydrate({
    id:
      opts.id ??
      // crypto.randomUUID is unavailable on http:// origins in some browsers.
      (globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    at: (opts.now ?? new Date()).toISOString(),
    brand: opts.brand?.trim() || null,
    keyword: opts.keyword?.trim() || null,
    grade: result.grade.overall_score,
    gradeTier: result.grade.grade_tier,
    valueCents: result.value?.medianCents ?? null,
    result: trimResult(result),
  });
  const next = [entry, ...current.filter((e) => e.id !== entry.id)].slice(0, MAX_ENTRIES);
  return writeSnapHistory(userId, next);
}

export function removeSnapHistoryEntry(
  userId: string | null | undefined,
  current: SnapHistoryEntry[],
  id: string,
): SnapHistoryWrite {
  return writeSnapHistory(userId, current.filter((e) => e.id !== id));
}

export function clearSnapHistory(userId: string | null | undefined): SnapHistoryWrite {
  return writeSnapHistory(userId, []);
}

/** SNAP-01: sign-out wipes every user's snap history on this browser, plus the
 *  legacy unscoped key. */
export function clearAllSnapHistory(): void {
  const ls = storage();
  if (!ls) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(PREFIX)) doomed.push(k);
    }
    for (const k of doomed) ls.removeItem(k);
  } catch {
    /* storage unavailable: nothing was stored either */
  }
  dropLegacy(ls);
}
