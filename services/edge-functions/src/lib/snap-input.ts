// SNAP-03 / SNAP-09: the pure parts of POST /api/grade/snap, kept out of the
// route so they can be tested without a database, a model or an eBay token.

/** Bytes the snap photo may be. The vision API refuses much above ~5 MB of
 *  base64, so a 10 MB upload (the bucket default) only failed later and was
 *  reported as a bad photo. */
export const SNAP_MAX_IMAGE_BYTES = 4_500_000;
/** Same floor the listing uploads use: below this the grade is guesswork. */
export const SNAP_MIN_IMAGE_EDGE = 500;
/** Bounds match ScoutAI's for the same two fields. */
export const SNAP_BRAND_MAX = 80;
export const SNAP_KEYWORD_MAX = 200;

// C0 and C1 control characters, DEL included. Built from code points so the
// source carries no literal control characters.
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${
    String.fromCharCode(0x9f)
  }]`,
  "g",
);

/**
 * Seller text bound for the vision prompt, an eBay query and the comp-demand
 * log: collapse control characters to spaces, trim, bound, and treat
 * whitespace-only as absent. A 200 KB "brand" used to reach all three.
 */
export function normalizeSnapText(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const cleaned = v.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/** The 429 body for a spent monthly allowance. "Free" only when it is. */
export function snapLimitBody(effPlan: string, cap: number): {
  error: string;
  code: "SNAP_LIMIT_REACHED";
  action: "upgrade";
} {
  const noun = effPlan === "free" ? "free Snap-to-Value checks" : "Snap-to-Value checks";
  const tail = effPlan === "free"
    ? "Upgrade for more, or get a full certified grade."
    : "More unlock next month, or get a full certified grade now.";
  return {
    error: `You've used all ${cap} ${noun} this month. ${tail}`,
    code: "SNAP_LIMIT_REACHED",
    action: "upgrade",
  };
}

/** Maps a validateImageUpload refusal to a status and copy a seller can act on. */
export function snapImageRejection(reason: string): { status: 400 | 413; error: string } {
  if (/^File too large/i.test(reason)) {
    return {
      status: 413,
      error: "That photo is too big to check. Use a smaller photo (under 4.5 MB).",
    };
  }
  if (/^Image too small/i.test(reason)) {
    return {
      status: 400,
      error:
        `That photo is too small to grade. Use one at least ${SNAP_MIN_IMAGE_EDGE} pixels on its longest side.`,
    };
  }
  return { status: 400, error: `Invalid image: ${reason}` };
}

export interface SnapUsage {
  used: number;
  /** null when the plan is unlimited. */
  cap: number | null;
  /** ISO timestamp of the next monthly reset (first of next month, UTC). */
  resets_at: string;
}

/**
 * SNAP-09: what the seller has used AFTER a successful reservation, from the
 * counter values read just before it. Mirrors reserve_snap (00099): a counter
 * whose reset stamp is in an earlier calendar month starts again from zero.
 */
export function snapUsageAfterReserve(input: {
  usedBefore: number | null | undefined;
  resetAt: string | null | undefined;
  cap: number;
  now?: Date;
}): SnapUsage {
  const now = input.now ?? new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const resetMs = input.resetAt ? Date.parse(input.resetAt) : NaN;
  const rolled = !Number.isFinite(resetMs) || resetMs < monthStart;
  const before = rolled ? 0 : Math.max(0, Math.trunc(input.usedBefore ?? 0));
  const cap = input.cap === -1 ? null : input.cap;
  const used = cap == null ? before + 1 : Math.min(before + 1, cap);
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { used, cap, resets_at: next.toISOString() };
}
