// US-2853: quiet hours — the window in which this account receives no push.
//
// Gates PUSH ONLY. The in-app notification row is still inserted and email still
// sends, so a muted push loses nothing: the notification is in the bell when the
// window closes. See migration 00669 for why muting rather than deferring.
//
// Everything here is pure except `quietHoursActiveForUser`, which is the one
// function that reads the DB. Keeping the arithmetic separable is the point —
// midnight-wrapping windows and timezone conversion are exactly the two things
// that are wrong in production and untestable through a push transport.

import { supabaseAdmin } from "./supabase.ts";

export interface QuietHours {
  enabled: boolean;
  /** Whole hour, 0-23, in `tz`. */
  startHour: number;
  /** Whole hour, 0-23, in `tz`. Less than startHour means the window wraps midnight. */
  endHour: number;
  /** IANA zone, e.g. "America/Chicago". */
  tz: string;
}

const DEFAULT_TZ = "UTC";

function wholeHour(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const h = Math.floor(n);
  return h >= 0 && h <= 23 ? h : null;
}

/**
 * Read the stored jsonb into a QuietHours, or null when it is absent or
 * unusable. A malformed blob reads as "no quiet hours" rather than throwing —
 * this sits on a fire-and-forget push path, and refusing to send because a
 * preference row is odd is worse than sending.
 */
export function parseQuietHours(raw: unknown): QuietHours | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const startHour = wholeHour(o.start_hour);
  const endHour = wholeHour(o.end_hour);
  if (startHour === null || endHour === null) return null;
  const tz = typeof o.tz === "string" && o.tz.trim() !== "" ? o.tz.trim() : DEFAULT_TZ;
  return {
    // Absent `enabled` reads as ON: a row that carries a window and no flag was
    // written by a client that did not know about the flag, and the window is
    // the thing the user actually expressed.
    enabled: o.enabled !== false,
    startHour,
    endHour,
    tz,
  };
}

/**
 * The hour (0-23) it currently is for `tz`. Falls back to UTC when the zone is
 * not one this runtime knows — an unrecognized zone must not throw on a push path.
 */
export function hourInZone(now: Date, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    });
    const h = Number(fmt.format(now));
    return Number.isFinite(h) ? h % 24 : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

/**
 * Is `now` inside the quiet window?
 *
 * The window is half-open on the hour: [startHour, endHour). 22 to 7 means
 * 22:00 through 06:59 — a push at 07:00 goes through, which is what "quiet until
 * 7" means to a person. startHour === endHour is treated as NO window rather
 * than a 24-hour mute: an all-day mute is what turning push off is for, and
 * reading a slider that both ends landed on as "silence everything forever" is
 * the kind of setting people discover a week later.
 */
export function quietHoursActive(qh: QuietHours | null, now: Date): boolean {
  if (!qh || !qh.enabled) return false;
  if (qh.startHour === qh.endHour) return false;
  const h = hourInZone(now, qh.tz);
  return qh.startHour < qh.endHour
    ? h >= qh.startHour && h < qh.endHour
    : h >= qh.startHour || h < qh.endHour; // wraps midnight
}

/**
 * Should a push to `userId` be muted right now? Best-effort: any read failure
 * answers false (send it), because a missing preference must never turn into
 * silence the user did not ask for.
 */
export async function quietHoursActiveForUser(
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    if (!userId) return false;
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("notification_quiet_hours")
      .eq("id", userId)
      .maybeSingle();
    if (error) return false;
    const raw = (data as { notification_quiet_hours?: unknown } | null)
      ?.notification_quiet_hours;
    return quietHoursActive(parseQuietHours(raw), now);
  } catch {
    return false;
  }
}
