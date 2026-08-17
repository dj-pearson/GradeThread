// US-383: daily trial-expiry downgrade job.
//
// handle_new_user grants every signup a 14-day Pro trial (flipdesk_plan='pro',
// subscription_status='trialing', trial_ends_at +14d) but never creates a
// Stripe subscription. The promised daily cron that downgrades a lapsed trial
// to Free never existed — so a signup that never added a card kept Pro caps
// forever. This job flips those rows back to free/none.
//
// Defense-in-depth: effectivePlanFor()/requireFlipdesk already treat an expired
// trial as Free in real time (so caps are correct even before this runs); this
// job makes the stored state truthful and stops the user lingering as
// 'trialing' indefinitely.
//
// Mounted in main.ts as POST /api/jobs/trial-expiry, OUTSIDE /api/* JWT groups,
// gated by X-Internal-Job-Secret (same pattern as the reprice/GSC crons).

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { sendTrialExpiringEmail } from "../lib/email.ts";
import { safeSendEmail, userDisplayName } from "../lib/email-helpers.ts";

const BATCH_LIMIT = 1000;

// ── US-2120: the ADVANCE notice, before the downgrade above ─────────
//
// sendTrialExpiringEmail has existed and been well-written since US-801 — and
// has had NO CALLER outside its own test. It was decommissioned in favour of the
// US-943 drip engine, and that engine is unambiguously MARKETING: it ships via
// sendDripStepEmail with a one-click marketing unsubscribe footer, and drip.ts
// skips the send entirely when optedOut || suppressed || frequencyCapped.
//
// So a user who unsubscribed from marketing received NO trial-ending notice at
// all — the one notice that must not depend on marketing consent, because it is
// the only warning that their plan is about to change.
//
// This restores it as a TRANSACTIONAL send. `trial_expiring` is already in
// TRANSACTIONAL_CATEGORIES, so resolveIsMarketing force-classifies it
// transactional regardless of any flag: it cannot be routed onto the marketing
// identity, and the marketing opt-out/suppression/frequency-cap checks in the
// drip engine are simply not on this path.
//
// The marketing drip is deliberately LEFT ALONE (AC3) — conversion messaging is
// legitimate. What changes is that the required notice no longer depends on it.
const NOTICE_DAYS_BEFORE = 3;

/** Whole days from `now` until `endsAt`, or null if unparseable. */
export function daysUntil(endsAt: string | null | undefined, nowMs: number): number | null {
  if (!endsAt) return null;
  const t = Date.parse(endsAt);
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - nowMs) / 86_400_000);
}

/**
 * Should this trialist get the advance notice on this run?
 *
 * Pure so the window logic is testable without a DB or a clock. The cron is
 * daily, so the window is a single day rather than "<= N": sending on every day
 * inside the window would mail the same person three times.
 */
export function shouldSendTrialNotice(args: {
  daysLeft: number | null;
  alreadyNotifiedAt: string | null | undefined;
}): boolean {
  if (args.daysLeft === null) return false;
  // Already sent — once is the requirement, and a repeat reads as marketing.
  // With users.trial_notice_sent_at (00523) this is now a REAL marker rather
  // than a hardcoded null, which is what lets the window below widen.
  if (args.alreadyNotifiedAt) return false;
  // A trial already past its end gets nothing: the downgrade is the event, and
  // a "3 days left" mail about a lapsed trial is worse than silence.
  if (args.daysLeft < 0) return false;
  // US-2319 AC2: DUE OR OVERDUE, not "exactly the third day". The old
  // `=== NOTICE_DAYS_BEFORE` made the daily cron the dedupe, so a single missed
  // run meant the customer was never warned at all — and the miss was silent,
  // because a notice nobody received leaves no trace. Now a run on day 2 or day
  // 1 still catches them, late, and the marker stops the repeat that widening
  // the window would otherwise cause.
  return args.daysLeft <= NOTICE_DAYS_BEFORE;
}


export async function handleTrialExpiryCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // US-503: overlap guard. The WHERE clause is already idempotent (excludes
  // downgraded rows), but the lock keeps two runs from contending. 5-min lease.
  const lock = await acquireJobLock("trial-expiry", 300);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
  // US-2120: send the advance notice BEFORE the downgrade below, so a user is
  // warned while they can still act. Best-effort — a mail hiccup must never
  // block the downgrade, which is the correctness-critical half of this job.
  let noticesSent = 0;
  try {
    const nowMs = Date.now();
    const { data: soon } = await supabaseAdmin
      .from("users")
      .select("id, email, full_name, trial_ends_at, trial_notice_sent_at")
      .eq("subscription_status", "trialing")
      .is("flipdesk_subscription_id", null)
      .gt("trial_ends_at", new Date(nowMs).toISOString())
      .lt("trial_ends_at", new Date(nowMs + (NOTICE_DAYS_BEFORE + 1) * 86_400_000).toISOString())
      .limit(BATCH_LIMIT);

    for (const row of (soon ?? []) as Array<{
      id: string;
      email: string | null;
      full_name: string | null;
      trial_ends_at: string | null;
      trial_notice_sent_at: string | null;
    }>) {
      const daysLeft = daysUntil(row.trial_ends_at, nowMs);
      // US-2319: the stored marker (00523), not a hardcoded null. The old seam
      // was documented right here: the exact-day window was the only dedupe, so
      // a missed cron day meant the customer was never warned and a same-day
      // re-run double-sent. Both are gone — the marker dedupes, so the window
      // above can be "due or overdue".
      if (
        !shouldSendTrialNotice({
          daysLeft,
          alreadyNotifiedAt: row.trial_notice_sent_at,
        })
      ) continue;
      if (!row.email || !row.trial_ends_at) continue;

      safeSendEmail(
        sendTrialExpiringEmail(row.email, {
          userName: userDisplayName(row.email, row.full_name),
          daysLeft: daysLeft ?? NOTICE_DAYS_BEFORE,
          trialEndsAt: row.trial_ends_at,
          // US-2120: NO userId. That parameter (US-516) adds a no-login
          // marketing unsubscribe link, which is incoherent on a notice that by
          // definition cannot be unsubscribed from — offering an opt-out we do
          // not honour is worse than offering none.
        }),
        "trial_expiring",
      );
      // Stamped AFTER the send is handed off, deliberately — the same ordering
      // US-2314 settled on for the North Star digest. Stamping first means a
      // crash loses the notice PERMANENTLY (the marker says it went); stamping
      // after means a crash between the two could re-send on the next daily run.
      // A rare duplicate is recoverable and a silently missing warning is not,
      // and this notice is the last thing a customer hears before they are
      // downgraded.
      const { error: markErr } = await supabaseAdmin
        .from("users")
        .update({ trial_notice_sent_at: new Date(nowMs).toISOString() })
        .eq("id", row.id);
      if (markErr) {
        // Not fatal: the mail is already on its way, and the worst case is one
        // duplicate tomorrow. But an unrecorded send is how "why did I get this
        // twice" becomes unexplainable, so it is logged rather than swallowed.
        console.error(
          "[trial-expiry] notice sent but not marked:",
          markErr.message,
        );
      }
      noticesSent++;
    }
  } catch (err) {
    console.error("[trial-expiry] advance notice failed:", err);
  }

  const nowIso = new Date().toISOString();

  // Target: still 'trialing', trial window elapsed, and NO Stripe subscription
  // (never converted). A user who upgraded during the trial has
  // subscription_status='active' and is excluded; a paused/canceled sub is also
  // not 'trialing' so it's untouched here.
  const { data, error } = await supabaseAdmin
    .from("users")
    .update({
      flipdesk_plan: "free",
      subscription_status: "none",
      updated_at: nowIso,
    })
    .eq("subscription_status", "trialing")
    .lt("trial_ends_at", nowIso)
    .is("flipdesk_subscription_id", null)
    .select("id")
    // ⚠ THE `.order()` IS LOAD-BEARING, NOT TIDINESS. PostgREST refuses a
    // `limit` on a MUTATION unless an explicit order accompanies it:
    // PGRST109, "A 'limit' was applied without an explicit 'order'", HTTP 400.
    // Without it this UPDATE returned an error on every single run since it
    // shipped, the handler answered 500, and no expired trial was ever
    // downgraded. Proven against PostgREST 12 on the real schema: this exact
    // PATCH 400s, the same PATCH without `limit` succeeds, and the same PATCH
    // with `limit` plus `order` succeeds.
    //
    // Same family as the `.or()`-on-mutation gotcha in CLAUDE.md: a qualifier
    // that reads fine, type-checks, and is refused only by the server.
    .order("id")
    .limit(BATCH_LIMIT);

  if (error) {
    console.error("[trial-expiry] downgrade failed:", error.message);
    return c.json({ error: "Trial-expiry downgrade failed" }, 500);
  }

  const downgraded = data?.length ?? 0;
  if (downgraded > 0) {
    console.log(`[trial-expiry] downgraded ${downgraded} expired trial(s) to Free`);
  }
  return c.json({ ok: true, downgraded, notices_sent: noticesSent });
  } finally {
    await lock.release();
  }
}
