-- US-2790: what the parcel estimator predicted, kept beside what eBay charged.
--
-- The estimator's weights and multipliers are SEEDED, not measured. They are
-- roughly right and individually unproven, and the only thing that turns a
-- seeded table into a measured one is comparing predictions against outcomes.
-- The outcome half already exists: the payout sync writes the real figure to
-- sales.shipping_cost. This column is the other half.
--
-- ONE COLUMN ON sales, NOT A NEW TABLE. The row it belongs to already exists,
-- the comparison is always per sale, and a join table would add a lifecycle
-- (orphan rows when a sale is deleted) for a value that has no life of its own.
--
-- THE TABLE VERSION TRAVELS WITH THE PREDICTION, and that is the part most
-- likely to be dropped as redundant. Without it a correction cannot be
-- attributed: a row predicted under parcel_v1_seeded and a row predicted after
-- someone tunes the multipliers are not comparable, and averaging them makes
-- the error look smaller than it is on both. The version is what lets a future
-- reader throw away the rows that no longer describe the current table.
--
-- NULLABLE, NO BACKFILL, NO DEFAULT. Every existing sale predates the
-- estimator, so there is nothing to write for it, and inventing a prediction
-- for a shipment that already happened would poison the exact comparison this
-- column exists to make. NULL means "not predicted", which is true.
--
-- WRITTEN BY THE RATES ROUTE at pre-fill time, not at label purchase: the
-- prediction is the number the seller was shown when deciding, and a value
-- captured later would record what we would say NOW rather than what we said
-- THEN. A seller who corrects the pre-filled parcel is a second and faster
-- signal, and it arrives before the label is bought.

alter table public.sales
  add column if not exists predicted_parcel jsonb;

comment on column public.sales.predicted_parcel is
  'US-2790: the parcel estimator output at rates pre-fill time - weightOz, '
  'billableWeightOz, pack, confidence, basis - plus the estimator table '
  'version it was produced by. NULL means no prediction was made (every sale '
  'from before the estimator, and any sale where the garment had nothing to '
  'estimate from). Compared against sales.shipping_cost, which the payout sync '
  'writes with what the carrier actually charged.';

-- Only rows that HAVE a prediction, which is the only set any comparison reads.
-- A full-table index would be mostly NULLs on a table that grows with every
-- sale.
create index if not exists idx_sales_predicted_parcel
  on public.sales ((predicted_parcel ->> 'tableVersion'))
  where predicted_parcel is not null;

insert into public.applied_migrations (version) values ('00649') on conflict do nothing;
