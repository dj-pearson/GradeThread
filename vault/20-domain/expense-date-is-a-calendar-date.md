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
  - ios/GradeThread/Money/MoneyDate.swift
  - ios/GradeThread/Money/TripDraft.swift
  - services/edge-functions/src/lib/expense-recurrence.ts
  - scripts/audit-expense-date-drift.mjs
reviewed: 2026-09-10
tags: [money, flipdesk, timezone, contract]
summary: flipdesk_expenses.spent_on is a date-only column, so every client anchors it at UTC midnight while the device calendar names which day or month a moment falls in — anchoring any one surface in the device zone walks the date backwards one day per save, and it has shipped that way on both mobile platforms.
---
# An expense date is a calendar date

`flipdesk_expenses.spent_on` is a **`date`** column. It answers "which day did
this belong to", not "at what instant did this happen".

⚠ **This used to say "a sale date is a real moment; an expense date is not",
and that was wrong in the expensive direction.** Neither `sales.sale_date` nor
`sales.sold_at` is reliably a moment. Both are `timestamptz`, and most of what
lands in them is a calendar day that Postgres widened to UTC midnight. The
section "The sales columns are timestamptz, and mostly are not moments" below
has the writer-by-writer detail. Read it before writing anything that reads
either one.

## The rule

**A stored expense date is anchored at UTC midnight.** Both mobile clients name
the storage zone once and route every parse, format and bucket boundary through
it:

| Platform | The one place the zone is decided |
|---|---|
| Android | `CalendarDateField.ZONE = ZoneOffset.UTC` (`ExpenseDraft.EXPENSE_ZONE` is an alias) |
| iOS | `MoneyDate`: the calendar, the wire formatter, `parse`, `iso`, `startOfDay`, `anchor` |

⚠ **UTC anchors the value; it does not name the day** (US-3230, US-3302). Which
calendar day or month a *moment* falls in is a question about the seller's wall
clock, so the device calendar picks the day and the UTC calendar anchors it.
On iOS: `MoneyDate.anchor(localDayOf:localCalendar:)` on the write side,
`MoneyDate.localMidnight(of:)` and `MoneyDate.dayPicker` on the read side,
`MoneyDate.monthAnchor(localMonthOf:localCalendar:)` for a month boundary.
`MoneyDate.startOfDay` reads the day in UTC and is right only for a value that is
already anchored.

`ExpenseStore.bucketingCalendar` is still declared and is still
`MoneyDate.calendar`, but nothing calls it any more: `thisMonthTotal` takes the
device calendar and gets its boundary from `MoneyDate.monthAnchor`. Treat the
constant as the historical name, not the live one.

Every surface uses the rule: entry, display, the wire format, and month
bucketing. A device-zone *anchor* on **any one** of them re-opens the drift,
which is why the zone is a named constant rather than a default parameter someone
can quietly not pass.

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

## It covers a second column now (US-3014, 2026-09-07)

`mileage_trips.trip_date` is a `date` column too, and everything above applies to
it unchanged. iOS reaches it through `MoneyDate`, the same way Android reaches it
through `CalendarDateField`.

`MoneyDate.parse` returns **nil** on an unreadable date rather than falling back
to today. A silent fallback here would put a trip in the wrong tax year and look
like it worked, which is the same class of failure as the drift below: correct
on screen, wrong in the record.

`MoneyDate.today()` is **not** `Date()`, and since US-3230 it is not
`startOfDay(now)` either. It is `anchor(localDayOf: now)`: UTC midnight of the
seller's **local** day. `startOfDay(now)` was wrong in both directions. A seller
in Sydney tapping "log a trip" at 9am on the 8th has a `Date()` whose UTC day is
still the 7th, so the form opened on the 7th. A seller in Chicago tapping it at
9pm on the 9th has a UTC day of the 10th, so the picker showed the 9th while the
wire carried the 10th. On 31 December that second one files the expense in the
wrong tax year.

## The rule moved, and is now shared (US-3000, 2026-08-30)

`ExpenseDraft` no longer owns the conversion. It lives in `CalendarDateField`,
because `trip_date` on the mileage log is the same shape of field and two
implementations of "format a date for the wire" is exactly how this bug returns.
`ExpenseDraft.EXPENSE_ZONE` is kept as an alias to `CalendarDateField.ZONE`, so
every caller and every sentence above still reads true.

⚠ **The audit script still points at expenses only.** A trip logged at 8pm west
of Greenwich has the same failure mode, and `scripts/audit-expense-date-drift.mjs`
would not see it. Sharing the implementation makes the bug less likely; it does
not extend the detection. That is now true on both mobile platforms.

⚠ **US-2339 is still open**: Android expense dates walk back one day per
edit-sync cycle. The shared implementation is the answer, and the story is where
the remaining work is tracked — do not read "the rule moved" as "the bug is
fixed".

## The same split, twice more on iOS (US-3230, US-3302)

**US-3230, 2026-09-09: the picker and the wire disagreed.** `today()` and every
`DatePicker` bound straight at a stored value read the day in UTC, so west of
Greenwich the screen showed one day and the server got the next. `dayPicker` is
the binding adapter that keeps both on the same day, and `ExpenseStore.create`
now formats through `MoneyDate.iso` instead of the `DateFormatter` it used to
build inline.

**US-3302, 2026-09-10: the month totals.** `sales.sale_date` is declared
`timestamptz` but every writer sends a bare `YYYY-MM-DD`, so Postgres widens it
to midnight UTC and the row is a UTC-anchored day. Bucketing it with
`Calendar.current` counted a 1 September sale in August for every seller west of
UTC, under a heading read off the same wrong calendar. `MoneyDate` grew the month
half of the rule (`monthAnchor`, `startOfMonth`, `addingMonths`, `monthKey`,
`monthLabel`) plus `dayDisplay` for row views, and the sweep fixed ten more
sites, including a widget tile that read zero every day of the year west of UTC.

⚠ **US-3306 is the gap left open**, and it does not look like this bug:
`InventoryFilterCriteria.DateBand` compares two picker moments against a stored
value, needs opposite zone rules for its sale band and its purchase band, and
mentions no `Calendar` at all, so a grep never finds it.

## The sales columns are timestamptz, and mostly are not moments (US-3315, 2026-09-11)

`sales.sale_date` and `sales.sold_at` are both `timestamptz`. The type is a
promise neither column keeps, and the failure is invisible because midnight UTC
is a perfectly plausible timestamp.

Measured against the local stack on 2026-09-11, through PostgREST, exactly as
the clients write it:

| sent | stored | read back in America/Chicago |
|---|---|---|
| `"2026-09-11"` | `2026-09-11 00:00:00+00` | `2026-09-10 19:00:00-05`, `::date` = the 10th |
| `"2026-09-11T21:37:04Z"` | `2026-09-11 21:37:04+00` | the same instant |

The widening uses the **session** time zone, not UTC by definition. Every
Postgres role here runs at UTC (`authenticator`, `anon`, `authenticated` and
`service_role` set no `TimeZone`, and the cluster default is UTC), which is what
makes the anchor UTC rather than an accident of whoever opened the connection.
A deployment that changed the session zone would move every bare-date write
without changing a line of application code.

### Nine writers, and five of them have a real instant

Found by walking every source root for an assignment of the column, then reading
each one, so the list is a census rather than a memory. It is pinned by
`services/edge-functions/src/tests/sold-at-provenance_test.ts`, which walks the
same tree and fails on any site that is not registered.

| writer | what it hands `sold_at` |
|---|---|
| `routes/flipdesk-ebay.ts` | eBay `order.creationDate`, a real instant |
| `lib/orphan-sale-match.ts` | the same eBay instant, copied off the orphan row |
| `lib/etsy-orders.ts` | `created_timestamp` (epoch seconds) as an instant |
| `lib/shopify-orders.ts` | `processed_at`, else `created_at`, both instants |
| `lib/depop-orders.ts` | `created_at`/`purchased_at`/`date`, passed through unchecked |
| `record-sale-dialog.tsx` | a bare day from an `input type="date"` |
| `ios/.../SaleRecorder.swift` | a bare day from `MoneyDate` |
| `routes/flipdesk-import.ts` | a bare day, via `isoDate()` in `lib/inventory-import.ts` |
| `routes/flipdesk-sync.ts` | whatever the browser extension scraped |

Android writes it nowhere. It decodes the column in `SyncService` and its only
sales mutation is `shipped_at`.

**The three API connectors fall back to `new Date()`** when the marketplace
reported no date at all. That is a real instant of the wrong event (the sync
ran), and it is named here rather than hidden, because it is the one case where
`sold_at` carries a plausible time of day that means nothing.

**Poshmark, Mercari, Grailed, Vinted and Facebook have no instant to give.**
They come through the extension's Sold-page scrape, and those pages print
"Today", "3 days ago" or "Aug 18". `parseSoldAt` in
`extension-unified/sync/observe.js` resolves each to `Date.UTC(y, m, d)`, so the
value arrives already anchored at midnight. It is a day wearing an instant's
clothes, and it is honest only by accident.

### The rule, and why the column keeps its type

**`sold_at` holds a marketplace instant where one was reported, and a
UTC-anchored calendar day where one was not. No writer may synthesise a time of
day it was not given.**

Narrowing the column to `date` was the other option and it is destructive: five
of the nine writers already store a real moment, `ALTER COLUMN ... TYPE date
USING sold_at::date` would throw every one of those times away, and the cast
runs in the session zone, so it would move some rows a day while doing it.
Filling the four day-shaped writers with a manufactured instant is worse still.
A date picker, a spreadsheet cell and a scraped "3 days ago" have no moment in
them, and `Date.now()` at save time records when the seller typed, not when the
item sold. Midnight is at least recognisable as "no time was known".

### What the mixture already costs

- `items_full` exposes `COALESCE(sold_at, sale_date)` as `sale_date` and
  `sold_at` as `sold_at_raw`, and derives `days_to_sell` by subtracting
  `listed_at` from it. For a manual sale that subtraction starts at midnight.
- `lib/ship-deadline.ts` derives `ship_by` as `sold_at + handling_days`. It is
  only called from the eBay path today, where `sold_at` is a real instant. If
  any day-shaped writer ever gains a handling time, the deadline it produces
  lands at 00:00Z, which reads as the previous evening for the whole of the
  Americas.
- `lib/consignor-payout.ts` uses `sold_at` as the base of the consignor hold
  window, so a manual sale's hold lapses up to a day early.
- The public API declares `sold_at` as `format: date-time`
  (`lib/openapi-spec.ts`) and serves it from `items_full.sale_date`, so the
  promise is made to integrators as well.

⚠ **`sales.sale_date` is the same shape and is NOT covered by the new guard.**
It is `timestamptz NOT NULL DEFAULT now()`, every client slices a day into it,
and US-3231, US-3302 and US-3306 each shipped a bug from reading it as a moment.
Anything bucketing either column by day or month must use the UTC calendar, the
way `MoneyDate` already does on iOS.

⚠ **One live defect found while taking the census and deliberately not fixed
here.** `routes/flipdesk-sync.ts` updates `listings` with
`{ listing_status: "sold", sold_at }`, and `public.listings` has no `sold_at`
column. Measured on the local stack: that PATCH returns HTTP 400 `PGRST204`
while the same PATCH without the field returns 200, and the result is never
checked. So an extension-confirmed sale writes its `sales` row and never flips
its listing to sold. That file was owned by another change when this was
written.

## Related

- [[flipdesk-plan-gating]] — the surface these expenses live under
- [[sync-source-of-truth]], for which side owns a field when two sources disagree
- [[INDEX]]
