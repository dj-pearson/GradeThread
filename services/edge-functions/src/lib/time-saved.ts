// US-9207: the time-saved meter, the pure half.
//
// Every task FlipDesk does for a seller leaves a row behind: an edited photo, a
// measurement pass, a written title, an extracted specific, a graded price, a
// cross-listing, a delist, a relist. Nothing added them up. This file holds the
// minutes each task takes by hand and the summing rule; the route next to it
// counts the rows. The minutes are a CONTRACT with
// vault/50-business/time-saved-baseline.md: a test fails when the two drift.

export const TIME_SAVED_TASKS = [
  "photo_edit",
  "measurements",
  "title_description",
  "item_specifics",
  "comps",
  "cross_list",
  "delist",
  "relist",
] as const;

export type TimeSavedTask = (typeof TIME_SAVED_TASKS)[number];

/** Manual minutes per task. Mirrored in src/lib/time-saved.ts and the vault note. */
export const TIME_SAVED_MINUTES: Record<TimeSavedTask, number> = {
  photo_edit: 2,
  measurements: 4,
  title_description: 6,
  item_specifics: 5,
  comps: 8,
  cross_list: 7,
  delist: 2,
  relist: 5,
};

export type TimeSavedCounts = Partial<Record<TimeSavedTask, number>>;

export interface TimeSavedLine {
  task: TimeSavedTask;
  count: number;
  minutes: number;
}

export interface TimeSavedSummary {
  totalMinutes: number;
  lines: TimeSavedLine[];
}

/**
 * Minutes only for tasks the system actually did: a task with no event
 * contributes nothing, and never appears in the breakdown. A negative or
 * non-finite count is treated as zero rather than trusted.
 */
export function sumTimeSaved(counts: TimeSavedCounts): TimeSavedSummary {
  const lines: TimeSavedLine[] = [];
  let total = 0;
  for (const task of TIME_SAVED_TASKS) {
    const raw = counts[task];
    const count = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    if (count === 0) continue;
    const minutes = count * TIME_SAVED_MINUTES[task];
    lines.push({ task, count, minutes });
    total += minutes;
  }
  return { totalMinutes: total, lines };
}

/** The UTC month `YYYY-MM` names, as an inclusive start and exclusive end. */
export function monthRange(month: string | null | undefined, now = new Date()): { start: string; end: string; month: string } | null {
  let y: number;
  let m: number;
  if (month == null || month === "") {
    y = now.getUTCFullYear();
    m = now.getUTCMonth() + 1;
  } else {
    const match = /^(\d{4})-(\d{2})$/.exec(month);
    if (!match) return null;
    y = Number(match[1]);
    m = Number(match[2]);
    if (m < 1 || m > 12) return null;
  }
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return { start: start.toISOString(), end: end.toISOString(), month: `${y}-${String(m).padStart(2, "0")}` };
}

const MEASUREMENT_KEYS = new Set([
  "chest", "bust", "waist", "hip", "inseam", "rise", "leg_opening", "sleeve", "shoulder",
  "length", "width", "insole", "size_us", "case_diameter", "lug_width", "band_length",
]);

/**
 * Which task an ai_enrichment_log row records, from the keys it suggested.
 * The log has no task column; the routes that write it each use their own
 * key shape, and those shapes are what this reads:
 *   listing-copy / rewrite  -> listing_title, listing_description
 *   extract-aspects         -> aspect_suggestions
 *   measure (photo tape)    -> measurement keys (chest, waist, ...)
 *   extract                 -> the item fields it filled (title, brand, ...)
 *   size                    -> size, gender, confidence (a guess, not a task)
 */
export function classifyAiLog(suggestedFields: unknown): TimeSavedTask | null {
  if (!suggestedFields || typeof suggestedFields !== "object" || Array.isArray(suggestedFields)) return null;
  const keys = Object.keys(suggestedFields as Record<string, unknown>);
  if (keys.length === 0) return null;
  if (keys.includes("listing_title") || keys.includes("listing_description")) return "title_description";
  if (keys.includes("aspect_suggestions")) return "item_specifics";
  if (keys.some((k) => MEASUREMENT_KEYS.has(k))) return "measurements";
  if (keys.includes("title") || keys.includes("description")) return "title_description";
  return null;
}
