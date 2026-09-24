// The Analytics date-range presets, in one place.
//
// presetStart builds the date from LOCAL calendar fields (A9). It used
// toISOString(), which is UTC, so a seller in UTC-5 opening "last 30 days" at
// 8pm got a window that started a day late.

export type Preset = "all" | "30d" | "90d" | "12mo";

export const PRESET_DAYS: Record<Exclude<Preset, "all">, number> = {
  "30d": 30,
  "90d": 90,
  "12mo": 365,
};

/** The window each preset covers, in words, for titles and copy. */
export const RANGE_LABEL: Record<Preset, string> = {
  all: "all time",
  "30d": "last 30 days",
  "90d": "last 90 days",
  "12mo": "last 12 months",
};

export function isPreset(v: string | null | undefined): v is Preset {
  return v === "all" || v === "30d" || v === "90d" || v === "12mo";
}

/** A local yyyy-mm-dd for a Date. */
export function localIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Lower bound (yyyy-mm-dd) for a preset, or null for all time. The RPCs do the
 * date filtering; this only turns the preset into the start they expect.
 */
export function presetStart(p: Preset, now: Date = new Date()): string | null {
  if (p === "all") return null;
  const from = new Date(now);
  from.setDate(from.getDate() - PRESET_DAYS[p]);
  return localIsoDate(from);
}
