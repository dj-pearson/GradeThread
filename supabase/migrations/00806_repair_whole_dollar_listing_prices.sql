-- Repair Poshmark and Vinted rows priced in cents those marketplaces cannot
-- hold (US-3318).
--
-- Poshmark and Vinted both price in WHOLE DOLLARS. Until US-2736 and US-2739
-- landed, every non-eBay channel was priced from the shared eBay number with
-- no rounding, so a sibling row recorded 32.49 for a listing the marketplace
-- can only hold at 32, and a 40-cent item was recorded at 0.40 against a
-- floor of 1.00. Those two stories fixed what the extension TYPES and what a
-- new push RECORDS. Neither repairs a row already written, and the row is
-- what profit, payout reconciliation and the revise price all read -- so the
-- revise path would have typed the stored number back at the marketplace.
--
-- THE RULE IS stepPriceCents, NOT A NEW ONE. src/lib/marketplace-price.ts is
-- the single home of the units rule and this is the same arithmetic in SQL:
-- work in integer cents, round to NEAREST (flooring quietly costs the seller
-- money on every row), and never land below one step. The two are pinned
-- against each other by src/test/whole-dollar-price-repair.test.ts, which
-- reads the worked examples below out of THIS FILE and asserts stepPriceCents
-- returns the same answer. round() on a positive numeric is half-away-from-
-- zero and Math.round is half-up; every price here is positive, where the two
-- agree, and the test covers the .5 boundary in both directions.
--
--   stored    cents   stepped   dollars   why
--   32.49      3249      3200     32.00    nearest, rounds down
--   32.50      3250      3300     33.00    nearest, .5 rounds up
--   31.50      3150      3200     32.00    nearest, .5 rounds up
--   0.40         40       100      1.00    below the floor, never $0
--   0.01          1       100      1.00    below the floor
--   25.00      2500      2500     25.00    already whole, untouched
--
-- ONLY POSHMARK AND VINTED. They are the two platforms declaring priceStep 1
-- in src/lib/marketplace-specs.ts. Depop's absence is deliberate and explained
-- there; mercari, grailed and facebook are unconfirmed against a live form,
-- and guessing one is the mistake this story's own notes record.
--
-- listing_price AND platform_fields MOVE TOGETHER, in one statement set. A row
-- whose two copies disagree is worse than one that is merely wrong: the
-- composer reads the blob and reconciliation reads the column, so a half
-- repair would make them contradict each other as well as the marketplace.
--
-- Idempotent: the WHERE clauses match only rows that are NOT already stepped,
-- so a second run updates nothing. A price of zero or below is left alone --
-- that is "no price set", not a rounding error.
--
-- THE round(..., 2) ON THE BLOB IS NOT DECORATION. Without it, cents / 100.0
-- carries numeric's full division scale into the JSON and the repaired blob
-- reads {"price": 32.0000000000000000} where the application writes
-- {"price": 32}. Measured on a local stack before it was added. Numerically
-- identical, and still the wrong thing to leave in a column a person reads.

do $$
declare
  price_rows integer;
  blob_rows integer;
begin
  -- 1. The column.
  with stepped as (
    select id,
           greatest(100, round(round(listing_price * 100) / 100.0) * 100) as cents
      from public.listings
     where platform in ('poshmark', 'vinted')
       and listing_price > 0
  )
  update public.listings l
     set listing_price = s.cents / 100.0
    from stepped s
   where l.id = s.id
     and l.listing_price <> s.cents / 100.0;
  get diagnostics price_rows = row_count;

  -- 2. The blob, keyed by the row's own platform, merged rather than replaced
  --    so nothing else in platform_fields is lost. price_override is the
  --    seller's stated intent for this channel and is stepped the same way;
  --    a row that never had one does not gain one here.
  with stepped as (
    select l.id,
           l.platform::text as key,
           greatest(100, round(round((l.platform_fields -> l.platform::text ->> 'price')::numeric * 100) / 100.0) * 100) as price_cents,
           case
             when (l.platform_fields -> l.platform::text ->> 'price_override') is null then null
             when (l.platform_fields -> l.platform::text ->> 'price_override')::numeric <= 0 then null
             else greatest(100, round(round((l.platform_fields -> l.platform::text ->> 'price_override')::numeric * 100) / 100.0) * 100)
           end as override_cents
      from public.listings l
     where l.platform in ('poshmark', 'vinted')
       and jsonb_typeof(l.platform_fields -> l.platform::text) = 'object'
       and (l.platform_fields -> l.platform::text ->> 'price') is not null
       and (l.platform_fields -> l.platform::text ->> 'price') ~ '^[0-9]+(\.[0-9]+)?$'
       and (l.platform_fields -> l.platform::text ->> 'price')::numeric > 0
  )
  update public.listings l
     set platform_fields = jsonb_set(
           l.platform_fields,
           array[s.key],
           (l.platform_fields -> s.key)
             || jsonb_build_object('price', round(s.price_cents / 100.0, 2))
             || case
                  when s.override_cents is null then '{}'::jsonb
                  else jsonb_build_object('price_override', round(s.override_cents / 100.0, 2))
                end,
           true)
    from stepped s
   where l.id = s.id
     and (
       (l.platform_fields -> s.key ->> 'price')::numeric <> s.price_cents / 100.0
       or (s.override_cents is not null
           and (l.platform_fields -> s.key ->> 'price_override')::numeric <> s.override_cents / 100.0)
     );
  get diagnostics blob_rows = row_count;

  -- Reported rather than silent: "it ran" and "it changed nothing" read the
  -- same in a psql transcript, and this story exists because nobody knew the
  -- count.
  raise notice '[00806] whole-dollar repair: % listing_price row(s), % platform_fields row(s)',
    price_rows, blob_rows;
end $$;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00806') on conflict do nothing;
