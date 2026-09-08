-- US-3136: pooled realized sold comps, contributed by consenting sellers.
--
-- WHY THIS EXISTS. Every price GradeThread shows today is an ACTIVE ASKING
-- PRICE, which systematically overstates value. The honest fix is realized sold
-- prices, and eBay has closed every route to them for an app like this:
-- findCompletedItems was restricted in 2020 and the whole Finding API was
-- decommissioned in February 2025; Marketplace Insights is a Limited Release
-- that eBay's own docs say is "not open to new users"; Terapeak is eBay's own
-- product with no API and no export. What remains is scraping, which breaches
-- eBay's terms and would put SELLERS' connected accounts at risk, not just an
-- IP. That is not a trade this project will make.
--
-- What is legitimately available is the sellers' OWN completed orders. Every
-- seller who connects eBay to FlipDesk grants sell.fulfillment, and their
-- orders already land in public.sales. Those rows are realized prices, they
-- include accepted Best Offer amounts that no scrape of a listing page could
-- see, and -- uniquely -- they carry a CONDITION GRADE, which eBay itself does
-- not know. Pooled across consenting sellers that is a comp set no third party
-- can sell you.
--
-- It is a SUPPLEMENT and is built to stay one. It sits below eBay sold comps
-- and the seller's own private sales in the existing ladder in sold-comps.ts,
-- and when it has nothing it returns nothing so the caller falls back exactly
-- as it does today.
--
-- -- CONSENT IS OPT-IN AND DEFAULTS TO OFF ------------------------------------
--
-- `pooled_comps_opt_in` defaults to FALSE. A seller's sales history is their
-- commercial position, and US-268 makes cross-tenant reads deny-by-default for
-- exactly this reason. Nothing enters the pool until a seller turns it on, and
-- turning it off stops their rows counting immediately -- the function reads
-- the flag live rather than copying rows into a pool table, so there is no
-- second copy to forget to delete.
--
-- -- WHAT A CALLER CAN LEARN, AND WHAT IT CANNOT -----------------------------
--
-- The function returns AGGREGATES ONLY: a count, a distinct-seller count, and
-- three percentiles. No sale row, no date, no item, no seller. There is
-- deliberately no way to ask it for the underlying rows.
--
-- It also refuses to answer thin questions, and both floors matter:
--
--   at least 5 sales          -- a median of two is not a median. This mirrors
--                                MIN_PRICE_SAMPLE in supply-sampling.ts and
--                                MIN_SOLD_COMPS in sold-comps.ts.
--   at least 3 distinct sellers -- the one that protects sellers rather than
--                                statistics. With two sellers in a bucket,
--                                either can subtract their own sales from the
--                                aggregate and read the other's business off
--                                the remainder. Three is the floor where that
--                                stops being arithmetic.
--
-- ⚠ CONSEQUENCE, STATED PLAINLY: with 2 connected sellers on the platform
-- today this function returns NOTHING, for every query. That is the design
-- working, not a bug to tune around, and the seller-count floor must not be
-- lowered to make it produce output sooner. It starts answering when the
-- platform is big enough that answering is safe.

alter table public.flipdesk_settings
  add column if not exists pooled_comps_opt_in boolean not null default false;

comment on column public.flipdesk_settings.pooled_comps_opt_in is
  'US-3136: seller consents to their realized sale prices counting toward anonymous pooled comps shown to other sellers. Defaults FALSE. Read live by pooled_sold_comps() - revoking consent takes effect on the next query, with no copied pool to purge.';

-- Aggregates only, thresholds inside. SECURITY DEFINER so the floors cannot be
-- bypassed by a caller with table access: the k-anonymity rule is a property of
-- this function, not of whoever remembers to apply it.
create or replace function public.pooled_sold_comps(
  p_category_id  text,
  p_brand        text default null,
  p_lookback_days int default 365
)
returns table (
  sale_count    bigint,
  seller_count  bigint,
  currency      text,
  p25_cents     bigint,
  median_cents  bigint,
  p75_cents     bigint
)
language sql
stable
security definer
set search_path to 'public'
as $$
  with eligible as (
    select s.user_id,
           round(s.sale_price * 100)::bigint as cents,
           coalesce(s.currency, 'USD') as cur
      from public.sales s
      join public.inventory_items i on i.id = s.inventory_item_id
      join public.flipdesk_settings f on f.user_id = i.user_id
     where f.pooled_comps_opt_in = true
       and s.sale_price is not null
       and s.sale_price > 0
       and s.sale_date >= now() - make_interval(days => greatest(p_lookback_days, 1))
       and i.ebay_category_id = p_category_id
       and (p_brand is null or lower(i.brand) = lower(p_brand))
  ),
  agg as (
    select count(*)                          as n,
           count(distinct user_id)           as sellers,
           min(cur)                          as cur,
           percentile_cont(0.25) within group (order by cents) as p25,
           percentile_cont(0.50) within group (order by cents) as p50,
           percentile_cont(0.75) within group (order by cents) as p75
      from eligible
  )
  select n, sellers, cur,
         round(p25)::bigint, round(p50)::bigint, round(p75)::bigint
    from agg
   -- Both floors, applied here so no caller can forget one.
   where n >= 5 and sellers >= 3;
$$;

comment on function public.pooled_sold_comps(text, text, int) is
  'US-3136: anonymous pooled realized-sale percentiles across sellers who opted in via flipdesk_settings.pooled_comps_opt_in. Returns NO ROW unless at least 5 sales from at least 3 distinct sellers - the seller floor is anti-deanonymization, not statistics, and must not be lowered.';

-- ⚠ DELIBERATELY NO REVOKE HERE, and that is not an oversight.
--
-- On this Postgres image a DENIED function call from anon or authenticated
-- SEGFAULTS the backend and restarts the database, because supautils appends a
-- GRANT hint to the error (US-2403). That is why 00527 -- the bulk revoke -- is
-- parked. Adding a revoke here would create that crash surface on a brand-new
-- function. The permission question belongs to US-2282/US-2403.
--
-- The exposure is bounded by the function itself rather than by a grant: it
-- returns aggregates only, and only above both thresholds.

insert into public.applied_migrations (version) values ('00762') on conflict do nothing;
