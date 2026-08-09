// US-2228 AC3 — monthly recurring expenses.
//
// The whole risk of this feature is in two places, and neither is the database:
//
//   1. THE MONTH BOUNDARY. "One month later" is not addition. Anchored on the
//      31st, a naive implementation walks the series backwards through the
//      calendar — Jan 31 → Feb 28 → Mar 28 → Apr 28 — and a seller reconciling
//      rent against a bank statement watches the date drift with no explanation.
//      The cases below pin the anchored form, which is the one that does not
//      drift, and they pin it across a leap year in both directions.
//
//   2. THE OWNER ON EACH COPY. This runs on the service-role client from a cron,
//      with no request and no authenticated user, so there is nothing ambient to
//      get wrong AND nothing to catch a row built with the wrong owner. One
//      seller's rent filed under another seller's books would be silent,
//      permanent and invisible in every UI. So it is asserted directly.

import { assertEquals } from "@std/assert";
import {
  daysInMonth,
  monthlyDueDates,
  planOccurrences,
  type RecurrenceTemplate,
} from "../lib/expense-recurrence.ts";

// ── daysInMonth ────────────────────────────────────────────────────

Deno.test("daysInMonth knows the short months and the leap rule", () => {
  assertEquals(daysInMonth(2026, 1), 31);
  assertEquals(daysInMonth(2026, 2), 28);
  assertEquals(daysInMonth(2024, 2), 29); // leap
  assertEquals(daysInMonth(2000, 2), 29); // divisible by 400 — IS a leap year
  assertEquals(daysInMonth(1900, 2), 28); // divisible by 100, not 400 — is NOT
  assertEquals(daysInMonth(2026, 4), 30);
  assertEquals(daysInMonth(2026, 12), 31);
});

// ── monthlyDueDates: the boundary that matters ─────────────────────

Deno.test("a mid-month anchor just repeats on the same day", () => {
  assertEquals(monthlyDueDates("2026-01-15", "2026-05-20"), [
    "2026-02-15",
    "2026-03-15",
    "2026-04-15",
    "2026-05-15",
  ]);
});

Deno.test("a 31st anchor clamps for short months and RETURNS to the 31st", () => {
  // This is the assertion the whole file exists for. A carry-forward
  // implementation gives Feb 28, Mar 28, Apr 28, May 28 — plausible-looking,
  // and wrong in a way that compounds every month.
  assertEquals(monthlyDueDates("2026-01-31", "2026-07-01"), [
    "2026-02-28",
    "2026-03-31",
    "2026-04-30",
    "2026-05-31",
    "2026-06-30",
  ]);
});

Deno.test("a 29th/30th anchor clamps in a non-leap February and recovers", () => {
  assertEquals(monthlyDueDates("2026-01-30", "2026-04-01"), [
    "2026-02-28",
    "2026-03-30",
  ]);
  // …and does NOT clamp in a leap February.
  assertEquals(monthlyDueDates("2024-01-30", "2024-04-01"), [
    "2024-02-29",
    "2024-03-30",
  ]);
});

Deno.test("the series crosses a year boundary without losing a month", () => {
  assertEquals(monthlyDueDates("2025-11-05", "2026-02-05"), [
    "2025-12-05",
    "2026-01-05",
    "2026-02-05",
  ]);
});

Deno.test("today itself is due; tomorrow is not", () => {
  // Inclusive upper bound: an entry dated today belongs in today's books.
  assertEquals(monthlyDueDates("2026-01-10", "2026-02-10"), ["2026-02-10"]);
  assertEquals(monthlyDueDates("2026-01-10", "2026-02-09"), []);
});

Deno.test("an anchor in the future produces nothing", () => {
  assertEquals(monthlyDueDates("2027-01-10", "2026-08-09"), []);
});

Deno.test("a malformed date produces nothing rather than a guess", () => {
  assertEquals(monthlyDueDates("2026-1-5", "2026-08-09"), []);
  assertEquals(monthlyDueDates("not a date", "2026-08-09"), []);
  assertEquals(monthlyDueDates("2026-13-05", "2026-08-09"), []);
  assertEquals(monthlyDueDates("2026-01-05", "garbage"), []);
});

Deno.test("a long-dormant anchor catches up rather than running away", () => {
  // Two years of arrears. The generator returns them all; the CAP lives in
  // planOccurrences, so this stays a pure calendar question.
  const all = monthlyDueDates("2024-03-15", "2026-03-15");
  assertEquals(all.length, 24);
  assertEquals(all[0], "2024-04-15");
  assertEquals(all[23], "2026-03-15");
});

// ── planOccurrences ────────────────────────────────────────────────

const TEMPLATE: RecurrenceTemplate = {
  id: "tpl-1",
  user_id: "owner-a",
  category: "subscriptions",
  description: "Storage unit",
  amount: 89.5,
  spent_on: "2026-01-10",
};

Deno.test("every generated copy carries the TEMPLATE's owner", () => {
  const rows = planOccurrences(TEMPLATE, [], "2026-04-10");
  assertEquals(rows.length, 3);
  assertEquals(new Set(rows.map((r) => r.user_id)), new Set(["owner-a"]));
});

Deno.test("a copy is never itself a template", () => {
  const rows = planOccurrences(TEMPLATE, [], "2026-04-10");
  assertEquals(rows.every((r) => r.recurs_monthly === false), true);
  assertEquals(new Set(rows.map((r) => r.recurrence_source_id)), new Set(["tpl-1"]));
});

Deno.test("the copy carries the template's category, amount and description", () => {
  const [first] = planOccurrences(TEMPLATE, [], "2026-02-10");
  assertEquals(first?.category, "subscriptions");
  assertEquals(first?.amount, 89.5);
  assertEquals(first?.description, "Storage unit");
  assertEquals(first?.spent_on, "2026-02-10");
});

Deno.test("months already present are skipped — re-running creates nothing", () => {
  const first = planOccurrences(TEMPLATE, [], "2026-04-10");
  const dates = first.map((r) => r.spent_on);
  // Second pass with those months on the table: nothing left to do.
  assertEquals(planOccurrences(TEMPLATE, dates, "2026-04-10"), []);
});

Deno.test("a GAP in the middle is filled, not skipped", () => {
  // The failure mode of any "remember where you got to" design: a month missed
  // during an outage is never revisited. Recomputing from the anchor fixes it.
  const rows = planOccurrences(
    TEMPLATE,
    ["2026-02-10", "2026-04-10"],
    "2026-04-10",
  );
  assertEquals(rows.map((r) => r.spent_on), ["2026-03-10"]);
});

Deno.test("the cap bounds one run, and the rest arrive on the next", () => {
  const capped = planOccurrences(TEMPLATE, [], "2027-06-10", 12);
  assertEquals(capped.length, 12);
  assertEquals(capped[0]?.spent_on, "2026-02-10");
  assertEquals(capped[11]?.spent_on, "2027-01-10");
  // Feed the first run's output back in: the next run picks up where it stopped.
  const next = planOccurrences(
    TEMPLATE,
    capped.map((r) => r.spent_on),
    "2027-06-10",
    12,
  );
  assertEquals(next[0]?.spent_on, "2027-02-10");
});

Deno.test("a cap of zero produces nothing instead of throwing", () => {
  assertEquals(planOccurrences(TEMPLATE, [], "2026-04-10", 0), []);
  assertEquals(planOccurrences(TEMPLATE, [], "2026-04-10", -5), []);
});
