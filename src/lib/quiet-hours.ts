// US-2853: client mirror of services/edge-functions/src/lib/quiet-hours.ts.
//
// The edge is authoritative — it is what actually mutes a push. This file exists
// so the settings card reads and writes the SAME stored shape, and so the copy
// under the toggle describes the window the server will apply rather than the
// one the UI imagines. Keep the two in lockstep; the parse rules below are
// copied deliberately, including the two that look like edge cases and are not:
//   • a stored window with no `enabled` flag is ON
//   • startHour === endHour is NO window, not a 24-hour mute

export interface QuietHours {
  enabled: boolean;
  startHour: number;
  endHour: number;
  tz: string;
}

const DEFAULT_TZ = "UTC";

function wholeHour(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const h = Math.floor(n);
  return h >= 0 && h <= 23 ? h : null;
}

export function parseQuietHours(raw: unknown): QuietHours | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const startHour = wholeHour(o.start_hour);
  const endHour = wholeHour(o.end_hour);
  if (startHour === null || endHour === null) return null;
  const tz = typeof o.tz === "string" && o.tz.trim() !== "" ? o.tz.trim() : DEFAULT_TZ;
  return { enabled: o.enabled !== false, startHour, endHour, tz };
}

function hourLabel(h: number): string {
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

/** Plain-English window, including the fact that it crosses midnight. */
export function describeQuietWindow(startHour: number, endHour: number): string {
  if (startHour === endHour) return "Off. Alerts can arrive at any time.";
  const wraps = startHour > endHour;
  return `No alerts from ${hourLabel(startHour)} to ${hourLabel(endHour)}${
    wraps ? " the next morning" : ""
  }.`;
}
