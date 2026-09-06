-- US-3122: the advanced filter learns "Sourced by".
--
-- `flipdesk_filter_matches` is the SQL mirror of evalQuery() in
-- src/lib/item-filter.ts, and it decides every rule the Inventory filter can
-- express. A field the TypeScript knows and this function does not is not a
-- no-op: `field` falls through the CASE, `txt` stays NULL, and an `eq` rule
-- matches nothing — the seller gets an empty list with no error. So the field
-- has to land here in the same breath as the client.
--
-- One line changes: `sourced_by` reads the column of the same name off
-- items_full. It is plain text (the 00672 roster picks the name, it does not
-- replace it), so every text operator already behaves correctly around it and
-- nothing else in the function moves. The whole body is restated because
-- CREATE OR REPLACE takes no patch.
--
-- Parity is pinned by src/test/listing-page-sql-parity.test.ts, which runs both
-- implementations over the same rows out of items_full.

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
      -- WHERE it came from is `source`; WHO bought it is this one (US-3122).
      when 'sourced_by' then txt := f ->> 'sourced_by';
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
  'the TypeScript by src/test/listing-page-sql-parity.test.ts. US-3122 added the '
  'sourced_by field.';

-- Sorting and filtering by the sourcer both read this column on every page, so
-- give them the same index the roster page already relies on. Partial, because
-- a NULL sourcer is the common row and is never the thing being looked for.
create index if not exists idx_inventory_items_sourced_by_lower
  on public.inventory_items (user_id, lower(btrim(sourced_by)))
  where sourced_by is not null;

insert into public.applied_migrations (version) values ('00728') on conflict do nothing;
