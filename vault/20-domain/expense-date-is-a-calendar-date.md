---
title: An expense date is a calendar date, not a moment
aliases: [spent_on, EXPENSE_ZONE, expense date drift, bucketingCalendar]
type: contract
status: current
source_of_truth: code
code_refs:
  - android/app/src/main/java/com/gradethread/app/money/CalendarDateField.kt
  - android/app/src/main/java/com/gradethread/app/money/ExpenseDraft.kt
  - ios/GradeThread/Money/ExpenseStore.swift
  - services/edge-functions/src/lib/expense-recurrence.ts
  - scripts/audit-expense-date-drift.mjs
reviewed: 2026-08-30
tags: [money, flipdesk, timezone, contract]
summary: flipdesk_expenses.spent_on is a date-only column, so every client reads and writes it in UTC — a device-zone read of any one surface walks the date backwards one day per save, and it has shipped that way on both mobile platforms.
---
# An expense date is a calendar date

`flipdesk_expenses.spent_on` is a **`date`** column. It answers "which day did
this belong to", not "at what instant did this happen". A sale date is a real
moment; an expense date is not, and treating them alike is the bug below in
miniature.

## The rule

**Every read and write of an expense date happens in UTC.** Both mobile clients
name the zone once and route everything through it:

| Platform | The one place the zone is decided |
|---|---|
| Android | `ExpenseDraft.EXPENSE_ZONE = ZoneOffset.UTC` |
| iOS | `ExpenseStore.bucketingCalendar` (a Gregorian calendar pinned to UTC) |

Every surface uses it: entry, display, the wire format, and month bucketing. A
device-zone read of **any one** of them re-opens the drift, which is why it is a
named constant rather than a default parameter someone can quietly not pass.

## What goes wrong, and it has gone wrong twice

The local column stores epoch milliseconds while the server column stores a bare
date, so a conversion happens on every round trip. Split that conversion across
two zones and the date walks:

- the server's `2026-01-12` parses at **UTC midnight**
- formatted back in **Chicago (UTC-5)**, UTC midnight on the 12th is 19:00 on the
  11th, so the client writes `2026-01-11`
- the next pull parses the 11th, the next save writes the 10th

**It compounds, one day per edit-sync cycle**, because insert and edit are the
same code path — Android's `wireBody` has a single caller. So an affected row's
error equals the number of cycles it went through, and no single offset corrects
it.

Two properties are worth carrying:

1. **Only negative-UTC offsets are affected.** East of Greenwich, UTC midnight is
   still the same calendar date, so the round trip looks correct. A test leaning
   on the default zone passes on a UTC CI runner while the bug is live for every
   seller who is not on UTC.
2. **Android's own doc comment described the bug** and it shipped anyway: it said
   re-deriving "moves an evening expense to the next day east of Greenwich and to
   the previous day west of it", directly above the function doing exactly that.

iOS settled this as US-1494, Android as US-2339. Same bug, same answer, reached
independently — which is the argument for writing it down once here.

## Recurring children are generated, so drift in them is provable

`monthlyDueDates()` puts a child on `min(template day, days in that month)` and
**never on the previous occurrence** — the anti-drift rule lives in the
generator. So a child sitting on any other day is a date the generator could not
have produced. That is arithmetic, not a heuristic, and it is the only certain
detection available.

`scripts/audit-expense-date-drift.mjs` is that audit. It also prints the bound
that makes the result usable: a row whose `updated_at` still matches its
`created_at` has been saved once and **cannot** have drifted, however far back
its date looks. It deliberately does not repair anything — the error is
compounding, so a fixed offset would replace a wrong date with a differently
wrong one while making it look reviewed.

For standalone expenses there is no ground truth. Backdating a receipt and three
drift cycles produce identical rows, and the script says so rather than inventing
a threshold.

⚠ **The fix is client-side, so it lands per seller as they update the app.** A
device on an older build keeps drifting. Run the audit after the release has had
time to roll out, and run it more than once.

## The rule moved, and is now shared (US-3000, 2026-08-30)

`ExpenseDraft` no longer owns the conversion. It lives in `CalendarDateField`,
because `trip_date` on the mileage log is the same shape of field and two
implementations of "format a date for the wire" is exactly how this bug returns.
`ExpenseDraft.EXPENSE_ZONE` is kept as an alias to `CalendarDateField.ZONE`, so
every caller and every sentence above still reads true.

⚠ **The audit script still points at expenses only.** A trip logged at 8pm west
of Greenwich has the same failure mode, and `scripts/audit-expense-date-drift.mjs`
would not see it. Sharing the implementation makes the bug less likely; it does
not extend the detection.

## Related

- [[flipdesk-plan-gating]] — the surface these expenses live under
- [[INDEX]]
