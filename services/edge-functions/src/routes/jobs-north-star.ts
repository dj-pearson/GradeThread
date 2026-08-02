// US-597: weekly North Star ("Items Listed Per Week") digest + milestone cron.
//
// Runs once a week (Monday morning) and, for every user who listed ≥1 item in
// the just-completed week:
//   1. Computes their consecutive-week listing streak from north_star_weekly_log.
//   2. Records the week in north_star_weekly_log (idempotency + streak history).
//   3. Sends an encouragement digest email tied to their listing activity.
//   4. Celebrates any newly-crossed lifetime milestone (10/25/50/…) exactly once.
//
// Marketing opt-out is honored for both emails (the log rows are still written
// so streak math stays correct). Idempotent: the weekly log's UNIQUE(user_id,
// week_start) means a re-run skips already-celebrated users, and the milestone
// log's UNIQUE(user_id, milestone) means a milestone is emailed once.
//
// Mounted in main.ts as POST /api/jobs/north-star-digest, OUTSIDE /api/* JWT
// groups, gated by X-Internal-Job-Secret (same pattern as the other crons).

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { captureException } from "../lib/observability.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import {
  buildNorthStarMilestoneEmail,
  buildNorthStarWeeklyEmail,
} from "../lib/email.ts";
import { coordinateMarketingSend } from "../lib/marketing-coordinator.ts";

// Keep in sync with src/lib/constants.ts (NORTH_STAR_WEEKLY_GOAL / _MILESTONES).
const WEEKLY_GOAL = 10;
const MILESTONES = [10, 25, 50, 100, 250, 500, 1000];
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Monday 00:00 UTC of the week containing `d`. */
function startOfWeekUTC(d: Date): Date {
  const x = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const isoDow = (x.getUTCDay() + 6) % 7; // 0=Mon..6=Sun
  x.setUTCDate(x.getUTCDate() - isoDow);
  return x;
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

interface WeeklyCount {
  user_id: string;
  items_listed: number;
}
interface LifetimeCount {
  user_id: string;
  total: number;
}

export async function handleNorthStarDigestCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const lock = await acquireJobLock("north-star-digest", 600);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const now = new Date();
    const thisMonday = startOfWeekUTC(now);
    const lastMonday = new Date(thisMonday.getTime() - WEEK_MS);
    const weekStartKey = dateKey(lastMonday);

    // 1. Who listed ≥1 item last week?
    const { data: counts, error: countsErr } = await supabaseAdmin.rpc(
      "north_star_weekly_counts",
      {
        p_start: lastMonday.toISOString(),
        p_end: thisMonday.toISOString(),
      },
    );
    if (countsErr) {
      console.error("[north-star] weekly counts failed:", countsErr.message);
      return c.json({ error: "Weekly counts failed" }, 500);
    }
    const weekly = (counts ?? []) as WeeklyCount[];
    if (weekly.length === 0) {
      return c.json({ ok: true, users: 0, weekly_sent: 0, milestone_sent: 0 });
    }
    const userIds = weekly.map((w) => w.user_id);

    // 2. Skip users already celebrated for this week (idempotency).
    const { data: existingLogs } = await supabaseAdmin
      .from("north_star_weekly_log")
      .select("user_id")
      .eq("week_start", weekStartKey)
      .in("user_id", userIds);
    const alreadySent = new Set(
      ((existingLogs ?? []) as Array<{ user_id: string }>).map(
        (r) => r.user_id,
      ),
    );
    const pending = weekly.filter((w) => !alreadySent.has(w.user_id));
    if (pending.length === 0) {
      return c.json({ ok: true, users: 0, weekly_sent: 0, milestone_sent: 0 });
    }
    const pendingIds = pending.map((w) => w.user_id);

    // 3. User contact info + marketing prefs.
    const { data: users } = await supabaseAdmin
      .from("users")
      .select("id, email, full_name, notification_preferences")
      .in("id", pendingIds);
    const userById = new Map(
      ((users ?? []) as Array<{
        id: string;
        email: string | null;
        full_name: string | null;
        notification_preferences: unknown;
      }>).map((u) => [u.id, u]),
    );

    // 4. Lifetime counts (only for users whose total could have changed).
    const { data: lifetime } = await supabaseAdmin.rpc(
      "north_star_lifetime_counts",
      { p_user_ids: pendingIds },
    );
    const lifetimeById = new Map(
      ((lifetime ?? []) as LifetimeCount[]).map((l) => [
        l.user_id,
        Number(l.total),
      ]),
    );

    // 5. Prior milestone sends, to avoid re-celebrating.
    const { data: milestoneLogs } = await supabaseAdmin
      .from("north_star_milestone_log")
      .select("user_id, milestone")
      .in("user_id", pendingIds);
    const sentMilestones = new Map<string, Set<number>>();
    for (
      const row of (milestoneLogs ?? []) as Array<{
        user_id: string;
        milestone: number;
      }>
    ) {
      let s = sentMilestones.get(row.user_id);
      if (!s) sentMilestones.set(row.user_id, s = new Set());
      s.add(row.milestone);
    }

    let weeklySent = 0;
    let milestoneSent = 0;
    // US-2314: users whose pass THREW. The name is deliberate — "failed" is one
    // of cron-run-outcome.ts's FAILURE_KEYS (US-2312), so a run that loses part
    // of the cohort records as an error instead of reporting a plausible-looking
    // send count.
    let failed = 0;

    for (const w of pending) {
      try {
        const user = userById.get(w.user_id);
        const itemsListed = Number(w.items_listed);

        // ── Streak: 1 (this week) + consecutive prior weeks with ≥1 listing.
        const { data: priorWeeks } = await supabaseAdmin
          .from("north_star_weekly_log")
          .select("week_start")
          .eq("user_id", w.user_id)
          .gte("items_listed", 1);
        const weekSet = new Set(
          ((priorWeeks ?? []) as Array<{ week_start: string }>).map(
            (r) => r.week_start,
          ),
        );
        let streak = 1;
        let cursor = lastMonday.getTime() - WEEK_MS;
        while (weekSet.has(dateKey(new Date(cursor)))) {
          streak++;
          cursor -= WEEK_MS;
        }

        // US-2314: the weekly-log insert USED TO SIT HERE, before the send. That
        // row is also the next run's skip set, so writing it first meant a send
        // that threw left the user marked celebrated with no email — and because
        // weekStartKey is derived from now() each run, the following week computes
        // a DIFFERENT key and never revisits them. The mail was lost, not
        // deferred. It is now written after the send; see below.
        const prefs =
          (user?.notification_preferences as Record<string, unknown> | null) ??
            null;
        const lifetimeListed = lifetimeById.get(w.user_id) ?? itemsListed;

        // ── Weekly encouragement email — routed through the marketing coordinator
        //    (US-934), the single cross-program chokepoint enforcing consent,
        //    suppression, the per-recipient daily cap, quiet hours, and the
        //    drip-precedence pause (the newsletter is held while a recipient is in
        //    the trial drip). A capped/paused send is deferred, not dropped.
        if (user?.email) {
          const built = await buildNorthStarWeeklyEmail({
            userId: w.user_id,
            userName: user.full_name || "there",
            itemsListed,
            goal: WEEKLY_GOAL,
            streakWeeks: streak,
            lifetimeListed,
          });
          const res = await coordinateMarketingSend({
            to: user.email,
            userId: w.user_id,
            prefs,
            source: "weekly_newsletter",
            category: "north_star_weekly",
            subject: built.subject,
            html: built.html,
          });
          if (res.sent) weeklySent++;
        }

        // ── Record the week, AFTER the send (US-2314). Idempotent via
        //    UNIQUE(user_id, week_start), so a concurrent run losing the race is
        //    a no-op rather than a second email.
        //
        //    THE TRADE, stated because it is a real one: writing after the send
        //    means a crash BETWEEN the two could re-send on a manual same-week
        //    re-run. Writing before meant a crash lost the email permanently.
        //    A rare duplicate is recoverable; a silently missing email is not,
        //    and AC2 sanctions this ordering explicitly.
        const { error: logErr } = await supabaseAdmin
          .from("north_star_weekly_log")
          .insert({
            user_id: w.user_id,
            week_start: weekStartKey,
            items_listed: itemsListed,
            streak_weeks: streak,
          });
        if (logErr && logErr.code !== "23505") {
          console.error(
            `[north-star] weekly log insert failed for ${w.user_id}:`,
            logErr.message,
          );
        }

        // ── Milestone: celebrate the highest newly-crossed threshold once,
        //    but mark ALL newly-crossed thresholds as sent.
        const already = sentMilestones.get(w.user_id) ?? new Set<number>();
        const crossed = MILESTONES.filter(
          (m) => lifetimeListed >= m && !already.has(m),
        );
        if (crossed.length > 0) {
          const rows = crossed.map((m) => ({
            user_id: w.user_id,
            milestone: m,
          }));
          const { error: mErr } = await supabaseAdmin
            .from("north_star_milestone_log")
            .insert(rows);
          if (!mErr) {
            const top = crossed[crossed.length - 1];
            if (user?.email && top != null) {
              const built = await buildNorthStarMilestoneEmail({
                userId: w.user_id,
                userName: user.full_name || "there",
                milestone: top,
                lifetimeListed,
              });
              const res = await coordinateMarketingSend({
                to: user.email,
                userId: w.user_id,
                prefs,
                source: "weekly_newsletter",
                category: "north_star_milestone",
                subject: built.subject,
                html: built.html,
              });
              if (res.sent) milestoneSent++;
            }
          } else if (mErr.code !== "23505") {
            console.error(
              `[north-star] milestone log insert failed for ${w.user_id}:`,
              mErr.message,
            );
          }
        }
      } catch (err) {
        // US-2314: one user must not take the rest of the week's cohort with it.
        // The handler is try/finally with no catch, so before this a throw at
        // user 50 of 1000 escaped to Hono and users 51-1000 got neither a log row
        // nor an email — and the week key moved on, so they were never revisited.
        failed++;
        captureException(err, {
          level: "warn",
          route: "jobs.north-star.user",
          extra: { userId: w.user_id, weekStart: weekStartKey },
        });
      }
    }

    console.log(
      `[north-star] week ${weekStartKey}: ${pending.length} users, ` +
        `${weeklySent} weekly + ${milestoneSent} milestone emails, ${failed} failed`,
    );
    return c.json({
      ok: true,
      week_start: weekStartKey,
      users: pending.length,
      weekly_sent: weeklySent,
      milestone_sent: milestoneSent,
      failed,
    });
  } finally {
    await lock.release();
  }
}
