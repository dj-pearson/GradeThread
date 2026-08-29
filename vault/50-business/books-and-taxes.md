---
title: Books and taxes
type: contract
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00683_tax_profiles.sql
  - supabase/migrations/00684_ledger_accounts.sql
  - src/lib/tax-profile.ts
  - src/lib/chart-of-accounts.ts
  - supabase/migrations/00685_ledger_entries.sql
  - src/lib/ledger-math.ts
  - scripts/check-ledger-invariant.mjs
  - supabase/migrations/00686_ledger_rebuild_no_revoke.sql
  - supabase/migrations/00687_ledger_rls_initplan.sql
  - src/lib/pnl-statement.ts
  - src/pages/flipdesk/pnl.tsx
  - supabase/migrations/00688_inventory_snapshots.sql
  - src/lib/cogs.ts
  - scripts/check-cogs-worksheet.mjs
reviewed: 2026-08-29
tags: [finance, tax, flipdesk, money]
summary: The rules the Books and Taxes epic (US-2981) obeys - what each stored figure means, which form line it feeds, and the four things the app deliberately refuses to do.
---

# Books and taxes

The contract behind US-2981. Every number the Money section shows a seller at
tax time comes from a rule written here, and where a rule is a judgement call
rather than arithmetic, this note says who made it and why.

Related: [[pricing]] for what GradeThread charges, which is an expense on the
seller's books, not revenue on theirs.

## What this product does and does not do

**Does:** arithmetic on the seller's own data, labelled with the form line it
feeds, so they or their accountant can transcribe it.

**Does not:** give tax advice, file anything, decide whether a deduction
applies to a particular seller, or take a position on a grey area. Every screen
in this epic carries that framing, using the same wording the content module
already uses for the reseller-taxes topic (migration `00192_seed_topic_bank`).

Four refusals, each deliberate:

1. **The EIN is never stored.** `tax_profiles.has_ein` is a boolean. Nothing in
   the app needs the nine digits, and holding them turns one row into a breach
   target. The year-end packet prints a blank for the seller to fill in.
2. **No filing, ever.** Not an e-file integration, not a form PDF that looks
   like the real form. A worksheet that names line numbers, and nothing that
   could be mistaken for a return.
3. **No advice on grey areas.** Whether a room is used *exclusively* for the
   business is a fact only the seller knows. The app states the rule in one
   sentence and computes what follows from their answer.
4. **QuickBooks sync is one-way.** GradeThread to QuickBooks. Two-way sync
   between two systems that both think they own a transaction is how books get
   corrupted, and the UI says which direction it runs.

## The tax profile

One row per seller, `public.tax_profiles`. Created lazily: a seller who never
opens the screen is treated as holding `TAX_PROFILE_DEFAULTS` from
`src/lib/tax-profile.ts` - sole proprietor, cash method, calendar year. Those
defaults are the correct answer for the overwhelming majority of resellers, and
the alternative (a blank screen demanding five decisions before showing a
number) is how a setup screen becomes a wall.

### Why text plus CHECK rather than enums

A Postgres enum value cannot be used in the transaction that adds it, so every
future entity type would be a two-deploy change. These are small closed sets
read by application code, not index-heavy query predicates. The CHECK
constraints are proven against real Postgres, not asserted - month 13, a
free-text state and a second profile per user were each rejected on the local
stack before the migration was committed.

### The audit trail is not decoration

`tax_profile_changes` records three fields only: `accounting_method`,
`fiscal_year_start_month` and `entity_type`. Those are **elections**, not
preferences. Switching from cash to accrual mid-year changes which tax year a
sale falls in, so a seller who flips the toggle in March has silently restated
a return they already filed. The trigger is `SECURITY DEFINER` and the table has
no INSERT policy: a history a user can write is not a history.

## The fiscal year, and the bug it replaces

Until US-2982, `src/pages/finances.tsx` computed "this year" as January 1. A
seller on any other fiscal year was shown the wrong twelve months, with no
error and no visible tell - the worst shape of wrong, because it looks like the
product working.

The maths now lives in `src/lib/tax-profile.ts` as pure functions taking the
reference date as a parameter, so it is unit-tested without rendering anything
and so the P&L, the tax packet and the finances page cannot drift on what a
year is.

Two rules that are easy to get wrong and are pinned by tests:

- **Boundaries are local midnight, never `Date.UTC`.** A fiscal year start is a
  calendar fact for the seller in their own timezone. Building it in UTC lands
  on the previous day for anyone west of Greenwich, which is the same defect as
  US-2339's Android expense dates walking back a day per sync.
- **Quarters run from the fiscal year start, not from January.** A July year
  start has Q1 = Jul-Sep. Showing that seller a Jan-Mar "this quarter" produces
  a number matching nothing they will ever file.
- **A non-January year is labelled across two years** - "2026-27", never
  "2026". Calling a year that ends in June 2027 "2026" is how a seller files
  the wrong twelve months.

## Money representation

Integer cents, everywhere this epic writes. `sales.sale_price` and
`flipdesk_expenses.amount` are `decimal` from earlier work and stay that way;
the conversion happens once, at the boundary, in
`dollarInputToCents` / `centsToDollarInput`.

`dollarInputToCents` returns **null**, never 0, for anything unparseable. Zero
is a real answer ("I have no other income") and silently turning a typo into it
would change the seller's estimated tax without telling them.

## The chart of accounts

`public.ledger_accounts`, seeded by migration 00684. A row with `user_id IS
NULL` is a system account: readable by everyone, writable by nobody through
RLS. A row with a `user_id` is that seller's own sub-account under a system
parent.

`src/lib/chart-of-accounts.ts` mirrors the seeded rows so a picker can show the
IRS line without a round trip. **The mirror is drift-guarded**: a test parses
the migration's `VALUES` block and compares field for field, and was
sabotage-verified by changing one line number in the SQL, which reddened it.

### The two judgement calls

Both are questions a preparer would ask, so both are decided here rather than
re-derived each time someone reads the code:

- **`equipment` defaults to line 13 (depreciation), not line 22 (supplies).**
  Whether a camera or a steamer is expensed outright or depreciated is a
  threshold question only the seller's accountant can settle. Defaulting to
  supplies would quietly take the aggressive position on their behalf.
- **`subscriptions` defaults to line 27a (other expenses), not line 18 (office
  expense).** Both are defensible and preparers split roughly evenly. 27a wins
  because it is itemised and labelled on the form, so the accountant sees what
  it is instead of a lump.

### 'other' reaches no line, deliberately

The `uncategorised` account has `schedule_c_line = NULL` and a
`no_line_reason` explaining it. Dropping an unsorted dollar onto 27a would hide
exactly the thing an accountant bills to sort out. The expense form says so at
the point of choosing, the row says "Not sorted" in the list, and US-2992 will
pick it up as a review item.

Every system account either carries a line or carries a reason it has none. A
test asserts it, because an unmapped account with no explanation is
indistinguishable from a forgotten one.

### The bridge from the eight categories

`flipdesk_expenses.account_id` is nullable and **is never backfilled**. NULL
means "use the default for this category", resolved identically by
`public.default_account_for_category()` in SQL and `CATEGORY_DEFAULT_ACCOUNT`
in TypeScript. Setting the column is how a seller OVERRIDES that default. An
unset column and a column set to the default mean different things, and only
one of them was a decision.

## The ledger

`public.ledger_entries`, derived by `rebuild_ledger_for_user()` in migration
00685. This is the canonical record, and the P&L, the tax packet and the
QuickBooks push all read it.

### It is NOT double-entry, and here is what that costs

Entries are **single-sided**: a signed amount against one account. Forcing
balanced pairs on a one-person reseller business costs every write path and
buys nothing it needs. The price, stated here so nobody discovers it as a
surprise:

- **No balance sheet.** There is no cash account, no accounts receivable, no
  equity. Ask for one and the answer is "this ledger cannot".
- **No owner draws or capital contributions.** Money the seller moves in or out
  of the business personally is invisible.
- **No loans.** Interest paid is an expense account; the principal is not
  tracked.

If any of those becomes a requirement, the change is a second `amount_cents`
column and a balancing constraint, not a patch.

### Sign convention

**Positive increases profit.** Income positive, every cost negative. The
alternative -- positive magnitudes with the account's flow deciding the sign at
read time -- means every reader has to know the convention, and one of them
eventually will not.

### Integer cents, and why the conversion is exact

Every source column is `numeric(10,2)`, so `value * 100` is an integer and
nothing is lost. In SQL that is a plain multiply. In TypeScript it is
`toCents()` in `src/lib/ledger-math.ts`, which works on the DIGITS rather than
on a float, because `19.99 * 100` is `1998.9999999999998` in IEEE 754 and
rounding it happens to work while `1.005 * 100` does not.

### Two things recorded but kept out of profit

`sales_tax_collected` and `cash_payout`. Sales tax was never the seller's
income; a payout is money already counted when the sale happened. Counting
either would double income. They are recorded anyway, because the 1099-K bridge
ties to both and a number the seller cannot see is a number they distrust.

### The invariant: one number is one number

`public.ledger_reconciliation(period_start)` returns the ledger's net, the
`finances_dashboard` net, and the variance. **`agrees: false` means the LEDGER
is wrong** -- the dashboard is the behaviour sellers have been reading for
months, so it is the one with standing.

Run it with `npm run check:ledger`. It seeds a fixture inside a transaction
that rolls back, so it is safe against any database with the migrations
applied. It is deliberately NOT in `npm run verify`: it needs Postgres, and a
lane that skips silently when the stack is down teaches everyone to ignore it.

> **The fixture's sixth case exists because a sabotage run passed without it.**
> Removing the double-count guard from the legacy-shipment join changed nothing,
> because no sale in the fixture had BOTH a `shipping_cost` and a `shipments`
> row. The invariant stayed green against a genuinely broken ledger. With that
> case added, the same sabotage moves the variance to -$9.85. **A fixture that
> cannot exercise a guard cannot verify it**, and a green result from one is
> worth less than no result at all.

### Rebuilding is safe to repeat

`rebuild_ledger_for_user()` deletes every derived row for the user and
re-inserts, and the natural key `(user_id, source_kind, source_id,
source_detail)` refuses a duplicate -- the same shape as migration 00565's
recurrence slot index. It needs no bookkeeping column, can catch up after an
outage and can race a second instance; the worst outcome is a rejected insert
rather than a seller's totals doubling.

**Adjustments are never touched by a rebuild.** They are the correction
mechanism, and the browser can write nothing else: the only INSERT policy on
`ledger_entries` covers `source_kind = 'adjustment'`. A seller who could
hand-author a `sale` entry could inflate the very number their 1099-K
reconciliation is meant to check.

## What is live in production

All five migrations (00683-00687) were applied on **2026-08-29**. Three of them
are confirmed by reading production rather than by trust: `tax_profiles`,
`tax_profile_changes`, `ledger_accounts` and `ledger_entries` all appear in the
prod PostgREST OpenAPI document, as do `rebuild_my_ledger`,
`rebuild_ledger_for_user`, `ledger_reconciliation` and
`default_account_for_category` — so the SQL landed and `NOTIFY pgrst` ran. The
seeded chart reads back as **32 system accounts**, with `cash_payout` present,
Part III complete (35, 36, 37, 38, 39, 41), and exactly three accounts
deliberately carrying no line: `sales_tax_collected`, `cash_payout`,
`uncategorised`.

00686 (the grant) and 00687 (policy predicates) are **owner-confirmed only**.
Neither a grant nor an RLS predicate is in the PostgREST schema cache, so there
is no outside read that shows them, and the one direct probe for 00686 — calling
the function as `anon` — is the outage it exists to remove.

### The system chart is readable with the anon key, and that is fine

The SELECT policy is `user_id IS NULL OR (select auth.uid()) = user_id`. For an
unauthenticated caller `auth.uid()` is null, so the second arm is never true and
the first one is: **anyone holding the public anon key can read the 32 system
accounts.** Confirmed by doing it against production.

That is acceptable and is recorded here so nobody re-discovers it as a scare.
The rows are account codes and IRS line numbers — public reference data with no
seller in it. The same read returns exactly 32 rows, which is the seed and
nothing more, so no seller's own sub-accounts leak. It was a consequence of the
policy rather than a decision, though, and this paragraph is the decision.

### Three defects shipped in these migrations, and all three were caught by guards

Worth keeping, because the pattern is more useful than any one of them. The
epic's first three migrations went in inside an hour and each tripped an
existing check on the way out:

- **US-3002** — 00685 ended with `REVOKE ALL ON FUNCTION ... FROM public`. On
  this Postgres image a denied `EXECUTE` from `anon` segfaults the backend and
  restarts the database, taking every other session with it, and PostgREST
  exposes the function. Caught by `us2403-function-revoke-gate`, fixed by 00686,
  which moves the authorization into the function body. See
  [[postgres-revoke-from-anon-is-a-noop]] for the wider rule — it already
  existed, and this still happened.
- **US-3005** — thirteen policies written as `auth.uid() = user_id` rather than
  `(select auth.uid()) = user_id`, so the planner re-evaluates per row. On
  `ledger_entries`, which gets nine rows per completed sale, that is the table
  the rule exists for. Caught by `rls-guard_test.ts` (US-1927 AC1), fixed by
  00687.
- **US-3006** — `src/lib/ledger.ts` has seven exports and no importer: the
  reading half of the ledger shipped with no entry point. US-2985 is where it
  gets one.

The lesson is not "add more guards". It is that three migrations written in one
sitting got less review than one migration written alone, and the guards were
the only thing standing between that and production.

## The profit and loss statement

`src/lib/pnl-statement.ts` builds it; `src/pages/flipdesk/pnl.tsx` is the
screen, at Money -> P&L.

**It is not `src/lib/pnl.ts`.** That file already existed and answers a
different question: one sale's margin from a `SaleRow`. This one aggregates
ledger entries into a statement. Two files because they are two questions --
"did this flip make money" and "what were my numbers this quarter".

### Rules the statement obeys

- **Schedule C order, never alphabetical.** A preparer reads down the form; an
  alphabetised statement makes them hunt. Row order comes from the chart's
  `sort_order`.
- **Section membership is derived from the account's `flow`,** not from a
  second list of codes. The failure mode otherwise is an account that exists,
  collects entries and appears in no section -- which reads as a balanced
  statement quietly missing money.
- **Costs are stored signed and printed positive.** Every total is a plain sum,
  so nobody has to remember which rows to flip. The CSV export keeps the SIGN,
  because a spreadsheet summing a column needs it, and the file says so in a
  header row rather than leaving the seller to notice the difference.
- **Three rows print at zero:** `sales_revenue`, `returns_allowances`,
  `purchases`. A statement with no COGS row does not say "no cost of goods", it
  says nothing, and the seller cannot tell a zero from a gap.
- **An entry against an unknown account is shown, not dropped,** as "Entries we
  could not place", and it moves the bottom line because the money is real.
- **A percentage against a zero prior period is null, not 100%.** Going from $0
  to $500 is not a 100% rise, and printing one is a lie the seller repeats to
  somebody. The delta uses the prior period's MAGNITUDE, so a loss shrinking
  from -$1000 to -$400 reads as +60%.

### Periods are half-open

`periodRange()` and `priorRange()` in `src/lib/tax-profile.ts` return
`{ from, to }` with `to` EXCLUSIVE. Half-open is the only convention that
composes: two adjacent periods share a boundary, no day belongs to both, and a
test asserts four quarters laid end to end are exactly the fiscal year for
every start month. Dates are `yyyy-mm-dd` strings built with `ymd()`, never
`toISOString()`, which lands on the previous day west of Greenwich.

A custom range compares against **the same number of days before it** -- 17
days against the 17 preceding. It is the only defensible reading, and the
screen says so, because "the previous period" for an arbitrary range is
otherwise a guess the seller has to reverse-engineer.

### The statement is pinned to a measured result

`pnl-statement.test.ts` carries the fifteen entries that
`scripts/fixtures/ledger-invariant.sql` actually produced on Postgres, and
asserts the builder nets to **9165 cents** -- the `true_net_cents` the
database's own `ledger_reconciliation()` reported for the same rows. That ties
the pure builder to a measurement rather than to a second copy of the same
arithmetic. If the SQL derivation and the TypeScript builder ever drift, one of
those two numbers moves.

## Cost of goods sold, and ending inventory

`public.inventory_snapshots` (migration 00688) values what a seller was holding
at one instant. `cogs_worksheet(from, to)` turns two of those into Schedule C
Part III.

### Why the snapshot copies rather than references

`inventory_items.acquired_price` is editable. The moment a seller corrects last
year's cost, last year's ending inventory silently changes -- and last year's
ending inventory is **this** year's beginning inventory. So
`inventory_snapshot_items` COPIES each cost. Proven: the fixture edits an item
from $25 to $999 after the snapshot and the total stays at $85.

This was the one gap in the epic that got harder to close the longer it was
left, which is why it went in before the tax packet that needs it.

### What counts as on hand

Acquired before `as_of`, and not sold before `as_of`. **Both halves are
date-based on purpose.** Filtering on the current `status` column would make
every historical snapshot wrong the moment an item's status moved, which is
exactly the decay the table exists to stop. Dates do not change retroactively.

`as_of` is EXCLUSIVE, so one snapshot is both year N's ending inventory and year
N+1's beginning inventory. That is the whole reason the boundary is a single
date rather than two.

### The two signals are different problems

> **Measured on Postgres, not assumed.** A sold item with **no cost basis does
> not move the variance.** Both routes to COGS read the same `acquired_price`
> column, so a null cancels on both sides. A screen watching only the variance
> would call those books clean.

So the worksheet reports two things and `cogsConfidence()` names which:

- **`variance`** -- the two routes to COGS disagree. Structural: an item is in
  one and not the other, usually a wrong acquisition date. The fixture's Item F
  is acquired in 2027 on paper and sold in 2026, which fires it at -$50.
- **`missing_cost`** -- an item is valued at zero. Understates inventory,
  overstates the deduction, leaves the variance at zero.
- **`no_snapshot`** -- reported ahead of both, because line 42 without lines 35
  and 41 is arithmetic on a hole.

### Reconstructed is not recorded

A snapshot created by the backfill is flagged `reconstructed`, and the screen
and the CSV both say so. It is the best available answer rebuilt from what
survived, not a count taken on the day, and an accountant needs to know which
they are holding.

### Running the check

`npm run check:cogs`. Twelve assertions against a two-year fixture inside a
rolling-back transaction, including the one that must FAIL: 2025 reconciles at
$0.00 and 2026 does not, at -$50.00. Sabotage-verified by removing the
`NOT EXISTS (... sales ...)` arm so sold items never leave inventory, which
turns seven checks red.

### A limit, recorded rather than discovered

An item that is lost, donated or written off **never leaves inventory**, because
the predicate only removes items that were SOLD. It will sit in ending inventory
for ever, overstating line 41 and therefore understating COGS. There is no
write-off path in the schema today. Filed as **US-3007**, including the
reason a status flag alone cannot fix it: the predicate is date-based, and
`archived` carries no date saying when it happened.

## Where the rest of the epic is written down

The child stories carry the detail while they are open; each closed story folds
its contract into this note. Currently landed:

- **US-2982** - the tax profile and the fiscal year, above.
- **US-2983** - the chart of accounts and its Schedule C mapping, above.
- **US-2984** - the ledger, its limits and its invariant, above.
- **US-2985** - the P&L statement and the half-open period rules, above.
- **US-2986** - COGS, the inventory snapshot and its two signals, above.

Still open, and each will add a section here rather than a new note: COGS and
the ending-inventory snapshot (US-2986), facilitator sales tax (US-2987), the 1099-K bridge
(US-2988), the dated mileage and home-office rates (US-2989, US-2990),
estimated tax (US-2991), period close (US-2995) and the QuickBooks account
mapping (US-2997, US-2998).
