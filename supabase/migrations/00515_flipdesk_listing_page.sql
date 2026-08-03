-- US-2168 AC3: server-side row selection for the FlipDesk listings table.
--
-- The table materialised the WHOLE tenant and then filtered, searched, sorted
-- and paginated in the browser. US-2167 bounded each REQUEST (the read pages
-- until empty) but the client still needed every row to render fifty, so cost
-- tracked the size of the account rather than the size of the page.
--
-- This reproduces `selectListingRows` (src/pages/flipdesk/listings-filter.ts) in
-- SQL, exactly. That function was written by US-2178 as the executable spec of
-- what a tab shows, PRECISELY so this port could be verified against it rather
-- than against itself — see src/test/listing-page-sql-parity.test.ts, which runs
-- both implementations over a seeded corpus and compares row ids in order.
--
-- SECURITY INVOKER (the default — deliberately NOT `security definer`).
-- `items_full` is declared `security_invoker = on` (00010), so RLS on the
-- underlying tables applies to whoever calls this. The browser calls it as the
-- authenticated user, so a seller can only ever select their own rows, and this
-- function needs no tenant predicate of its own. Making it DEFINER would silently
-- turn it into a cross-tenant read.
--
-- The four traps this port had to avoid are named in selectListingRows' own
-- header. Three are handled by the ordering rules below; the fourth (predicate
-- composition order) is structural and preserved here.

-- Natural, case- and accent-insensitive text ordering.
--
-- JavaScript sorts strings with `localeCompare(numeric: true, sensitivity:
-- "base")`, so "item10" follows "item9" and "apple" ties with "Apple". Plain
-- `ORDER BY text` gives neither: it puts "item10" before "item9" and sorts every
-- capital before every lowercase. ICU's `kn` (numeric) + `ks-level1` (primary
-- strength) is the same rule, verified against the JS comparator on the same
-- inputs.
do $$
begin
  if not exists (select 1 from pg_collation where collname = 'natural_ci'
                   and collnamespace = 'public'::regnamespace) then
    create collation public.natural_ci (
      provider = icu, locale = 'en-u-kn-true-ks-level1', deterministic = false
    );
  end if;
end
$$;

comment on collation public.natural_ci is
  'US-2168: numeric + primary-strength ICU collation matching JS '
  'localeCompare(numeric:true, sensitivity:"base"), so server-side column sorts '
  'order identically to the client sort they replaced.';

-- ── The advanced FilterBuilder query ───────────────────────────────────────
--
-- Mirrors evalRule/evalQuery in src/lib/item-filter.ts. Written as a per-row
-- function rather than as generated predicates because parity is the priority
-- here and this shape can be read side-by-side with the TypeScript. It only runs
-- when the seller has actually built a filter — `rules: []` short-circuits on the
-- first line, which is the overwhelmingly common case.
--
-- THE ROW ARRIVES AS jsonb, NOT AS `public.items_full`, and that is not a style
-- choice. A function parameter typed as the view's composite type creates a
-- dependency ON the view, so `drop view items_full` CASCADE-DROPS the function.
-- That is not hypothetical here: 00438 drops and recreates this very view, and
-- an earlier draft of this migration was silently destroyed by replaying it —
-- the listings page would have broken with no failing migration and nothing to
-- point at. `to_jsonb(f)` at the call site costs a little and decouples these
-- helpers from the view's lifecycle entirely.
--
-- Two semantics that look like bugs and are not, both faithfully copied:
--   • A numeric comparison against a TEXT field is always false. The UI cannot
--     produce that pairing (opsForField gates it), but evalRule enforces it
--     anyway, so this does too.
--   • `in`/`nin` on a NULL value: `in` is false and `nin` is TRUE. A row missing
--     the field is "not in" the list.
create or replace function public.flipdesk_filter_matches(
  f jsonb,
  q jsonb
)
returns boolean
language plpgsql
stable
as $$
declare
  rules jsonb := coalesce(q -> 'rules', '[]'::jsonb);
  combinator text := coalesce(q ->> 'combinator', 'and');
  r jsonb;
  field text;
  op text;
  raw text;
  txt text;
  num numeric;
  ts timestamptz;
  is_numeric boolean;
  is_date boolean;
  day_start timestamptz;
  day_end timestamptz;
  cmp numeric;
  needle text[];
  hit boolean;
  any_true boolean := false;
  all_true boolean := true;
begin
  if jsonb_array_length(rules) = 0 then
    return true;
  end if;

  for r in select * from jsonb_array_elements(rules) loop
    field := r ->> 'field';
    op := r ->> 'op';
    raw := btrim(coalesce(r ->> 'value', ''));
    is_numeric := field in ('cost', 'target_price', 'grade', 'days_in_status');
    is_date := field in ('purchase_date', 'created_at', 'sale_date');
    txt := null; num := null; ts := null;

    case field
      when 'brand' then txt := f ->> 'brand';
      when 'category' then txt := f ->> 'category';
      when 'size' then txt := f ->> 'size';
      when 'source' then txt := f ->> 'source_name';
      when 'color' then txt := f ->> 'color';
      when 'location_bin' then txt := f ->> 'location_bin';
      when 'sku' then txt := f ->> 'item_number';
      when 'marketplace' then txt := f ->> 'listing_platform';
      when 'status' then txt := f ->> 'status';
      -- NULL and false both read as "incomplete", matching JS truthiness.
      when 'photo_state' then
        txt := case when (f ->> 'has_required_photos')::boolean then 'complete' else 'incomplete' end;
      when 'cost' then num := (f ->> 'purchase_price')::numeric;
      when 'target_price' then num := (f ->> 'target_price')::numeric;
      when 'grade' then num := (f ->> 'grade_value')::numeric;
      when 'days_in_status' then
        num := case
          when (f ->> 'updated_at') is null then null
          else floor(extract(epoch from (now() - (f ->> 'updated_at')::timestamptz)) / 86400.0)
        end;
      when 'purchase_date' then ts := (f ->> 'purchase_date')::timestamptz;
      when 'created_at' then ts := (f ->> 'created_at')::timestamptz;
      when 'sale_date' then ts := (f ->> 'sale_date')::timestamptz;
      else null;
    end case;

    if is_numeric then
      txt := case when num is null then null else num::text end;
    end if;

    if is_date then
      if op = 'isnull' then
        hit := ts is null;
      elsif op = 'notnull' then
        hit := ts is not null;
      elsif ts is null then
        hit := false;
      else
        -- dayStartMs(): a bare YYYY-MM-DD is anchored at UTC midnight so the
        -- window lines up with date-only columns regardless of viewer timezone.
        begin
          day_start := (
            case when raw ~ '^\d{4}-\d{2}-\d{2}$' then raw || 'T00:00:00Z' else raw end
          )::timestamptz;
        exception when others then
          day_start := null;
        end;
        if day_start is null then
          hit := false;
        else
          day_end := day_start + interval '1 day';
          hit := case op
            when 'eq' then ts >= day_start and ts < day_end
            when 'neq' then not (ts >= day_start and ts < day_end)
            when 'lt' then ts < day_start
            when 'lte' then ts < day_end
            when 'gt' then ts >= day_end
            when 'gte' then ts >= day_start
            else false
          end;
        end if;
      end if;
    else
      case op
        when 'isnull' then hit := (txt is null or txt = '');
        when 'notnull' then hit := (txt is not null and txt <> '');
        when 'contains' then
          hit := txt is not null and position(lower(raw) in lower(txt)) > 0;
        when 'in', 'nin' then
          select array_agg(v) into needle
          from (
            select btrim(lower(s)) as v
            from unnest(string_to_array(raw, ',')) as s
            where btrim(s) <> ''
          ) t;
          hit := txt is not null and lower(txt) = any(coalesce(needle, '{}'::text[]));
          if op = 'nin' then hit := not hit; end if;
        when 'eq', 'neq' then
          hit := txt is not null and lower(txt) = lower(raw);
          if op = 'neq' then hit := not hit; end if;
        when 'lt', 'gt', 'lte', 'gte' then
          -- Only a genuinely numeric field compares; anything else is false.
          begin
            cmp := raw::numeric;
          exception when others then
            cmp := null;
          end;
          if not is_numeric or num is null or cmp is null then
            hit := false;
          else
            hit := case op
              when 'lt' then num < cmp
              when 'gt' then num > cmp
              when 'lte' then num <= cmp
              else num >= cmp
            end;
          end if;
        else hit := false;
      end case;
    end if;

    any_true := any_true or coalesce(hit, false);
    all_true := all_true and coalesce(hit, false);
  end loop;

  return case when combinator = 'and' then all_true else any_true end;
end;
$$;

comment on function public.flipdesk_filter_matches(jsonb, jsonb) is
  'US-2168: SQL mirror of evalQuery() in src/lib/item-filter.ts. Pinned against '
  'the TypeScript by src/test/listing-page-sql-parity.test.ts.';

-- ── The listability score ──────────────────────────────────────────────────
-- Mirrors scoreListability() in src/lib/listability.ts. Readiness (max 60):
-- graded 25, has comps 20, target priced 15. Worth-it (max 40): margin up to 25,
-- age-in-inventory up to 15.
create or replace function public.flipdesk_listability_score(f jsonb)
returns integer
language sql
stable
as $$
  select least(100, (
    (case when (f ->> 'grade_value') is not null then 25 else 0 end)
    + (case
         when jsonb_typeof(f -> 'comps') = 'array' and jsonb_array_length(f -> 'comps') > 0
         then 20 else 0
       end)
    + (case when (f ->> 'target_price') is not null then 15 else 0 end)
    + (case
         when coalesce((f ->> 'target_price')::numeric, (f ->> 'list_price')::numeric) is null
           or coalesce((f ->> 'target_price')::numeric, (f ->> 'list_price')::numeric) <= 0
         then 0
         else greatest(0, least(25, round(
           ((coalesce((f ->> 'target_price')::numeric, (f ->> 'list_price')::numeric) - coalesce((f ->> 'purchase_price')::numeric, 0))
             / coalesce((f ->> 'target_price')::numeric, (f ->> 'list_price')::numeric)) * 30
         )))
       end)
    + (case
         when (f ->> 'created_at') is null then 0
         else least(15, round(
           floor(extract(epoch from (now() - (f ->> 'created_at')::timestamptz)) / 86400.0) / 7.0
         ))
       end)
  )::int);
$$;

comment on function public.flipdesk_listability_score(jsonb) is
  'US-2168: SQL mirror of scoreListability().score in src/lib/listability.ts.';

-- Highest recorded comp price — mirrors maxCompPrice(); non-numeric entries and
-- a missing/!array `comps` all yield 0, exactly as the JS reduce does.
create or replace function public.flipdesk_max_comp_price(f jsonb)
returns numeric
language sql
stable
as $$
  select coalesce((
    select max(p) from (
      select case
               when jsonb_typeof(c -> 'price') = 'number' then (c ->> 'price')::numeric
               when jsonb_typeof(c -> 'price') = 'string'
                 and (c ->> 'price') ~ '^-?\d+(\.\d+)?$' then (c ->> 'price')::numeric
               else null
             end as p
      from jsonb_array_elements(
        case when jsonb_typeof(f -> 'comps') = 'array' then f -> 'comps' else '[]'::jsonb end
      ) as c
    ) t
    where p is not null and p > 0
  ), 0);
$$;

comment on function public.flipdesk_max_comp_price(jsonb) is
  'US-2168: SQL mirror of maxCompPrice() in src/lib/listability.ts.';

-- ── The page itself ────────────────────────────────────────────────────────
--
-- Returns { total, rows } — the count BEFORE pagination (so the pager and the
-- "N items" label stay honest) and one page of whole `items_full` rows.
--
-- `p_ytd_start` is supplied by the CALLER rather than derived here, for the same
-- reason the admin dashboard passes its chart edges: "year to date" means the
-- viewer's local year, and the database has no idea what timezone that is.
-- Deriving it server-side would quietly shift the Sold tab's YTD window for
-- anyone not on the database's timezone.
create or replace function public.flipdesk_listing_page(
  p_tab text,
  p_search text default '',
  p_sold_filter text default 'all',
  p_filter jsonb default '{"combinator":"and","rules":[]}'::jsonb,
  p_column_sort jsonb default null,
  p_sort_preset text default 'listability',
  p_ytd_start timestamptz default null,
  p_limit int default 100,
  p_offset int default 0
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
  lim int := greatest(0, least(1000, coalesce(p_limit, 100)));
  off int := greatest(0, coalesce(p_offset, 0));
  result jsonb;
begin
  -- ── tab predicate ──
  where_sql := where_sql || ' and ' || case p_tab
    when 'all' then $q$ f.status <> 'archived' $q$
    when 'to_list' then
      $q$ f.status in ('sourced','acquired','cataloged','measured','photographed','grading','graded','comped') $q$
    when 'drafts' then $q$ f.status = 'drafted' $q$
    when 'active' then $q$ f.status = 'listed' $q$
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
            nullif(f.item_title,''), nullif(f.brand,''), nullif(f.style,''),
            nullif(f.item_number,''), nullif(f.container,'')))) > 0 $q$,
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
  elsif p_tab = 'to_list' then
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

  execute format($sql$
    with base as (
      select f.* from public.items_full f where %s
    )
    select jsonb_build_object(
      'total', (select count(*) from base),
      'rows', coalesce((
        select jsonb_agg(z.rowdata order by z.rn)
        from (
          select to_jsonb(b) as rowdata, row_number() over () as rn
          from (select * from base order by %s limit %s offset %s) b
        ) z
      ), '[]'::jsonb)
    )
  $sql$, where_sql, order_sql, lim, off)
  into result;

  return result;
end;
$$;

comment on function public.flipdesk_listing_page(text, text, text, jsonb, jsonb, text, timestamptz, int, int) is
  'US-2168 AC3: one page of the FlipDesk listings table, selected/filtered/'
  'sorted server-side. SECURITY INVOKER so items_full RLS scopes it to the '
  'caller. SQL mirror of selectListingRows(); pinned by '
  'src/test/listing-page-sql-parity.test.ts.';

grant execute on function public.flipdesk_filter_matches(jsonb, jsonb) to authenticated;
grant execute on function public.flipdesk_listability_score(jsonb) to authenticated;
grant execute on function public.flipdesk_max_comp_price(jsonb) to authenticated;
grant execute on function public.flipdesk_listing_page(text, text, text, jsonb, jsonb, text, timestamptz, int, int) to authenticated;

insert into public.applied_migrations (version) values ('00515') on conflict do nothing;
