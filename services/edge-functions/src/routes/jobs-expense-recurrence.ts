// US-2228 AC3: the monthly recurring-expense sweep.
//
// Copies each recurring template forward, one entry per month, up to today.
// Mounted in main.ts as POST /api/jobs/expense-recurrence, OUTSIDE the /api/*
// JWT groups and gated by X-Internal-Job-Secret like the other crons; the
// /api/jobs/* middleware records the run to cron_runs.
//
// SAFE TO RUN AT ANY FREQUENCY, AND THAT IS BY DESIGN. There is no "next
// occurrence" column to advance, so there is no second write that can be lost.
// The whole series is recomputed from the template's own spent_on every run
// (lib/expense-recurrence.ts), missing months are inserted, and a partial unique
// index on (recurrence_source_id, spent_on) rejects anything already there. Two
// concurrent runs, a crash mid-batch, a week of downtime — all converge on the
// same table.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  type IsoDate,
  planOccurrences,
  type RecurrenceTemplate,
} from "../lib/expense-recurrence.ts";

/** Templates examined per run. Far above the realistic count; a runaway stop. */
const TEMPLATE_SCAN_LIMIT = 2000;
/** Entries generated per template per run — see planOccurrences. */
const CATCHUP_CAP = 12;

/**
 * Today, in UTC.
 *
 * `spent_on` is a plain calendar date the seller reads in their own timezone,
 * and this container runs in UTC, so around midnight the two disagree by up to
 * a day. The consequence is small and one-directional: a seller west of UTC can
 * see next month's entry appear a few hours before their own clock reaches that
 * date. The entry itself is dated correctly — it says the 1st and it is the 1st
 * somewhere — and the alternative, storing a timezone per seller to delay a
 * bookkeeping row by six hours, buys nothing worth the column.
 */
function todayUtc(): IsoDate {
  return new Date().toISOString().slice(0, 10);
}

export async function handleExpenseRecurrenceCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // The lock is politeness, not correctness — the unique index is correctness.
  const lock = await acquireJobLock("expense-recurrence", 300);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  const today = todayUtc();
  let templates = 0;
  let created = 0;
  let failed = 0;

  try {
    const { data, error } = await supabaseAdmin
      .from("flipdesk_expenses")
      .select("id, user_id, category, description, amount, spent_on")
      .eq("recurs_monthly", true)
      .is("recurrence_source_id", null)
      .lt("spent_on", today)
      .limit(TEMPLATE_SCAN_LIMIT);
    if (error) throw error;

    for (const row of (data ?? []) as RecurrenceTemplate[]) {
      templates++;

      // What already exists for THIS template. Read per template rather than in
      // one sweep so a seller with a long history cannot push another seller's
      // template out of a shared page of results.
      const { data: existing, error: exErr } = await supabaseAdmin
        .from("flipdesk_expenses")
        .select("spent_on")
        .eq("recurrence_source_id", row.id);
      if (exErr) {
        failed++;
        console.error(
          `[expense-recurrence] template ${row.id}: could not read existing entries:`,
          exErr.message,
        );
        continue;
      }

      const planned = planOccurrences(
        row,
        ((existing ?? []) as { spent_on: IsoDate }[]).map((e) => e.spent_on),
        today,
        CATCHUP_CAP,
      );
      if (planned.length === 0) continue;

      const { error: insErr } = await supabaseAdmin
        .from("flipdesk_expenses")
        .insert(planned as never);
      if (insErr) {
        // 23505 = the uniqueness guard doing its job (a concurrent run got
        // there first). Not an error worth counting, and nothing to retry.
        if (insErr.code === "23505") continue;
        failed++;
        console.error(
          `[expense-recurrence] template ${row.id}: insert failed:`,
          insErr.message,
        );
        continue;
      }
      created += planned.length;
    }

    if (templates > 0) {
      console.log(
        `[expense-recurrence] templates=${templates} created=${created} failed=${failed}`,
      );
    }
    return c.json({ ok: true, templates, created, failed });
  } catch (err) {
    console.error(
      "[expense-recurrence] sweep failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Expense recurrence sweep failed" }, 500);
  } finally {
    await lock.release();
  }
}
