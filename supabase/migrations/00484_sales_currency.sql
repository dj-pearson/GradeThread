-- US-2031: record the sale's currency so a non-USD sale can be REFUSED.
--
-- consignor-payout.ts hardcodes currency 'usd' with Math.round(amount * 100).
-- That was self-consistent only because `sales` had no currency at all — the
-- assumption was invisible rather than checked. The moment a seller connects a
-- UK or EU eBay account, a GBP 120 sale transfers as USD 120 with no error:
-- wrong amounts, silently, in the direction of overpaying the consignor.
--
-- THIS IS NOT A MULTI-CURRENCY MIGRATION, deliberately. The story's own AC
-- warns that a half-migrated currency model is worse than an explicit
-- single-currency one, and that is right. This column exists so the payout path
-- can DETECT a non-USD sale and decline it loudly. No other money path learns
-- about currencies, and no amount is converted anywhere.
--
-- NULLABLE ON PURPOSE, with no backfill. NULL means "the marketplace never told
-- us" — every sale written before this shipped, plus any ingest path that does
-- not report one. Those are treated as USD, exactly as they always have been.
-- Defaulting to 'USD' instead would fabricate a fact we do not have and make a
-- genuinely-unknown currency indistinguishable from a confirmed-USD one.

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS currency text;

COMMENT ON COLUMN public.sales.currency IS
  'ISO currency the marketplace reported for this sale (US-2031). NULL = not reported; treated as USD. A non-USD value causes the consignor payout to be REFUSED rather than paid as dollars — GradeThread is explicitly single-currency and this column is the guard, not the start of a multi-currency model.';

insert into public.applied_migrations (version) values ('00484') on conflict do nothing;
