-- US-3195: how long is too long, per seller.
--
-- FlipDesk has the aging RULES — automations trigger on days_listed_gt, the
-- repricing engine has a stale-age nudge, scheduled markdowns discount old
-- stock. What it has never had is the SCREEN: a seller can automate a markdown
-- on aged inventory and cannot browse what is aged. So the dead stock is only
-- ever seen by a robot, and the seller meets it at tax time in the COGS
-- worksheet.
--
-- THE THRESHOLD IS THE SELLER'S, because "too long" is a fact about their
-- category and their cash, not about garments. Sixty days is a long time for a
-- fast-turn basics seller and nothing at all for someone holding vintage
-- outerwear through a summer.
--
-- STORED, NOT PER-SESSION, and that is the whole reason this is a column rather
-- than a URL parameter. A definition of "aged" that resets every visit is one
-- the seller re-types before they can act, and two visits can disagree about
-- which items are on the list.
--
-- NULL MEANS THE DEFAULT (60 days, in src/lib/aged-inventory.ts), so an account
-- that never touches the setting gets a working screen rather than an empty one.
--
-- DEPLOY ORDER: this one is frontend-only today — the SPA reads the column
-- through RLS, and no edge route touches it. It still lands before the push,
-- because Pages auto-deploys and a select on a missing column 400s.

alter table public.flipdesk_settings
  add column if not exists aged_threshold_days integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'flipdesk_settings_aged_threshold_sane'
  ) then
    alter table public.flipdesk_settings
      add constraint flipdesk_settings_aged_threshold_sane
      check (aged_threshold_days is null
             or (aged_threshold_days >= 1 and aged_threshold_days <= 3650));
  end if;
end $$;

comment on column public.flipdesk_settings.aged_threshold_days is
  'Days listed after which this seller considers an item aged. NULL means the code default (60). Bounded at 1..3650 — a zero-day threshold would mark every new listing aged the moment it went live.';

-- ── US-3195: the Aged tab, server-side ────────────────────────────────────────
--
-- selectListingRows() in listings-filter.ts is the specification of what a tab
-- shows, and src/test/listing-page-sql-parity.test.ts runs it and this function
-- over the same rows and requires identical ids in identical order. So a tab
-- that exists only in the TypeScript is a tab that fails parity, and a tab that
-- exists only here is one the seller cannot reach.
--
-- Everything below is 00721's text verbatim apart from: the new
-- p_aged_threshold_days parameter, its clamp, the 'aged' tab predicate, and the
-- oldest-first sort for it.

-- The argument list grows by one, so the old overload is dropped rather than
-- replaced: CREATE OR REPLACE with a different signature creates a SECOND
-- function, and callers would keep resolving to whichever matched. Both the
-- 10-arg (00515) and 11-arg (00721) forms are named so a re-run is clean.
drop function if exists public.flipdesk_listing_page(text, text, text, jsonb, jsonb, text, timestamptz, int, int, text[]);
drop function if exists public.flipdesk_listing_page(text, text, text, jsonb, jsonb, text, timestamptz, int, int, text[], text);
drop function if exists public.flipdesk_listing_page(text, text, text, jsonb, jsonb, text, timestamptz, int, int, text[], text, int);

create or replace function public.flipdesk_listing_page(
  p_tab text,
  p_search text default '',
  p_sold_filter text default 'all',
  p_filter jsonb default '{"combinator":"and","rules":[]}'::jsonb,
  p_column_sort jsonb default null,
  p_sort_preset text default 'listability',
  p_ytd_start timestamptz default null,
  p_limit int default 100,
  p_offset int default 0,
  p_columns text[] default null,
  p_unlisted_filter text default 'all',
  -- US-3195: the seller's own "too long", in days listed. Defaulted so every
  -- existing caller keeps its exact behaviour, and clamped below to the same
  -- 1..3650 range the flipdesk_settings CHECK enforces.
  p_aged_threshold_days int default 60
)
returns jsonb
language plpgsql
stable
as $$
declare
  where_sql text := 'true';
  order_sql text;
  sort_field text;
  sort_dir text;
  col_type text;
  search_q text := btrim(coalesce(p_search, ''));
  -- The row projection. NULL p_columns means "every column", which is what the
  -- parity harness wants; the page passes its LISTINGS_COLUMNS so the wire
  -- carries what it renders and not the four heavy detail-only columns
  -- (comps, item_description, notes, ai_field_sources). The list stays in ONE
  -- place — listings-columns.ts — rather than being restated here where it
  -- would drift silently the first time a column was added.
  row_json text;
  lim int := greatest(0, least(1000, coalesce(p_limit, 100)));
  off int := greatest(0, coalesce(p_offset, 0));
  -- US-3195. Clamped, not trusted: a zero would mark every listing aged the
  -- moment it went live, and the column's own CHECK already refuses one.
  aged_days int := greatest(1, least(3650, coalesce(p_aged_threshold_days, 60)));
  result jsonb;
begin
  -- ── tab predicate ──
  where_sql := where_sql || ' and ' || case p_tab
    when 'all' then $q$ f.status <> 'archived' $q$
    when 'to_list' then
      $q$ f.status in ('sourced','acquired','cataloged','measured','photographed','grading','graded','comped') $q$
    when 'drafts' then $q$ f.status = 'drafted' $q$
    -- Unlisted = To List + Drafts. The two old ids stay resolvable above so a
    -- caller built against 00515 keeps getting what it asked for.
    when 'unlisted' then
      $q$ f.status in ('sourced','acquired','cataloged','measured','photographed','grading','graded','comped','drafted') $q$
    when 'active' then $q$ f.status = 'listed' $q$
    -- US-3195: live, unsold, and listed longer than the seller's threshold.
    -- `list_date is not null` is load-bearing and mirrors isAged() in JS: an
    -- item that was never listed has not been listed for zero days, it has not
    -- been listed, and null arithmetic must not sweep it in.
    when 'aged' then format(
      $q$ f.status = 'listed' and f.sale_date is null and f.list_date is not null
          and f.list_date <= now() - (%L || ' days')::interval $q$,
      aged_days
    )
    -- A refunded/cancelled sale is no longer revenue (US-1451). `is distinct
    -- from` is load-bearing: a NULL sale_status must PASS, as `!==` does in JS.
    when 'sold' then
      $q$ f.status = 'sold' and f.sale_status is distinct from 'refunded' and f.sale_status is distinct from 'cancelled' $q$
    when 'shipped' then $q$ f.status = 'shipped' $q$
    when 'returned' then $q$ f.status = 'returned' $q$
    when 'archived' then $q$ f.status = 'archived' $q$
    else 'true'
  end;

  -- ── free-text search ──
  -- Built as ONE haystack rather than per-column ORs, because that is what
  -- matchesSearch does: it joins the five fields with a space and calls
  -- `includes`. A query spanning a field boundary ("nike wind") therefore
  -- matches in both implementations. `position(... in ...)` keeps it a LITERAL
  -- substring test, so a seller searching "50%" is not silently given a
  -- wildcard. nullif('') mirrors the JS .filter(Boolean).
  if search_q <> '' then
    where_sql := where_sql || format(
      $q$ and position(%L in lower(concat_ws(' ',
            nullif(f.item_title,''), nullif(f.listing_title,''), nullif(f.brand,''),
            nullif(f.style,''), nullif(f.item_number,''), nullif(f.container,''),
            nullif(f.size,''), nullif(f.color,''), nullif(f.category,''),
            nullif(f.location_bin,'')))) > 0 $q$,
      lower(search_q)
    );
  end if;

  -- ── the Sold tab's secondary window ──
  if p_tab = 'sold' then
    where_sql := where_sql || ' and ' || case p_sold_filter
      when 'awaiting_payout' then $q$ (f.payout is null or f.payout <= 0) $q$
      when 'discrepancy' then
        $q$ (f.payout is not null and f.payout > 0 and f.sale_price is not null
             and f.sale_price > 0 and f.fees is not null
             and f.fees > f.sale_price * 0.2) $q$
      when 'd7' then $q$ (f.sale_date is not null and f.sale_date >= now() - interval '7 days') $q$
      when 'd30' then $q$ (f.sale_date is not null and f.sale_date >= now() - interval '30 days') $q$
      when 'ytd' then
        case when p_ytd_start is null then 'false'
             else format($q$ (f.sale_date is not null and f.sale_date >= %L) $q$, p_ytd_start)
        end
      else 'true'
    end;
  end if;

  -- ── the Unlisted tab's chip ──
  -- The same split To List / Drafts used to make, as a filter inside one tab.
  -- Mirrors matchesUnlistedFilter() in inventory-tabs.ts: a draft with no
  -- review flag recorded counts as ready, so `is not true` rather than `= false`.
  if p_tab = 'unlisted' then
    where_sql := where_sql || ' and ' || case p_unlisted_filter
      when 'needs_draft' then
        $q$ f.status in ('sourced','acquired','cataloged','measured','photographed','grading','graded','comped') $q$
      when 'ready' then $q$ (f.status = 'drafted' and f.listing_needs_review is not true) $q$
      when 'needs_review' then $q$ (f.status = 'drafted' and f.listing_needs_review is true) $q$
      else 'true'
    end;
  end if;

  -- ── the advanced filter, composed LAST and on top of everything above ──
  if jsonb_array_length(coalesce(p_filter -> 'rules', '[]'::jsonb)) > 0 then
    where_sql := where_sql || format(
      ' and public.flipdesk_filter_matches(to_jsonb(f), %L::jsonb)', p_filter::text
    );
  end if;

  -- ── ordering ──
  -- A clicked column beats every preset, including the To-List preset.
  sort_field := p_column_sort ->> 'field';
  if sort_field is not null then
    select data_type into col_type
    from information_schema.columns
    where table_schema = 'public' and table_name = 'items_full'
      and column_name = sort_field;
    -- Doubles as the whitelist: an unknown name is not a column, so it cannot
    -- reach format('%I') at all.
    if col_type is null then
      raise exception 'flipdesk_listing_page: % is not a sortable column', sort_field
        using errcode = '22023';
    end if;
    sort_dir := case when lower(coalesce(p_column_sort ->> 'dir', 'asc')) = 'desc'
                     then 'desc' else 'asc' end;
    -- NULLS LAST in BOTH directions: a row missing the sorted value is not
    -- "smallest", it is unknown, and burying it is what the client did.
    if col_type in ('numeric','integer','bigint','smallint','double precision','real')
       or col_type like 'timestamp%' or col_type = 'date' then
      order_sql := format('%I %s nulls last', sort_field, sort_dir);
    else
      -- Text, enums and booleans all compared as text by the JS comparator
      -- (only `typeof === "number"` took the numeric path), so booleans order
      -- 'false' before 'true' here exactly as they did there.
      order_sql := format('%I::text collate public.natural_ci %s nulls last',
                          sort_field, sort_dir);
    end if;
  elsif p_tab in ('to_list', 'unlisted') then
    order_sql := case p_sort_preset
      when 'oldest' then 'created_at asc nulls last'
      when 'best_roi' then
        -- roiOf(): -1 when there is no usable price, so those sink together.
        $q$ (case
              when coalesce(target_price, list_price) is null
                or coalesce(target_price, list_price) <= 0 then -1
              else (coalesce(target_price, list_price) - coalesce(purchase_price, 0))
                   / coalesce(target_price, list_price)
            end) desc $q$
      when 'highest_comp' then 'public.flipdesk_max_comp_price(to_jsonb(base)) desc'
      else 'public.flipdesk_listability_score(to_jsonb(base)) desc'
    end;
  else
    order_sql := case p_tab
      when 'all' then 'created_at desc nulls last'
      when 'drafts' then 'updated_at asc nulls last'
      when 'active' then 'list_date desc nulls last'
      -- US-3195: OLDEST first. The top of this list should be the thing that
      -- has been sitting longest, which is the opposite of every other tab.
      when 'aged' then 'list_date asc nulls last'
      when 'sold' then 'sale_date desc nulls last'
      when 'shipped' then 'sale_date desc nulls last'
      when 'returned' then 'updated_at desc nulls last'
      when 'archived' then 'updated_at desc nulls last'
      else 'created_at desc nulls last'
    end;
  end if;

  -- Array.prototype.sort is STABLE, and the array it sorted arrived newest-first
  -- (fetchItemsPaged orders by created_at desc). So ties in the client kept that
  -- order, and reproducing it needs the same tie-break here — without it, equal
  -- sort keys come back in whatever order the planner likes and paging can show
  -- a row twice. `id` settles the remaining ties so the total order is strict.
  order_sql := order_sql || ', created_at desc nulls last, id';

  row_json := case
    when p_columns is null or array_length(p_columns, 1) is null then 'to_jsonb(p)'
    else format(
      'to_jsonb(p) - (select coalesce(array_agg(k), ''{}''::text[]) '
      'from jsonb_object_keys(to_jsonb(p)) k where not (k = any(%L::text[])))',
      p_columns
    )
  end;

  -- `soldAgg` and `buyerCounts` ride along because both are things the page
  -- derives from the WHOLE set today, and both would silently degrade to
  -- per-page numbers the moment the client stops loading the tenant:
  --
  --   • soldAgg is the Sold tab's strip (gross, net, average margin). It is
  --     computed over the FILTERED set, not the page, so it is taken from
  --     `base` before pagination. `avgMargin` averages the per-row percentages
  --     (matching marginPct() in listings-format.ts) rather than dividing the
  --     totals — those are different numbers, and the client shows the former.
  --   • buyerCounts drives the repeat-buyer star, which asks "has this buyer
  --     bought from me before?" — a question about the whole account. It is
  --     keyed to the buyers ON THIS PAGE but counted across everything the
  --     caller can see, so the star means the same thing it did.
  execute format($sql$
    with base as (
      select f.* from public.items_full f where %s
    ), page as (
      select * from base order by %s limit %s offset %s
    )
    select jsonb_build_object(
      'total', (select count(*) from base),
      'rows', coalesce((
        select jsonb_agg(z.rowdata order by z.rn)
        from (
          select %s as rowdata, row_number() over () as rn from page p
        ) z
      ), '[]'::jsonb),
      'soldAgg', (
        select jsonb_build_object(
          'count', count(*),
          'gross', coalesce(sum(coalesce(sale_price, 0)), 0),
          'net', coalesce(sum(coalesce(net_profit, 0)), 0),
          'avgMargin', avg(
            case when sale_price > 0 and net_profit is not null
                 then (net_profit / sale_price) * 100 end
          )
        ) from base
      ),
      'buyerCounts', coalesce((
        select jsonb_object_agg(b.buyer_id, b.n)
        from (
          select f.buyer_id, count(*) as n
          from public.items_full f
          where f.buyer_id is not null
            and f.buyer_id in (select buyer_id from page where buyer_id is not null)
          group by f.buyer_id
        ) b
      ), '{}'::jsonb)
    )
  $sql$, where_sql, order_sql, lim, off, row_json)
  into result;

  return result;
end;
$$;

-- ⚠️ BOTH OF THESE MUST NAME THE NEW 12-ARG SIGNATURE.
--
-- They were copied from 00721 naming the ELEVEN-arg one, and that is a bug this
-- migration shipped with once: the drop above removes the 11-arg function, so
-- `comment on function <11 args>` then fails with 42883 "function does not
-- exist" and the apply stops. The comment failing is cosmetic; the GRANT
-- failing is not. A grant lives on the SIGNATURE, so dropping the old function
-- took its grant with it, and without the line below `authenticated` cannot
-- execute the new function at all — every tab of the listings table returns a
-- permission error for every signed-in seller.
comment on function public.flipdesk_listing_page(text, text, text, jsonb, jsonb, text, timestamptz, int, int, text[], text, int) is
  'US-2168 AC3: one page of the FlipDesk listings table, selected/filtered/'
  'sorted server-side. SECURITY INVOKER so items_full RLS scopes it to the '
  'caller. SQL mirror of selectListingRows(); pinned by '
  'src/test/listing-page-sql-parity.test.ts. 00721 added the unlisted tab, '
  'its chip (p_unlisted_filter) and a wider search haystack. 00771 added the '
  'aged tab and p_aged_threshold_days.';

grant execute on function public.flipdesk_listing_page(text, text, text, jsonb, jsonb, text, timestamptz, int, int, text[], text, int) to authenticated;

insert into public.applied_migrations (version) values ('00771') on conflict do nothing;
