-- US-1939: give the core money columns explicit cent-level precision.
--
-- 00002 declared acquired_price / listing_price / sale_price / platform_fees /
-- shipping_cost / label_cost as bare `decimal` (arbitrary precision), while
-- columns added later in 00008 use `decimal(10,2)`. Bare `decimal` permits
-- sub-cent values and mismatched scale between joined columns, which can surface
-- rounding drift in the P&L / reconciliation path. Normalize to numeric(10,2)
-- to match the FlipDesk convention, and add non-negative CHECKs where a negative
-- value is impossible (prices, costs, fees).
--
-- Guarded so a re-run is a no-op: the type change fires only while the column is
-- still unbounded (numeric_precision IS NULL), and each CHECK is added only if
-- absent. numeric(10,2) losslessly holds any existing sensible price (max
-- 99,999,999.99); values already stored round to 2dp on the type change.

do $$
begin
  -- inventory_items.acquired_price
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='inventory_items'
               and column_name='acquired_price' and numeric_precision is null) then
    alter table public.inventory_items alter column acquired_price type numeric(10,2);
  end if;

  -- listings.listing_price
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='listings'
               and column_name='listing_price' and numeric_precision is null) then
    alter table public.listings alter column listing_price type numeric(10,2);
  end if;

  -- sales.sale_price, sales.platform_fees
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='sales'
               and column_name='sale_price' and numeric_precision is null) then
    alter table public.sales alter column sale_price type numeric(10,2);
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='sales'
               and column_name='platform_fees' and numeric_precision is null) then
    alter table public.sales alter column platform_fees type numeric(10,2);
  end if;

  -- shipments.shipping_cost, shipments.label_cost
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='shipments'
               and column_name='shipping_cost' and numeric_precision is null) then
    alter table public.shipments alter column shipping_cost type numeric(10,2);
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='shipments'
               and column_name='label_cost' and numeric_precision is null) then
    alter table public.shipments alter column label_cost type numeric(10,2);
  end if;
end $$;

-- Non-negative CHECKs (idempotent via pg_constraint probe).
do $$
begin
  if not exists (select 1 from pg_constraint where conname='inventory_items_acquired_price_nonneg') then
    alter table public.inventory_items
      add constraint inventory_items_acquired_price_nonneg check (acquired_price >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='listings_listing_price_nonneg') then
    alter table public.listings
      add constraint listings_listing_price_nonneg check (listing_price >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='sales_sale_price_nonneg') then
    alter table public.sales
      add constraint sales_sale_price_nonneg check (sale_price >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='sales_platform_fees_nonneg') then
    alter table public.sales
      add constraint sales_platform_fees_nonneg check (platform_fees >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='shipments_shipping_cost_nonneg') then
    alter table public.shipments
      add constraint shipments_shipping_cost_nonneg check (shipping_cost >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='shipments_label_cost_nonneg') then
    alter table public.shipments
      add constraint shipments_label_cost_nonneg check (label_cost >= 0);
  end if;
end $$;

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00438') ON CONFLICT DO NOTHING;
