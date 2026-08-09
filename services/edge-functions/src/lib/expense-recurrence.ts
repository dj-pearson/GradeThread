// US-2228 AC3 — monthly recurring expenses: the pure half.
//
// The date arithmetic lives here, apart from the database, because "add one
// month" is the part that is wrong in most implementations and the part no
// integration test will notice. Everything below is deterministic and unit
// tested; the cron in routes/jobs-expense-recurrence.ts does the I/O.

/** A plain `yyyy-mm-dd` calendar date. Never a timestamp, never a Date. */
export type IsoDate = string;

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Days in a 1-based month. Handles leap years via the UTC calendar. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Every monthly occurrence strictly AFTER `anchor` and no later than `today`.
 *
 * ── The clamping rule, which is the whole reason this is a named function ────
 * An expense anchored on the 31st has no 31st in February. Two ways to handle
 * that, and only one of them is right for a recurring bill:
 *
 *   WRONG — carry the clamp forward. Jan 31 → Feb 28 → Mar 28 → Apr 28. The
 *   series silently walks backwards through the calendar, and by the end of the
 *   year a rent payment logged on the last day of the month is landing on the
 *   28th. Anyone who reconciles against a bank statement sees the drift and
 *   cannot explain it.
 *
 *   RIGHT — clamp for display, count from the ANCHOR. Jan 31 → Feb 28 →
 *   Mar 31 → Apr 30 → May 31. Each occurrence is the anchor day of its own
 *   month, or the last day if that month is short. The series never drifts,
 *   because month N is always computed from the anchor and never from month
 *   N-1.
 *
 * That is why this takes the anchor rather than the previous occurrence, and
 * why the cron stores no "next occurrence" column: the whole series is a pure
 * function of one date, so it can be recomputed from scratch on every run.
 *
 * Returns [] for a malformed anchor or an anchor in the future.
 */
export function monthlyDueDates(anchor: IsoDate, today: IsoDate): IsoDate[] {
  const m = ISO.exec(anchor);
  if (!m || !ISO.test(today)) return [];
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-based
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return [];

  const out: IsoDate[] = [];
  // 600 months = 50 years. A hard stop so a corrupt anchor cannot spin here;
  // the loop normally exits on the `> today` break within a handful of steps.
  for (let i = 1; i <= 600; i++) {
    const total = month - 1 + i;
    const y = year + Math.floor(total / 12);
    const mm = (total % 12) + 1;
    // `day`, never the previous occurrence — that is the anti-drift rule above.
    const iso = `${y}-${pad(mm)}-${pad(Math.min(day, daysInMonth(y, mm)))}`;
    if (iso > today) break;
    out.push(iso);
  }
  return out;
}

/** The subset of a template row the planner needs. */
export interface RecurrenceTemplate {
  id: string;
  user_id: string;
  category: string;
  description: string | null;
  amount: number;
  spent_on: IsoDate;
}

/** A row ready to insert. Shaped for supabase-js, not for a human. */
export interface PlannedExpense {
  user_id: string;
  category: string;
  description: string | null;
  amount: number;
  spent_on: IsoDate;
  recurrence_source_id: string;
  recurs_monthly: false;
}

/**
 * Which entries are missing for one template, capped.
 *
 * `user_id` is copied FROM THE TEMPLATE and from nowhere else. This job runs on
 * the service-role client with no request and no authenticated user, so there is
 * no ambient identity to get wrong — but there is also nothing to catch a row
 * built with the wrong owner, which would file one seller's rent under another
 * seller's books. The copy is the isolation, so it is asserted in the tests.
 *
 * `recurs_monthly: false` on every copy: only the template repeats. The database
 * refuses the other case too (`flipdesk_expenses_no_nested_recurrence`), but a
 * job that relies on a constraint to tell it what it meant is a job that will
 * one day be run against a database missing that constraint.
 *
 * The cap bounds ONE run, not the series. A template back-dated two years is
 * caught up twelve months at a time across successive runs rather than dropping
 * twenty-four rows into the books at once, which is both a nasty surprise and a
 * long transaction.
 */
export function planOccurrences(
  template: RecurrenceTemplate,
  existingDates: readonly IsoDate[],
  today: IsoDate,
  cap = 12,
): PlannedExpense[] {
  const have = new Set(existingDates);
  return monthlyDueDates(template.spent_on, today)
    .filter((d) => !have.has(d))
    .slice(0, Math.max(0, cap))
    .map((spent_on) => ({
      user_id: template.user_id,
      category: template.category,
      description: template.description,
      amount: template.amount,
      spent_on,
      recurrence_source_id: template.id,
      recurs_monthly: false,
    }));
}
