// US-2557: the unread count that rides on a push, so the app icon can show it.
//
// THE GAP THIS CLOSES, and why it is the server's half rather than Swift's.
// `PushPayload.badge` has existed in apns.ts since pushes shipped, and
// buildBody() copies it into the `aps` dictionary — but NO caller has ever set
// it. So the number is absent from every push GradeThread has sent, and an iOS
// build that adds a tab badge still shows nothing on the home screen, because
// the only thing that can badge a CLOSED app is the payload. AC4 asks for the
// badge to be visible with the app closed; this is the part of that no amount of
// Swift can supply.
//
// The count is the same fact the web centre shows
// (src/components/dashboard/notification-center.tsx), read from the same table.

import { supabaseAdmin } from "./supabase.ts";

/**
 * How many unread notifications a user has, or null when the number could not be
 * determined.
 *
 * NULL RATHER THAN 0 ON FAILURE, and the distinction is the whole point — see
 * `withUnreadBadge` below for what 0 does.
 */
export async function unreadNotificationCount(
  userId: string,
): Promise<number | null> {
  if (!userId) return null;
  try {
    // head + exact count: PostgREST returns the number in Content-Range and no
    // rows, so this stays O(1) in transferred bytes no matter how many the user
    // has. Reading rows and calling .length would also have been WRONG — the web
    // centre does exactly that over a .limit(20) page, which is why its own
    // badge stops counting at 20.
    const { count, error } = await supabaseAdmin
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("is_read", false);
    if (error) {
      console.error(`[notification-badge] count failed for ${userId}: ${error.message}`);
      return null;
    }
    return typeof count === "number" ? count : null;
  } catch (err) {
    console.error(
      `[notification-badge] count threw for ${userId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Attach an unread badge to a push payload, unless doing so would be worse than
 * leaving it off.
 *
 * ⚠ A BADGE OF 0 IS NOT "NO BADGE" — IT IS AN INSTRUCTION TO CLEAR ONE. APNs
 * treats an ABSENT badge key as "leave the icon exactly as it is" and a badge of
 * `0` as "remove the number". Those are opposite behaviours and the difference
 * is one missing key.
 *
 * So this omits the badge in both cases where it cannot be sure:
 *
 *   • the count could not be read (null) — sending 0 there would mean a database
 *     hiccup silently wipes a badge showing five unread items, which is a worse
 *     outcome than the push simply not updating the number;
 *   • the count is genuinely 0 — which happens on the pushes that have no
 *     notification row behind them at all (pushTokenExpiring, pushSaleCreated).
 *     Those must not clear a badge they know nothing about.
 *
 * The consequence, stated so nobody reads it as a bug: **the server only ever
 * raises the badge.** Clearing it is the app's job, on the same signal that
 * marks the rows read (AC3). A user who reads everything on the web keeps a
 * stale number on the icon until they next open the app — which is the behaviour
 * the badge API is designed around, and the alternative is a push that fires on
 * every web read.
 */
export async function withUnreadBadge<T extends { badge?: number }>(
  userId: string,
  payload: T,
): Promise<T> {
  // An explicit badge on the payload wins. Nothing sets one today; this exists
  // so a future caller with a better number does not have to fight this helper.
  if (typeof payload.badge === "number") return payload;
  const count = await unreadNotificationCount(userId);
  if (count === null || count <= 0) return payload;
  return { ...payload, badge: count };
}
