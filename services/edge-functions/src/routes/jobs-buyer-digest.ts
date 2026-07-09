// US-1803 (phase C): buyer notification digest cron.
//
// Daily/weekly buyers don't get immediate push/email (buyer-notify.ts defers
// them) — this cron batches their accumulated buyer notifications into ONE
// digest email. Content is read from the in-app `notifications` feed (which
// notifyBuyer always writes), so no separate content queue is needed. Idempotent
// per period via a buyer_notification_log claim (north-star 00170 pattern: a
// UNIQUE (user_id, dedupe_key) insert; 23505 = already sent this period → skip).
//
// Fires DAILY; weekly-mode buyers are processed only on the weekly run day
// (Monday, UTC). Job-secret gated + job-locked so overlapping ticks no-op.
//
// TENANT SCOPE (US-268): every read is keyed on the buyer's own user_id from
// their buyer_preferences row — never a request value.

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { redactError } from "../lib/log-redact.ts";
import { sendBuyerDigestEmail } from "../lib/email.ts";

// The in-app notification_type values the buyer digest gathers.
const BUYER_TYPES = [
  "buyer_condition_alert",
  "buyer_reward",
  "buyer_guarantee",
  "buyer_portfolio",
];

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Once-per-period idempotency key. `dayKey` for weekly = the run's Monday date. */
export function digestDedupeKey(frequency: "daily" | "weekly", dayKey: string): string {
  return `digest:${frequency}:${dayKey}`;
}

export async function handleBuyerDigestCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("buyer-digest", 600);
  if (!lock.acquired) {
    return c.json({ sent: 0, skipped: 0, locked: true, reason: lock.reason });
  }
  try {
    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);
    const isWeeklyRunDay = now.getUTCDay() === 1; // Monday (UTC)
    const frequencies = isWeeklyRunDay ? ["daily", "weekly"] : ["daily"];

    const { data: candRows, error: candErr } = await supabaseAdmin
      .from("buyer_preferences")
      .select("user_id, digest_frequency")
      .in("digest_frequency", frequencies)
      .limit(2000);
    if (candErr) {
      console.error("[buyer-digest] candidate scan failed:", candErr.message);
      return c.json({ error: "Scan failed" }, 500);
    }
    const candidates = (candRows ?? []) as Array<{ user_id: string; digest_frequency: "daily" | "weekly" }>;

    let sent = 0;
    let skipped = 0;
    let empty = 0;
    for (const cand of candidates) {
      const frequency = cand.digest_frequency;
      const since = new Date(now.getTime() - (frequency === "weekly" ? WEEK_MS : DAY_MS)).toISOString();

      // Gather this buyer's accumulated notifications for the window.
      const { data: notifRows } = await supabaseAdmin
        .from("notifications")
        .select("title, message, link, created_at")
        .eq("user_id", cand.user_id)
        .in("type", BUYER_TYPES)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(50);
      const items = (notifRows ?? []) as Array<{ title: string; message: string; link: string | null }>;
      if (items.length === 0) {
        empty += 1;
        continue;
      }

      // Claim the period FIRST (once-per-period idempotency). 23505 = already
      // sent this period → skip; only a fresh claim sends the email.
      const { error: claimErr } = await supabaseAdmin.from("buyer_notification_log").insert({
        user_id: cand.user_id,
        category: "digest",
        dedupe_key: digestDedupeKey(frequency, dayKey),
        channels: ["email"],
        sent_at: now.toISOString(),
      });
      if (claimErr) {
        if (claimErr.code === "23505") {
          skipped += 1;
          continue;
        }
        console.error(`[buyer-digest] claim failed for ${cand.user_id}:`, claimErr.message);
        continue;
      }

      // Resolve the recipient. A missing email (or notify_email opt-out) skips.
      const { data: userRow } = await supabaseAdmin
        .from("users")
        .select("email")
        .eq("id", cand.user_id)
        .maybeSingle();
      const email = (userRow as { email?: string } | null)?.email;
      if (!email) continue;

      try {
        await sendBuyerDigestEmail(email, {
          items: items.map((n) => ({ title: n.title, body: n.message, link: n.link })),
          frequency,
        });
        sent += 1;
      } catch (err) {
        console.error(`[buyer-digest] send failed for ${cand.user_id}:`, redactError(err));
      }
    }

    console.log(`[buyer-digest] done: sent=${sent} skipped=${skipped} empty=${empty} of ${candidates.length}`);
    return c.json({ sent, skipped, empty, candidates: candidates.length });
  } finally {
    await lock.release();
  }
}
