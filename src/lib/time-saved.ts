// US-9207: the time-saved meter, web mirror.
//
// The minutes per task are a CONTRACT with vault/50-business/time-saved-baseline.md
// and services/edge-functions/src/lib/time-saved.ts; src/test/time-saved-baseline.test.ts
// fails when any of the three drifts. The server does the summing; this file
// only names the tasks for the breakdown and formats the total.

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

/** Manual minutes per task. Mirrors the edge and the vault note exactly. */
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

export const TIME_SAVED_LABELS: Record<TimeSavedTask, string> = {
  photo_edit: "Photos edited",
  measurements: "Measurements read from photos",
  title_description: "Titles and descriptions written",
  item_specifics: "Item specifics filled",
  comps: "Prices set from comps",
  cross_list: "Cross-listings posted",
  delist: "Listings ended after a sale",
  relist: "Listings relisted",
};

export interface TimeSavedLine {
  task: TimeSavedTask;
  count: number;
  minutes: number;
}

export interface TimeSavedResponse {
  month: string;
  totalMinutes: number;
  lines: TimeSavedLine[];
  minutesPerTask: Record<TimeSavedTask, number>;
}

/** "6h 40m", "40m", "0m". Minutes, because the tile talks in hours and minutes. */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest}m`;
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`;
}

/** The current UTC month as YYYY-MM, the shape the route takes. */
export function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
