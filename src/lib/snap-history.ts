import type { SnapResult } from "@/hooks/use-snap";

// US-2554: Snap results survive a reload.
//
// Every snap was thrown away the moment the page unmounted — no list, no way
// back to one — so a seller working a rail did the same photo twice and had
// nothing to compare. Submissions persist; snaps did not.
//
// This keeps them on the DEVICE, and that is a deliberate choice rather than a
// shortcut:
//
//  • The snap endpoint stores nothing by design. The photo is validated,
//    stripped of EXIF and passed to the model, never written (US-276), and only
//    the usage COUNT is reserved. Adding a server table would put a row per free
//    snap, for every visitor, behind the funnel's most generous free feature.
//  • Snapping happens standing in a shop, on one phone. That is also where the
//    history is wanted.
//  • The result is small and derived — a grade estimate and a value range — so
//    losing it to a cleared cache costs a re-snap, not a record.
//
// The PHOTO is not kept even here: a thumbnail per snap would push a 2400px
// data URI into a 5MB storage quota and evict the history it belongs to. What is
// stored is what the seller needs to recognise the entry.
//
// A server-side history is the right upgrade the day snaps become an account
// asset rather than an estimate; it needs a table, RLS and a retention rule,
// which is a story, not a line.

const KEY = "gt.snap-history.v1";
/** Newest first, and bounded — this shares a small per-origin storage quota. */
const MAX_ENTRIES = 20;

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
  /** The full result, so revisiting one shows exactly what it showed. */
  result: SnapResult;
}

function read(): SnapHistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Anything without the fields the list renders is dropped rather than
    // rendered as a blank row — this is user-writable storage.
    return parsed.filter(
      (e): e is SnapHistoryEntry =>
        !!e &&
        typeof e === "object" &&
        typeof (e as SnapHistoryEntry).id === "string" &&
        typeof (e as SnapHistoryEntry).at === "string" &&
        typeof (e as SnapHistoryEntry).grade === "number" &&
        !!(e as SnapHistoryEntry).result,
    );
  } catch {
    // Private mode, quota, or a corrupt value: history is a convenience, never
    // a reason the page fails to render.
    return [];
  }
}

export function readSnapHistory(): SnapHistoryEntry[] {
  if (typeof window === "undefined") return [];
  return read();
}

export function appendSnapHistory(
  result: SnapResult,
  opts: { brand?: string; keyword?: string; now?: Date; id?: string } = {},
): SnapHistoryEntry[] {
  if (typeof window === "undefined") return [];
  const entry: SnapHistoryEntry = {
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
    result,
  };
  const next = [entry, ...read()].slice(0, MAX_ENTRIES);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Over quota: keep the newest few rather than dropping the write entirely.
    try {
      localStorage.setItem(KEY, JSON.stringify(next.slice(0, 5)));
    } catch {
      /* storage unavailable — the in-memory return still updates the page */
    }
  }
  return next;
}

export function clearSnapHistory(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}

export function removeSnapHistoryEntry(id: string): SnapHistoryEntry[] {
  if (typeof window === "undefined") return [];
  const next = read().filter((e) => e.id !== id);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* see appendSnapHistory */
  }
  return next;
}
