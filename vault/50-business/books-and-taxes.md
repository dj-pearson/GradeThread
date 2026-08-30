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
  - src/lib/tax-packet.ts
  - src/lib/receipt-allocation.ts
  - src/lib/receipt-allocation-data.ts
  - src/pages/flipdesk/nav-tabs.ts
  - src/pages/flipdesk/money-overview.tsx
  - supabase/migrations/00704_quickbooks_connection.sql
  - supabase/migrations/00705_quickbooks_sync_log.sql
  - services/edge-functions/src/lib/qbo-documents.ts
  - services/edge-functions/src/lib/qbo-sync.ts
  - scripts/check-qbo-sync.mjs
  - src/lib/qbo-mapping.ts
  - services/edge-functions/src/lib/qbo-client.ts
  - services/edge-functions/src/routes/qbo.ts
  - src/components/finances/tax-packet-card.tsx
  - supabase/migrations/00691_facilitator_sales_tax.sql
  - scripts/check-facilitator-tax.mjs
  - supabase/migrations/00693_form_1099k.sql
  - src/lib/form-1099k.ts
  - scripts/check-1099k-bridge.mjs
  - supabase/migrations/00695_mileage_log.sql
  - src/lib/mileage.ts
  - scripts/check-mileage-log.mjs
  - supabase/migrations/00697_home_office.sql
  - src/lib/home-office.ts
  - scripts/check-home-office.mjs
  - supabase/migrations/00698_estimated_tax.sql
  - src/lib/estimated-tax.ts
  - supabase/migrations/00699_books_review_queue.sql
  - src/lib/books-review.ts
  - scripts/check-books-review.mjs
  - supabase/migrations/00700_receipt_extraction.sql
  - services/edge-functions/src/lib/receipt-extract.ts
  - supabase/migrations/00701_bank_statement_import.sql
  - src/lib/statement-import.ts
  - scripts/check-statement-import.mjs
  - supabase/migrations/00702_period_close.sql
  - src/lib/period-close.ts
  - scripts/check-period-close.mjs
  - supabase/migrations/00690_inventory_writeoffs.sql
  - scripts/check-inventory-writeoffs.mjs
  - supabase/migrations/00692_keeping_leaves_inventory.sql
reviewed: 2026-08-30
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

### Leaving inventory without selling (US-3007)

A completed sale used to be the **only** exit. An item that was lost, damaged
beyond selling, donated, returned to a consignor or taken for personal use sat
in ending inventory for ever, overstating line 41, understating line 42 COGS,
and so overstating the profit the seller pays tax on. It is the rare bug that
costs the user money in the government's favour.

`00690` adds `inventory_items.removed_on` and `.removed_reason`. The **date** is
the load-bearing half: the snapshot predicate is date-based on purpose, so a
status flag alone cannot fix this - `archived` and `returned` already existed and
neither records *when*. A pair constraint refuses one without the other, because
a date with no reason cannot be routed to a line of the form and a reason with no
date cannot be read historically.

**Personal use takes a different route from the other four, and the form says
so.** Schedule C Part III line 36 reads *"Purchases less cost of items withdrawn
for personal use"*, so a withdrawal reduces **purchases**, in the period it was
withdrawn - which need not be the period it was acquired. The other four reasons
reduce **ending inventory** and flow through line 42.

**A write-off books nothing, and that is the decision.** No ledger entry is
written. Removing an item from ending inventory raises `variance_cents` by its
cost with no offsetting entry, so the worksheet reports `writeoffs_cents`
separately and adds `variance_after_writeoffs_cents`. **That** residual is the
figure that should read zero; `variance_cents` will not once anything has been
written off, and that is correct rather than a fault.

The alternative - booking an entry so the variance returns to zero - was
rejected because it makes the app decide a deduction. Personal use is not
deductible at all; a donation and a casualty loss go on different forms. Record
the reason, name what it feeds, and stop there.

**History is not rewritten.** The predicate change affects snapshots taken from
now on. Rows already taken record what was believed at the time; US-2995 (period
close) is the mechanism for correcting a closed year, with an adjusting entry in
the open period rather than an edit to history.

**The status a seller already sets is what records it (00692).** `item_status`
carried `keeping`, `wearing`, `returned` and `archived` all along, and
`constants.ts` even calls two of them "personal-use statuses" - they were
filtered out of the Kanban and not out of the books. A trigger derives the
withdrawal instead of asking the seller to say it twice.

**Only `keeping` leaves, and the obvious mapping is wrong in two places:**

| status | inventory | why |
|---|---|---|
| `keeping` | **leaves** | taken for personal use, so it reduces line 36 |
| `wearing` | **stays** | still stock; they are wearing it and will still sell it |
| `returned` | **stays** | a buyer sent it back, so it returns to stock |
| `archived` | **stays** | ambiguous - lost, damaged, donated or sold elsewhere - so the trigger will not guess |

⚠ **`item_status 'returned'` is not `removed_reason 'returned_to_consignor'`.**
They read alike and mean opposite things: the status is a buyer return (stock
comes back), the reason is goods handed back to a consignor (stock leaves).

A hand-set reason always wins. The trigger fills only a NULL reason and clears
only the `personal_use` it set itself, so an item recorded as lost stays lost
whatever its status does afterwards.

**The backfill dates existing `keeping` items from `updated_at`** - the owner's
call, because nothing in the schema records the transition itself. That is an
approximate date inside a tax figure, which is why it is said out loud here.

⚠ **`archived` still has no way in.** It is the one status the trigger cannot
resolve, so recording *lost* versus *donated* versus *sold elsewhere* needs a
prompt that does not exist yet. US-3007 stays open on that.

## Sales tax: two branches, and why net profit cannot tell them apart

`public.marketplace_facilitator_rules` (migration 00691) decides whether a
sale's tax was ever the seller's income.

- **Facilitator** (eBay, Poshmark, Mercari, Depop, Grailed, Etsy, Facebook,
  OfferUp, Whatnot, Vinted). The platform collected and remitted it. Booked to
  the excluded account, reaches no Schedule C line, still recorded because it is
  inside the 1099-K gross.
- **Seller-collected** (Shopify, and anything unknown). The seller IS the
  retailer. The tax is part of gross receipts (line 1) AND the remittance is a
  deduction (line 23). Two entries netting to zero — one figure alone would put
  the tax on the wrong side of the return.

> **NET PROFIT IS IDENTICAL ON BOTH BRANCHES.** $67.00 for every sale in the
> fixture. The bottom line cannot tell you the branch was chosen correctly.
> **Gross receipts can**: $100.00 on eBay against $108.25 on Shopify, and gross
> receipts is the figure a 1099-K is compared against. That is why this has a
> database check rather than an eyeball, and why the sabotage run flips 3 checks
> red while every net stays $67.00.

### The unknown-platform fallback is deliberate

No rule for a platform on a date means **seller-collected**. `sales.listing_id`
is `ON DELETE SET NULL`, so a sale can outlive its listing and have no platform
at all. Overstating income is a number the seller can dispute; understating it
is one the IRS disputes.

### It is a table because the answer changes

Facilitator law arrived state by state between 2018 and 2023, and platforms
change their handling. `is_facilitator_collected('ebay', '2019-06-01')` returns
false, which is the effective date doing its job.

**One recorded coarseness:** a single national `2021-07-01` start date is
coarser than the law. Fifty rows per platform would claim a precision `sales`
cannot support, since it carries no buyer state. The `state` column exists, is
nullable, and is seeded empty.

### `saleEntries()` takes no default for the branch

`facilitatorCollected` is a required parameter in `src/lib/ledger-math.ts`. A
default would pick the branch for a caller who never thought about it, which is
the whole class of bug this closes.

### The ledger fixture carries eBay listings on purpose

`scripts/fixtures/ledger-invariant.sql` gives its sales a listing. Without one
they take the conservative branch, the tax moves out of the excluded account,
and the fixture silently stops exercising the facilitator path it was written
for — while still reporting `variance 0`, because net does not move. Caught when
`excluded (sales tax)` dropped from $17.34 to $0.00 after 00691 landed.

## The 1099-K bridge

`public.form_1099k` holds what the seller received; `form_1099k_bridge(platform,
year)` walks from that number down to what the sales left them.

### Two things it gets right that are easy to get wrong

**A 1099-K is ALWAYS a calendar year.** It has nothing to do with the seller's
fiscal year. The function takes a YEAR and builds January-to-January bounds
itself. Comparing a calendar-year form against fiscal-year totals produces a
variance that is pure artefact, and a seller told to go and find it will not
find it.

**Computed gross is identical on both US-2987 tax branches.** A 1099-K counts
the buyer's payment, so it includes sales tax whether the marketplace collected
it (excluded account) or the seller did (inside `sales_revenue`). The function
adds the excluded account back in.

> **The sabotage is the clearest statement of why.** Removing the add-back drops
> eBay's gross from $118.24 to $109.99 while Shopify's stays at $118.24, so the
> variance reads **$13.25 — exactly the sales tax**. That looks like a real
> finding and would send every marketplace seller hunting for sales that were
> never missing. Seven checks catch it.

### The statement starts where the seller is

`bridgeRows()` begins at the figure on the form, not at our own total. Someone
opening this screen has the 1099-K in their hand and it is the number
frightening them. Every row names its source; `bridgeAddsUp()` checks the
visible arithmetic reaches the stated total before the screen asks anyone to
trust it, because a bridge that fails a calculator check destroys confidence in
every other number in the app.

**Overheads are deliberately absent.** They are business-wide and not
attributable to one platform. Splitting them here would invent a number, so the
final row says "before business-wide running costs" and points at the P&L.

### The variance gets named causes, and the sign changes them

A seller told only "there is a $412 difference" has no next action. `varianceCauses()`
gives a different list depending on which side is higher — missing sales and
cancelled-but-counted orders when the FORM is higher, hand-entered or duplicated
sales when OUR figure is. When the form's transaction count disagrees with the
sale count, that leads, because it settles instantly whether the gap is missing
sales or wrong amounts.

### The TIN is four digits, enforced

`payer_tin_last4` carries a CHECK for exactly four digits. A payer's full TIN is
a federal identifier this app has no use for, and a free-text field is how one
ends up in the database despite the column name.

## Mileage

`mileage_rates`, `mileage_trips` and `vehicle_use_years` (migration 00695).
Trips become ledger entries on the `vehicle_mileage` account, so the deduction
is on the P&L rather than in a second place.

### The rate is a dated table, and that is not over-engineering

The IRS rate changes every year and it has changed **mid-year**: 2022 ran at
58.5 cents to 30 June and 62.5 cents from 1 July. A constant cannot express
that, and a constant that is edited silently reprices every trip a seller ever
logged. Lookup is by trip DATE, so a corrected rate flows through and last year
cannot move.

### The unit is in the column name

`tenths_of_cent_per_mile`. Most published rates are not whole cents — 58.5,
62.5, 65.5 — so an integer `cents_per_mile` cannot hold them, and putting 585
in a column called cents means five dollars eighty-five a mile: an eight-fold
overstatement that looks plausible on a summary and absurd only on a big year.

### Two disclosures the number cannot make for itself

- **A trip with no rate for its date produces NO ENTRY.** A rate we do not have
  is not a rate of zero. The summary counts those trips so the screen can say
  the total is smaller than the log.
- **A provisional rate is used AND flagged.** The 2026 row is 2025's rate
  carried forward because the IRS notice was not out. Carrying it and saying so
  beats a silent zero and a silent guess. **Update that row when the real rate
  is published.**

### Rounding is PER TRIP, in both places

> **A one-cent bug, found by building the check rather than by reasoning.**
> `mileage_summary` first rounded once on the total while the ledger rounds per
> trip. Two 10.4-mile trips at 58.5 cents are 608.4 cents each: **1216 per trip
> against 1217 rounded once.** Reproduced on Postgres at 15498 against 15499.
> Rounding once is more precise in isolation and is the wrong answer here,
> because the ledger is the record and a seller who finds two of our own screens
> a cent apart stops believing both.

`npm run check:mileage` asserts the two routes agree, and reverting the rounding
reddens exactly that check.

### Part IV is asked, not derived

Business miles come from the log. Total, commuting and other personal miles
cannot be derived from a business-trip log — only the seller knows them — so a
blank stays a blank rather than becoming a zero. Zero commuting miles is a real
answer and printing 0 for a blank puts a claim on a form the seller never made.
`partIvConflict()` catches the parts adding up to more than the whole, because
four figures that contradict each other are worse on a form than three and a
question.

### Standard OR actual, never both

`vehicle_use_years.method` is per year, because the election is per year, and
the screen states it where the number is. On actual expenses the mileage figure
does not apply, and the card says so instead of showing a deduction the seller
cannot take.

## The home office

`home_office_rates` and `home_office_years` (migration 00697). Simplified method
only: square feet times a rate, capped, prorated by months used.

### Cap first, prorate second

400 sq ft for six months is **300 capped, then halved: $750**. Prorating first
and capping after gives **$1,000**. The order is the whole difference and both
answers look plausible on a screen, which is why it has a database check and a
sabotage that swaps it.

### It is line 30, and that changed the P&L

Schedule C keeps the home office OUT of total expenses: line 28 is expenses,
line 29 is profit before the home office, line 30 is the home office, line 31 is
what you are taxed on. **The P&L was folding it into line 28 until US-2990.** A
seller transcribing that subtotal would have overstated it by the whole
deduction. `pnl-statement.ts` gives it its own section now, and shows lines 29
and 30 only when there is a home office — on a statement without one, tentative
profit and net profit are the same number and printing both invites a seller to
wonder which one they are taxed on.

### The double-count guard reports rather than decides

The simplified method **already covers** the rent and utilities you would
otherwise apportion for that space. Claiming it alongside rent expensed
separately deducts the same room twice, and neither figure looks wrong on its
own — which is why `home_office_overlap()` is a query rather than a note.

It does not accuse. A seller with a home office and a genuinely separate storage
unit is fine, and the app cannot tell that apart from double-counting. It puts
both numbers side by side and says only the seller can tell.

### What is deliberately not built

Actual expenses. Form 8829 needs mortgage interest, insurance, utilities and a
basis calculation, plus depreciation recapture when the home is sold. Getting
that wrong is worse than not offering it, so `method = 'actual'` produces no
ledger entry and the card says why.

## The db-backed money checks run in CI

All six — ledger invariant, COGS worksheet, facilitator tax, 1099-K bridge,
mileage, home office — run in the `db-migrations` workflow and in
`node scripts/verify.mjs --db`.

> **They did not, for six stories, and the reason is worth keeping.** Each one
> argued in its own header that it was deliberately kept out of `verify` because
> "a lane that skips silently when the stack is down teaches everyone to ignore
> it". That argument was wrong: `check-session-revocation` and
> `check-inventory-writeoffs` have always been db-backed, in that lane, and
> skipped cleanly by the same Docker gate. Six copies of the same excuse
> accumulated in `guard-lane-parity.test.ts` — each added after the check failed
> an unrelated push days later — before the inconsistency was named. Moving them
> in removed **six** exemptions and added none.
>
> The lesson is not about these scripts. A guard that is argued for in a comment
> and never declared to the thing that enforces it is not a guard, and the
> second time you write the same excuse is the signal.

## Estimated tax

`tax_rate_years` and `estimated_tax_payments` (migration 00698), computed in
`src/lib/estimated-tax.ts`.

### The split between computed and assumed is the whole design

- **Self-employment tax is computed EXACTLY.** 15.3% on 92.35% of net profit,
  Social Security capped at the year's wage base, Medicare uncapped, plus the
  0.9% surcharge above a per-status threshold. The 92.35% factor is not a
  rounding fudge -- it is the deduction for the employer half, and omitting it
  overstates the bill by about 8%.
- **Income tax is NOT computed from brackets, deliberately.** It depends on the
  seller's whole return: a spouse's wages, a W-2 job, other deductions, credits,
  state tax. None of that is visible here. A bracket table would produce a
  confident number built on inputs we do not have, so the seller picks a rate
  and the screen names it as **their** assumption.
- **The safe harbour needs no projection at all.** 100% of last year's tax (110%
  above the AGI threshold) and the underpayment penalty does not apply however
  the year turns out. Offered beside the estimate, and the better target when
  last year's figure is known.

Where household income is unknown the **lower** safe-harbour multiplier is used:
claiming 110% of a number we cannot justify would overstate what is owed.

### Two details that are easy to get wrong

- **The deductible half excludes the 0.9% surcharge.** That surcharge has no
  employer match, so halving it into the income-tax deduction would overstate
  the deduction.
- **Income tax applies to profit LESS the deductible SE half.** It is the one
  adjustment simple enough to make without seeing the whole return.

### The four dates are not four quarters

April 15, June 15, September 15, and **January 15 of the FOLLOWING year**. The
second period covers two months and the fourth covers four. A seller who budgets
four payments inside the calendar year is short one in January. The instalments
are equal quarters of the year's tax; only the coverage is uneven, and
conflating the two puts the wrong amount in at the wrong time. Instalments round
UP, so paying the shown figure four times is never short.

### Payments never reach the ledger

Estimated tax is personal, not a business expense. A seller who deducted it
would understate their own profit and overstate the deduction, so
`estimated_tax_payments` is deliberately not wired into
`rebuild_ledger_for_user()`.

### The assumptions are part of the answer

An unexplained figure here is worse than none: a seller who cannot see what it
rests on cannot tell whether it applies to them, and will either over-save all
year or find out in April that it did not. `estimateTax()` returns an
`assumptions` array and the screen prints all of it -- which half is exact,
which is their guess, whether other household income was given, whether Social
Security has capped out, and whether the year's figures are provisional.

> **The 2026 row is PROVISIONAL and UNDERSTATES.** The Social Security wage base
> is carried forward from 2025 and rises most years, so a high earner's Social
> Security portion comes out low. Update it when the SSA announces the figure.

## Books health

`books_review_queue(from, to)` (migration 00699). Six checks, ordered by what it
costs to leave an issue alone rather than by how easy it is to fix.

### The silences are the design

Anyone can make a queue find problems. Three things it deliberately does NOT
flag:

- **A local cash sale with no fees.** Facebook and OfferUp genuinely charge
  nothing on a pickup, so a zero there is correct.
- **An expense under $75.** That is the IRS's own substantiation threshold;
  chasing a receipt below it costs more than it protects.
- **An item that has a cost basis.** Obvious, and it is asserted anyway, because
  the check that matters is the count: exactly six issues from the fixture, not
  seven.

> Sabotage-verified by removing both exemptions, which turns six issues into
> nine. **A queue that cries wolf gets ignored, and then the real issue in it
> goes unread too.**

### Where the impact is unknowable, it says so

A sold item with no cost basis overstates profit by whatever it cost — which is
exactly what nobody recorded. Inventing a figure would be the same mistake in a
different place. Instead the row carries an estimate from the seller's **own**
median cost-to-price ratio, labelled as an estimate wherever it appears
(`"about $80.00"`, never `"$80.00"`), and **null under five priced sales**,
because a ratio from two items is a guess dressed as a statistic.

Exact and estimated totals are reported **separately**. Adding a guess to a set
of measured figures and printing one total would make the whole thing look
measured.

### Dismissing is a record, not a hide

A reason is required, the row is kept with its date, and there is **no UPDATE
policy**: editing a recorded reason after the fact turns the record into
whatever the last edit said. Undismiss and dismiss again.

### The badge is scoped to the current year

A badge counting every issue since the account opened is a number nobody can
ever clear, and a badge that never reaches zero stops being read.

**Not built: the sidebar badge.** AC5 asked for the count on the Money nav. It
is on the Money tab strip, visible the moment Money opens, but the shared
sidebar has no badge mechanism at all and adding one touches navigation every
section uses. Recorded rather than quietly counted as done.

## Reading a receipt

`receipt-extract.ts` in the edge service, behind
`POST /api/flipdesk/expenses/extract`.

### The model proposes; it never writes

A wrong number the seller did not look at is worse than no number, because they
will not check it again. Every field arrives editable and nothing is saved until
Save is pressed. On an EDIT the photo is attached without rewriting anything:
the seller already has their figures and is only adding proof.

### The photo is staged before the model is called

`{ownerId}/_staging/...`, uploaded first, so a model timeout does not lose the
photo somebody just took at a till. On confirm it is MOVED onto the new expense
rather than uploaded again.

> **The staging prefix check is the security boundary, and it is the one an
> ownership test misses.** `adopt-staged` loads the expense scoped to the owner
> — and then takes a PATH from the request body. Without the
> `${ownerId}/_staging/` prefix check, a seller could name another tenant's
> staged receipt and have it copied onto their own expense, with every id in the
> request legitimately theirs. `tenant-isolation_test.ts` covers both halves.

### Confidence is per field

A receipt can have a crisp total and an illegible date. One aggregate number
would hide exactly the field worth checking. The threshold is **0.75**,
deliberately the same as the grading pipeline's human-review threshold: two
different numbers for "not sure enough" in one product is one number nobody can
explain.

**A field the model produced nothing for is not flagged.** It shows as an empty
input, which already says everything a warning would.

**A null value forces its confidence to 0**, whatever the model claimed. The
specific failure this guards is a model returning `null` and `1.0` together,
which would show a seller an empty box marked as certain.

### The parser is tested against wrong output, not right output

Twenty cases over totals with currency symbols, dates in the wrong century,
invented categories, prose wrapped around the JSON, and outright refusals.
Testing only well-formed replies would test the prompt, and the prompt is not
what breaks at 2am. Every failure path returns nulls plus a warning the screen
shows: a spinner that ends in an empty form teaches the seller the feature is
broken.

### Line items are captured but not yet used

Thrift receipts describe things uselessly — "MENS SHIRT", "RED ITEM" — so
matching on description is hopeless. The **prices** are the useful part: a
receipt with six lines totalling $47.83, photographed on the day six items were
added, carries six real cost bases. `linesReconcile()` reports whether the lines
add up to the total less tax, because a partially-read receipt would allocate
the wrong cost to every item. The matching itself is **US-3012**, and it attacks
the worst issue in the review queue.

### Provenance, and why the prompt version is on the row

`extraction_prompt_version` is stored on every expense the model produced. A bad
prompt release has to be traceable to the entries it made, and without the
version the only way to find them is to guess at dates. **Bump
`RECEIPT_PROMPT_VERSION` whenever the prompt text changes.**

`extraction_proposed` keeps what the model said before the seller touched it,
which is the only way to tell an accepted extraction from a corrected one — and
therefore whether the prompt is any good.

### Duplicate detection asks, it does not block

A function, not a unique constraint. Two coffees from the same shop on the same
day for the same price is a real thing, and refusing it would be wrong. It
matches amount, a day either side (a card statement and a receipt disagree by
one often enough), and description; the warning appears once and pressing Save
again goes through.

### Spend attribution is automatic

`enterAiFeature("receipt-extract", userId)` at the top of the call. The limiter
wrapper in `ai-config.ts` records model, tokens, latency and cost to
`ai_usage_events` from there, so it appears in admin-ai-spend with no per-call
bookkeeping.

## Bank and card CSV import

`statement_sources` and `statement_rows` (migration 00701), parsed by
`src/lib/statement-import.ts`.

**No live feed.** That means Plaid, a paid dependency and a decision this story
does not get to make. A CSV is most of the value: every bank exports one.

### The statement row never mutates an expense

`matched_expense_id` is a LINK, recorded and reversible. Matching writes to the
STATEMENT ROW only -- not even to correct an amount that differs. An import that
rewrites a figure the seller typed is how a bookkeeping tool silently disagrees
with the person using it, and the person always loses, because they do not know
it happened. Where the two disagree the screen asks.

### Idempotency keys off the ROW

`row_fingerprint` is date + amount + normalised description: the three things
that do not change between two exports of the same period. NOT the line number,
which shifts the moment the bank reorders. NOT the import run, which would
duplicate every overlapping row.

**Re-exporting an overlapping range is the NORMAL case** -- sellers widen the
range when they think something is missing -- so it has to be a no-op rather
than an error.

### One expense cannot satisfy two statement lines

`match_statement_row` excludes any expense already linked to another row.

> Sabotage-verified: removing that exclusion offers a matched expense to a
> second statement line. **Two lines for one expense IS the double payment a
> bank import exists to catch**, so offering it would hide the thing the feature
> was built to find.

### Parsing is pure, and the failure modes are all in it

Every bank exports a differently shaped file, so `splitCsvLine`, `parseMoney`,
`parseStatementDate` and `parseStatementCsv` take strings and return values, with
25 cases over the shapes that actually arrive: quoted descriptions full of
commas, `(24.99)` accounting notation for a negative, `$1,234.56`, separate
Debit and Credit columns, CRLF, day-first dates.

**A malformed line is SKIPPED WITH A REASON**, not dropped and not imported as
zero. A silent drop is how an import misses the one transaction the seller was
looking for, with no way for them to know.

> **A float bug I had already fixed once and reintroduced.** `parseMoney` first
> used `Math.round(n * 100)`, which is wrong on exactly the values that look
> safest: `1.005 * 100` is `100.49999999999999`, so it rounds DOWN and loses a
> cent. `toCents()` in `ledger-math.ts` exists precisely to avoid that, written
> for US-2984. The test caught it. **One converter, not three** -- `parseMoney`
> now delegates.

### Only money leaving is an expense candidate

Amounts stay SIGNED as the statement had them. A refund on a card statement is a
real positive row, and flattening it to a magnitude would make a return look
like a purchase.

## Closing a period

`closed_periods` (migration 00702). Once a return is filed, that year's figures
are a matter of record; before this, editing an item's cost silently rewrote a
P&L for a year already reported and nothing said so.

### Triggers, not RLS, and that is the whole difficulty

The edge uses the **service-role client, which bypasses RLS**. A policy-based
lock holds against the browser and lets every route, job and webhook straight
through -- and those are precisely the paths that rewrite history unwatched. The
guard is a `BEFORE` trigger, which fires for the service role too.

**Every refusal in `check-period-close.mjs` is tested as `postgres`**, the most
privileged role available. A guard that only stops the browser stops nothing
that matters.

### What is NOT locked matters as much

Shipping, tracking, delivery, status, titles, photos, measurements, listings.
A buyer can open a return in February on a December sale, and refusing that
write would break the marketplace sync rather than protect the books. **A lock
that blocks real work is a lock that gets switched off**, so only the columns
that move a filed number are frozen:

- an expense's amount or date, and deleting one, and backdating a new one in
- a mileage trip
- a sale's price, fees, shipping, tax, date or status
- an item's `acquired_price` **if it sold in a closed period** -- an unsold
  item's cost has reached no return yet

### Closing takes the snapshot, in that order

`close_period` calls `take_inventory_snapshot` **first**, while writes are still
allowed. Closing before snapshotting would lock the very table the snapshot
reads and leave the period closed with no Part III figures -- the exact state
US-2986 exists to prevent.

It also records `closing_figures`: the ledger reconciliation and COGS worksheet
as they stood, so a later recomputation can be COMPARED against what was filed
rather than silently replacing it.

### Reopening keeps the row

`reopened_at` is set; the row is never deleted. **A period closed and reopened is
a different fact from one never closed**, and that difference is what an
accountant asks about. A reason is required by a CHECK constraint, so it cannot
be skipped by any caller.

> **A design bug caught by running it, not by reading it.** Both functions were
> SECURITY INVOKER first, so their INSERT hit a table with no INSERT policy and
> closing could never have worked. The fixture failed immediately with
> `new row violates row-level security policy`. They are SECURITY DEFINER with
> in-body auth checks now -- the same shape as 00686, and with no REVOKE.

## The year-end packet

US-2996. One download, and the seller stops assembling a pile of numbers from
four screens in March. `src/lib/tax-packet.ts` is the whole thing and it is
pure: `packetWarnings()`, `scheduleCRows()`, `buildPacketCsv()` and
`PACKET_EXCLUSIONS`. The card (`src/components/finances/tax-packet-card.tsx`)
fetches, the library formats, and 22 tests cover the formatting without a
database.

**It re-derives nothing.** Every figure comes from the statement, the COGS
worksheet, the bridge, the mileage summary and the home office computation as
they already exist. `scheduleCRows()` reads `statement.netProfitCents` rather
than adding the rows back up. A packet that recomputed anything would be a
fifth place a number could disagree with itself, which is exactly what US-2984
existed to stop.

**Zero detail lines are dropped; zero SUBTOTALS are not.** An expense account
with no activity is noise. "Line 2, returns and allowances, 0.00" is not: leave
it out and line 3 appears to come from nowhere, and the accountant has to work
out whether a line was omitted or a number was lost.

**Costs print positive under a subtracted heading.** The form asks for `2,340`
on line 10, not `-2,340`. Income keeps its sign; every expense row is
`Math.abs()`. This is a presentation rule, not a maths one, and it lives in
`scheduleCRows()` so nothing downstream has to know it.

### AC3 asked for something that cannot exist

> "Receipts included or linked, with the link surviving longer than the
> 900-second signed URL."

It cannot. `submission-images` and the receipts bucket are PRIVATE under US-276,
signed URLs are capped at 900 seconds, and a test fails closed on anything
longer. Raising the cap to serve a tax packet would trade a real security
property for a convenience.

So **the packet contains the receipt files, not links to them.** Each receipt
gets a fresh signed URL, is fetched immediately, and the bytes go into the zip
under `receipts/{date}_{description}_{amount}.{ext}`. The URL never leaves the
function. A file in a folder outlives any URL, which is what the requirement
was actually asking for.

One unreadable receipt does not lose the packet -- the loop swallows the error
and the cover states how many were expected, so a shortfall is visible rather
than silent.

### The PDF is a print, not a generator

AC2 wants "a PDF to read". There is no PDF library in this bundle and adding
one to lay out a table would cost a few hundred KB for something the browser
already does. The packet writes a print-styled HTML page (`buildPacketHtml`,
inline CSS, `@media print`) into the zip AND offers a button that opens it and
calls `window.print()`. Every browser writes that to PDF. This is the repo's
existing answer -- `cert-share-actions.tsx` prints the certificate the same way.

### Warn, then produce it anyway

AC6, and it is the rule that makes the feature usable. A packet built on a year
with gaps still ships; the caveats go on the **cover**, ahead of the numbers,
because an accountant who reads the figures first has already believed them.
`packetWarnings()` returns every warning at once rather than the first, and the
caveat block is omitted entirely when there is nothing to say -- a "no issues"
banner on a clean year trains people to skip the block on a bad one.

A missing 1099-K is deliberately **not** a warning. It is not a discrepancy, and
warning about it would teach the seller to ignore the warnings that matter.

### What it says it does not contain

`PACKET_EXCLUSIONS` is on the card, in the CSV and in the HTML. State tax,
self-employment tax, depreciation and Form 4562, Form 8829 (only the simplified
home office is computed), and the honest one: **anything never recorded in
GradeThread is not here.** An accountant who assumes state tax is in the packet
finds out late; naming the gap is worth more than another number.

## QuickBooks Online: the connection and the mapping

US-2997, and it deliberately moves NO transactions. That is US-2998. A sale
posted into the wrong QBO account is a mess an accountant unpicks by hand and
QuickBooks has no undo for a bulk sync, so the mapping gets its own screen and
its own sign-off first.

### It is not on `marketplace_connections`, and that was a decision

The OAuth shape is copied exactly from `flipdesk-ebay.ts`: AES-GCM tokens with
the owning user id as the AAD, a single-use state row deleted-and-returned at
the callback, lazy refresh on use with an hourly sweep behind it, and a
permanent-versus-transient split on failure. Only the TABLE is separate.

`marketplace_connections.marketplace` is the `listing_platform` enum. Adding
"quickbooks" to it would put an accounting connector into every platform
dropdown, every platform breakdown and every "which marketplaces am I on" count
in the app, for a row that can never hold a listing. Three new tables in
migration 00704 instead: `qbo_connections`, `qbo_account_mappings`, and the
deny-all `qbo_oauth_states`.

### The realm is the point

A QBO connection is to ONE company file, named by its realm id. Every call is
scoped by the realm stored on the connection row, and the realm is **never read
from a request body** -- that is precisely how a seller with a personal file and
a business file gets a sale in the wrong one. It arrives once, on Intuit's own
callback, alongside a state token only this server minted.

Sandbox and production are different company files and nothing ever falls back
between them. The environment is part of the row, part of the unique key, and on
the screen at all times, because pushing test data into a real file cannot be
undone.

### The 100-day clock

QBO access tokens last an hour. The refresh token is the one that matters: it
**rotates on every use** and dies after 100 days of disuse.

Rotation is the dangerous half. The old refresh token is invalid the instant the
new one is issued, so if the write fails after the network call succeeded, the
stored token is already dead. `authFromRow` writes it immediately and, on a
failed write, raises "connect it again" rather than returning a token whose
refresh partner is lost.

Expiry is the quiet half, and AC6 is about it: a silent stop is how a seller
discovers in March that nothing has synced since November. The hourly sweep
checks `refresh_token_expires_at` BEFORE trying, so the reconnect prompt appears
while the seller can still act. A permanent failure clears `is_active` and
writes the reconnect wording where the status card reads it; a transient one
stores the message and leaves the connection alone, because treating an Intuit
503 as a disconnect is the mirror-image mistake.

### The mapping, and why absence is meaningful

`src/lib/qbo-mapping.ts` is pure and takes a chart of accounts someone else
fetched. `proposeMapping()` tries QBO's `AccountSubType` (precise), then a name
contains (weak, and labelled weak), then the `AccountType` -- and the type stage
fires **only when exactly one account in the file has that type**. A chart with
eleven Expense accounts cannot tell travel from utilities, and proposing
whichever came back first is how a seller's meals land in insurance.

Two rules the tests found rather than the design:

- **Candidates are filtered to the right side of the books before any guessing.**
  Without it, the name stage matched "postage" against "Shipping Income" -- a
  revenue account for an expense -- and `validateMapping` then rejected the
  suggestion the same screen had just made. A proposer and a validator that
  disagree are two rules, and the seller has to work out which one is real. An
  invariant test now runs both over several charts and asserts they never
  disagree.
- **Ties are broken deterministically** (by name, then id). QBO returns accounts
  in whatever order its query felt like, and a proposal that depends on that
  order changes under the seller between one screen and the next.

Four accounts are **never mapped**, and the screen says so with the reason
rather than leaving a blank row: mileage and the home office are worked out on
the return, so pushing them would deduct the same thing twice; the two inventory
balances are QuickBooks' own, so pushing ours would count the same stock twice.

An unmapped account **blocks its own push and nothing else** (AC4). A seller who
has never paid for advertising must not be stopped from syncing by an empty
advertising row, and the message says the rest still goes -- otherwise it reads
as a stop.

Validation runs against the LIVE chart, not against what we proposed last week:
an account can be deactivated, merged or deleted in QuickBooks in between, and
the one check worth doing beyond existence is income pointed at an expense
account. That is the mistake that looks fine on the mapping screen and shows up
as a negative profit in March.

### Env, and the fact that none of it is on

`QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI` and `QBO_ENVIRONMENT`
are all new and all optional. Unset -- which is the state today -- every route
answers 503 and the card says QuickBooks is not switched on for this server.
The redirect URI must match the Intuit app exactly, scheme and trailing slash
included; Intuit's rejection does not say which part is wrong.

### The guard that had to be fixed before it guarded anything

`/api/flipdesk/qbo/*` is deny-by-default under one `qboAuthMiddleware` mount,
with two named exemptions. The first version of `qbo-auth-coverage_test.ts`
checked those two by name -- so a THIRD exemption added for an existing route
(`/mappings`, say) passed every assertion: the key matched a declared route, the
forward and reverse checks agreed with each other, and nothing ever asked what
replaced the session. That sabotage was run and came back green. It now
iterates every exemption and requires a mechanism to be visible in the handler,
with a self-check proving an ordinary route shows none.

## Pushing to QuickBooks

US-2998. One way, GradeThread to QuickBooks, and the screen says so twice.

### The ledger is the source, not the sales table

`qbo_pending_documents()` groups `ledger_entries` by `source_id`, which puts a
sale's revenue, shipping income, fees, label, grading and cost of goods into
ONE document. Grouping by anything else -- `source_kind`, say -- produces five
unrelated receipts in QuickBooks for the same jacket, and no test that mocks the
database would notice. That is what `scripts/check-qbo-sync.mjs` exists for, and
the sabotage was run: adding `source_kind` to the GROUP BY turns three documents
into six and the check fails on seven assertions at once.

Reading the ledger rather than the sales table is also what keeps QuickBooks and
the P&L from disagreeing about what a sale was worth. There is one set of
numbers.

**Cost of goods rides on the sale (AC4).** It is already dated at the sale in the
ledger, so this falls out for free -- but it is the reason gross profit in
QuickBooks equals gross profit here. Push it at purchase time and the two move a
month apart and never reconcile.

**Facilitator sales tax is out of the total and named in the note.** It was never
the seller's money, so booking it as income overstates revenue; leaving it out
entirely leaves an accountant staring at a $180 receipt against a 1099-K showing
$194.87. The RPC returns it as `excluded_tax_cents` and the document carries a
sentence saying what the gap is.

### Idempotency, and the four ways it breaks

The rule is READ THE LOG, THEN WRITE. `qbo_sync_log` holds one row per pushed
object keyed on `(user_id, object_kind, source_id)`, with the QuickBooks id it
became and a hash of the payload as last accepted.

- **Keyed on the SOURCE, never on a ledger entry.**
  `rebuild_ledger_for_user()` deletes and re-inserts every entry, so an entry id
  changes on every rebuild. A key built on one would duplicate the seller's
  entire history the first time they rebuilt.
- **A lost log asks before it creates.** The DocNumber is deterministic
  (`GT-S` + the first 16 hex digits of the source id, which fits QuickBooks' 21
  character cap), so a restored backup queries for the document and finds it.
  Without that branch, one database restore duplicates everything.
- **A failed push KEEPS the id.** Clearing it on failure is how one bad night
  becomes permanent duplication.
- **An unchanged payload is skipped, not re-sent.** That is what makes a nightly
  re-run of three years cost a query per document instead of a write.

`qbo-sync_test.ts` runs the same push twice against an in-memory QuickBooks and
counts the objects, which is AC5 stated as a test rather than as a claim. The
other four cases above each have their own.

### Bounded and resumable

Forty documents a batch, with `qbo_sync_runs.cursor_date` as the bookmark; the
browser loops while `done` is false. The cursor resumes ON its date rather than
after it, because several documents can share a date -- and an overlapping
resume is free, since the log turns a repeat into a skip. A bookmark slightly
behind costs a few skips; one slightly ahead would lose a sale.

### What blocks, and what does not

An unmapped account blocks its own documents and nothing else, and the log row
says which account. One failed document does not stop the ones behind it -- a
run that abandons everything after the first rejection turns one bad sale into a
year of missing books. A receipt that will not attach does not fail its expense:
an expense in QuickBooks without its receipt is a correct expense, and a push
that aborts on a 10MB image is a lost one.

### The sync token is a feature

QuickBooks rejects an update carrying a stale `SyncToken` rather than
overwriting. That is the behaviour we want: a token we no longer hold means
somebody edited the document inside QuickBooks, and this sync is one way. The
failure is recorded with QuickBooks' own words, which name the field -- AC6 is
about that sentence, because "sync failed" with no object named is not something
anyone can act on.

## Money, and why it is three groups

US-2999. Money was five flat tabs and this epic added seven more surfaces to it.
Eleven peers in one row is not an information architecture, it is an accretion,
and the fix had to be decided once.

**Three groups, in the order a seller uses them.** `MONEY_VIEW_GROUPS` in
`src/pages/flipdesk/nav-tabs.ts` is the declaration, and the desktop strip, the
mobile picker and the test all read it -- so a view cannot fall out of the nav
while still resolving from a URL, which is the failure mode a hand-maintained
strip invites. A test asserts the groups cover `MONEY_VIEWS` exactly, with no
gaps and no repeats.

- **Overview** - the four questions, answered on arrival. The default.
- **Day to day** - Trends, Expenses, Reconcile.
- **Tax** - P&L, Deductions, Tax & filing.

**The default moved from `finances` to `overview`.** Every retired path carries
an explicit `?view=`, so no bookmark changed meaning -- and a test now asserts
each of those values is still a declared view, because a rename would silently
send `/dashboard/finances` to the fallback and nothing would fail.

### The overview leads with what can be acted on

Set-aside and the review count come first and are set larger. Profit and spend
sit under them. That ordering is the whole point: the first two are things a
seller can do something about today, and the second two are the answer to "how
did it go", which is worth knowing and cannot be acted on. Four identical cards
in a grid would say all four matter equally.

Emphasis is weight, size and a tinted border -- never a gradient, and never a
border under a wide shadow. Elevation is declared once per card.

### Mileage and the home office moved out

They were positions six and seven of a nine-card stack on the tax page, under
the packet and the QuickBooks mapping. Everything else on that page is a March
job; those two are recorded during the year, and buried there they were
effectively invisible. They have their own **Deductions** view now. Both stay
calendar-year surfaces: mileage rates are published per calendar year and the
Part IV questions are asked per calendar year, so a fiscal-year selector would
be actively wrong.

### The mobile layout is a picker, not a scrolling strip

Seven tabs in a row on a phone is a horizontal scroll where the tab you want is
off-screen with no sign it exists. Below `sm:` the strip is replaced by a native
grouped `Select`; both render from the same `MONEY_VIEW_GROUPS`.

### What could NOT be checked, and the evidence

AC3 asked for the new pages to be scanned with `scripts/check-ui-browser.mjs`.
**That tool cannot reach any screen behind a login** -- it scans nine public
marketing URLs, and an authed route on a dev server redirects to the sign-in
page. A harness to render authed screens to static HTML was built and then
REMOVED rather than shipped, because it could not pass its own self-check.
Three measurements worth keeping, so the next attempt does not repeat them:

1. `vite.transformRequest("/src/index.css")` returns the **HMR JavaScript that
   injects** the CSS, not the CSS. Inlined into a `<style>` tag it is inert, so
   every page renders unstyled and every rule that reads a computed style comes
   back clean. `?direct` is required. A deliberate nested card was added to
   prove the harness worked and the scan still reported zero.
2. Even with real Tailwind CSS inlined, a page built from the app's components
   reported **zero** findings while a hand-written page with an explicit border
   and shadow on the same server reported three, including `nested-cards`.
3. Inlining the whole app stylesheet raises `gradient-text`, `bounce-easing`
   and `dark-glow` from utility **definitions the page never uses**.

`npm run ui:check` is at zero, which is the half of AC3 that a source scan can
answer. The rest is **US-3013**.

## Splitting a receipt across the items it bought

US-3012, the owner's idea, and it attacks the single worst issue in the books
health queue: items sold with no cost basis. Those overstate profit by exactly
the figure nobody recorded, and US-2992 can only ESTIMATE the damage from the
seller's median cost ratio.

**The prices are the useful part, not the descriptions.** A thrift receipt says
"MENS SHIRT", "RED ITEM", "CLOTHING 2.99". Matching a line to an item on its
description is hopeless and always will be. But a Goodwill receipt with six
lines totalling $47.83, photographed on the day six items were added, carries
six real cost bases -- all that is missing is which price goes with which item,
and that is a question a person answers in fifteen seconds and a computer
answers badly. So nothing here guesses. `src/lib/receipt-allocation.ts` arranges
what the seller says into an allocation that is arithmetically honest, and
refuses in the two cases where an allocation would be worse than none.

### It refuses when the lines do not reconcile

`linesReconcile()` returns total less tax less the sum of the lines. Anything
outside two cents means a line was NOT READ, and a split built on it puts a
wrong cost on every item. An honest gap is recoverable; a confident wrong number
is not, because nobody re-checks a field that is already filled in. The
whole-total path stays available, because that number was read.

Two cents rather than zero: a vision model can be a cent out on a rounding line,
and refusing over one cent sends sellers back to typing. A missed LINE is
dollars, not cents, so nothing real hides under the tolerance.

### The leftover is one expense, never smeared

A bag fee spread across six items makes every cost basis slightly wrong AND
untraceable -- the seller can never work out afterwards which part of a price
was really the bag. It becomes one `flipdesk_expenses` row on category `other`,
which maps to the ledger's `uncategorised` account and therefore reaches no
Schedule C line. That puts it in the review queue, which is exactly where a
thing nobody has decided about belongs.

### The even split distributes its cents

$1.00 across three items is 34/33/33, never 33/33/33. Dropping the cent loses it
from a cost basis silently, and a total that reconciled on the receipt stops
reconciling in the books. The extra cents go to the earliest items, so re-running
gives the same answer.

### One column, and it is the one the ledger reads

Setting a cost basis writes `inventory_items.acquired_price` and nothing else.
US-2984's ledger derives cost of goods from that column, so an allocation stored
anywhere else would produce a P&L that disagrees with the item page about the
same jacket. Items fixed this way drop out of the US-2992 review queue on the
next load for free, because that branch is keyed on the same column.

Writes go item by item rather than as one bulk upsert: a failure then names the
item it belongs to and the ones that worked stay written. A seller who has just
assigned six lines by hand should not lose five of them to the sixth.

### Where it is offered

In the expense dialog, under the form, with the receipt still in hand and the
lines on screen. That is the only moment the seller knows which shirt was $2.99;
an hour later they do not, and the item keeps its honest gap for ever. Optional,
so a seller who only wanted to log the expense is not made to do this.

## Where the rest of the epic is written down

The child stories carry the detail while they are open; each closed story folds
its contract into this note. Currently landed:

- **US-2982** - the tax profile and the fiscal year, above.
- **US-2983** - the chart of accounts and its Schedule C mapping, above.
- **US-2984** - the ledger, its limits and its invariant, above.
- **US-2985** - the P&L statement and the half-open period rules, above.
- **US-2986** - COGS, the inventory snapshot and its two signals, above.
- **US-2987** - the two sales-tax branches and the facilitator registry, above.
- **US-2988** - the 1099-K bridge and its variance causes, above.
- **US-2989** - mileage, dated rates and the per-trip rounding rule, above.
- **US-2990** - the home office, line 30 and the double-count guard, above.
- **US-2991** - estimated tax, and what it refuses to guess, above.
- **US-2992** - books health, and the three things it stays quiet about, above.
- **US-2993** - receipt extraction, its confidence rules and its staging boundary, above.
- **US-2994** - the bank CSV import and its two idempotency rules, above.
- **US-2995** - period close, and why the lock is a trigger, above.
- **US-2996** - the year-end packet, its receipts-not-links answer and its exclusions, above.
- **US-2997** - the QuickBooks connection, the realm rule and the mapping, above.
- **US-2998** - the push, its four idempotency failure modes and the bookmark, above.
- **US-2999** - the Money structure, and what the UI scan could not reach, above.
- **US-3012** - splitting a receipt across items, and the two refusals, above.
- **US-3007** - leaving inventory without selling, above (data layer only).

Still open: mileage and receipts on mobile (US-3000), where Android is complete
and iOS has neither feature. US-3013 carries the authed-UI scan this note
describes as unbuilt.
