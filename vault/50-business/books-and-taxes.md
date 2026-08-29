---
title: Books and taxes
type: contract
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00683_tax_profiles.sql
  - src/lib/tax-profile.ts
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

## Where the rest of the epic is written down

The child stories carry the detail while they are open; each closed story folds
its contract into this note. Currently landed:

- **US-2982** - the tax profile and the fiscal year, above.

Still open, and each will add a section here rather than a new note: the chart
of accounts and its Schedule C mapping (US-2983), the ledger and its
one-number-is-one-number invariant (US-2984), COGS and the ending-inventory
snapshot (US-2986), facilitator sales tax (US-2987), the 1099-K bridge
(US-2988), the dated mileage and home-office rates (US-2989, US-2990),
estimated tax (US-2991), period close (US-2995) and the QuickBooks account
mapping (US-2997, US-2998).
