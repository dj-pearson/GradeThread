-- US-3414: per-tenant SKU numbering -- the counter row and the odometer.
--
-- inventory_items.sku is a free-text box today, typed by hand in intake.tsx and
-- bulk-intake.tsx, and nothing in the product ever fills it in. A seller who
-- numbers 1..1031 has to remember that the next one is 1032 and has to not
-- fat-finger it.
--
-- WHAT A PATTERN IS. A jsonb array of segments, rendered left to right:
--
--   [{"kind":"text","value":"GT-"},
--    {"kind":"date","format":"YY"},
--    {"kind":"letter","alphabet":"ABCDEFGHIJKLMNOPQRSTUVWXYZ","width":1},
--    {"kind":"number","width":4,"min":0,"max":9999}]
--
-- `text` and `date` consume no counter slot. `letter` and `number` each consume
-- one, left to right, so `counters` above has length 2. The whole thing is
-- advanced like a car odometer: the rightmost wheel ticks, and on overflow it
-- resets to its min and carries left. That single rule produces BOTH of the
-- shapes the owner asked for:
--
--   [number w=0]            1032 -> 1033
--   [letter, number w=4]    J9999 -> K0000
--
-- IT NEVER WRAPS. When the leftmost wheel overflows the sequence is exhausted
-- and advance returns NULL. Wrapping would hand out a number the tenant has
-- already used, which is the one thing this feature exists to prevent.
--
-- WHY A SEPARATE TABLE AND NOT A COLUMN ON flipdesk_settings. Two reasons, and
-- the second is the one that matters. The counter changes on every single item
-- insert, so putting it on the settings row means every insert takes a row lock
-- on the row that also holds auto_end_cross_listings, cross_post_channels and
-- eight other things. More importantly the two have opposite access needs:
-- settings must be writable by the browser, and the counter must NOT be,
-- because a client that can set `counters` backwards can manufacture duplicate
-- SKUs. Separate table, SELECT-only policy, all writes through SECURITY DEFINER
-- functions (US-3416).
--
-- Uniqueness itself is unchanged and predates this work:
-- idx_inventory_items_user_sku (00008) is UNIQUE (user_id, sku) WHERE sku IS NOT
-- NULL. Two tenants may hold the same string; one tenant may not hold it twice.
--
-- The trigger that USES all of this is US-3415 / 00803. This migration wires
-- nothing to inventory_items.

-- ---------------------------------------------------------------------------
-- The counter row
-- ---------------------------------------------------------------------------

create table if not exists public.flipdesk_sku_sequences (
  user_id               uuid primary key references public.users(id) on delete cascade,
  enabled               boolean not null default false,
  pattern               jsonb not null default '[]'::jsonb,
  counters              integer[] not null default '{}',
  date_stamp            text,
  reset_on_date_change  boolean not null default false,
  exhausted             boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.flipdesk_sku_sequences is
  'US-3414: one row per tenant holding the SKU pattern and where its counters are sitting. The tenant is the workspace OWNER, matching inventory_items.user_id. Read-only to the browser; every write goes through flipdesk_sku_save.';

comment on column public.flipdesk_sku_sequences.counters is
  'US-3414: the NEXT value to issue, one integer per counting segment in pattern, left to right. flipdesk_sku_render(pattern, counters, today) IS the next SKU -- nothing advances first. Seeding a tenant whose highest SKU is 1031 stores {1032}.';

comment on column public.flipdesk_sku_sequences.date_stamp is
  'US-3414: the rendered date segments as of the last issue, e.g. ''26''. Compared against today''s rendering when reset_on_date_change is true, which is how a yearly sequence knows the year rolled over.';

comment on column public.flipdesk_sku_sequences.exhausted is
  'US-3414: the leftmost wheel overflowed, or the collision skip ran out of attempts. While true the trigger issues nothing and new items save with a NULL sku. A successful flipdesk_sku_save clears it, because a widened pattern un-exhausts the sequence.';

drop trigger if exists set_flipdesk_sku_sequences_updated_at on public.flipdesk_sku_sequences;
create trigger set_flipdesk_sku_sequences_updated_at
  before update on public.flipdesk_sku_sequences
  for each row execute function public.set_updated_at();

alter table public.flipdesk_sku_sequences enable row level security;

-- SELECT only, and deliberately no INSERT / UPDATE / DELETE policy at all. The
-- predicate is the 00451 initplan form: the owner fast-path disjunct FIRST,
-- then the helper. That shape is not decoration -- without the disjunct the
-- planner calls the SECURITY DEFINER helper for owner rows too, and
-- scripts/db-rls-initplan-check.mjs runs in the same verify lane as this table's
-- own check. It is copied from inventory_items' live "Workspace members can
-- view inventory" policy read back from pg_policies, so a seat that can see the
-- items can see the counter that numbers them.
drop policy if exists "Workspace members can view sku sequence" on public.flipdesk_sku_sequences;
create policy "Workspace members can view sku sequence"
  on public.flipdesk_sku_sequences for select
  using (
    (select auth.uid()) = user_id
    or public.is_workspace_member_with_role(user_id, 'viewer')
  );

-- ---------------------------------------------------------------------------
-- The odometer. These seven functions are the ONLY home of the carry rule.
--
-- src/test/sku-odometer-single-home.test.ts fails the build if a TypeScript,
-- Swift or Kotlin copy appears. Two implementations of a carry rule drift, and
-- the drift is invisible until two items get the same SKU. The settings preview
-- calls flipdesk_sku_preview (US-3416) rather than computing anything itself.
-- ---------------------------------------------------------------------------

-- A value as a fixed-width string in base length(alphabet). NULL when the value
-- does not fit in p_width characters, which is how the letter wheel reports its
-- own overflow up to flipdesk_sku_advance.
create or replace function public.flipdesk_sku_base(
  p_value int, p_alphabet text, p_width int
) returns text
language plpgsql
immutable
as $$
declare
  base  int  := length(coalesce(p_alphabet, ''));
  v     int  := p_value;
  out_s text := '';
  i     int;
begin
  if base < 1 or coalesce(p_width, 0) < 1 or v is null or v < 0 then
    return null;
  end if;
  for i in 1..p_width loop
    out_s := substr(p_alphabet, (v % base) + 1, 1) || out_s;
    v := v / base;                      -- integer division, both operands int
  end loop;
  if v <> 0 then
    return null;                        -- did not fit in p_width characters
  end if;
  return out_s;
end;
$$;

comment on function public.flipdesk_sku_base(int, text, int) is
  'US-3414: base-N rendering for a letter wheel. NULL means the value overflows p_width.';

-- One {min,max} per COUNTING segment, left to right. A letter wheel's bounds are
-- derived from its alphabet and width; a number wheel carries its own, written
-- by flipdesk_sku_save.
create or replace function public.flipdesk_sku_bounds(p_pattern jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_agg(b order by ord), '[]'::jsonb)
  from (
    select ord,
      case seg->>'kind'
        when 'number' then jsonb_build_object(
          'min', coalesce((seg->>'min')::int, 0),
          'max', coalesce((seg->>'max')::int, 0))
        when 'letter' then jsonb_build_object(
          'min', 0,
          'max', power(
                   length(coalesce(seg->>'alphabet', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')),
                   coalesce((seg->>'width')::int, 1)
                 )::int - 1)
      end as b
    from jsonb_array_elements(
           case when jsonb_typeof(p_pattern) = 'array' then p_pattern
                else '[]'::jsonb end
         ) with ordinality t(seg, ord)
  ) s
  where b is not null;
$$;

comment on function public.flipdesk_sku_bounds(jsonb) is
  'US-3414: the min and max of each counting segment, in pattern order. Non-counting segments are absent, so the result indexes 1:1 onto counters.';

-- The bottom of the odometer: every wheel at its minimum. Used when a yearly
-- sequence rolls over, and as the starting point when a seed finds no match.
create or replace function public.flipdesk_sku_floor(p_pattern jsonb)
returns integer[]
language sql
immutable
as $$
  select coalesce(array_agg((b->>'min')::int order by ord), '{}'::integer[])
  from jsonb_array_elements(public.flipdesk_sku_bounds(p_pattern))
       with ordinality t(b, ord);
$$;

comment on function public.flipdesk_sku_floor(jsonb) is
  'US-3414: the counters array with every wheel at its minimum.';

-- The date segments alone, concatenated. Stored as flipdesk_sku_sequences
-- .date_stamp so the trigger can tell the period rolled over without
-- re-deriving it from the pattern every time.
create or replace function public.flipdesk_sku_render_date(
  p_pattern jsonb, p_stamp date
) returns text
language sql
immutable
as $$
  select coalesce(string_agg(
    to_char(coalesce(p_stamp, date '2000-01-01'),
            case seg->>'format'
              when 'YYYY' then 'YYYY'
              when 'YY'   then 'YY'
              when 'MM'   then 'MM'
              when 'DD'   then 'DD'
              else 'YYYY'
            end),
    '' order by ord), '')
  from jsonb_array_elements(
         case when jsonb_typeof(p_pattern) = 'array' then p_pattern
              else '[]'::jsonb end
       ) with ordinality t(seg, ord)
  where seg->>'kind' = 'date';
$$;

comment on function public.flipdesk_sku_render_date(jsonb, date) is
  'US-3414: just the date segments of a pattern, concatenated. Empty string when the pattern has none.';

-- pattern + counters -> the SKU string. Takes the date as an ARGUMENT rather
-- than calling now(), which is what lets it stay IMMUTABLE and what lets the
-- settings preview render any date it likes.
create or replace function public.flipdesk_sku_render(
  p_pattern jsonb, p_counters integer[], p_stamp date
) returns text
language plpgsql
immutable
as $$
declare
  seg   jsonb;
  out_s text := '';
  ci    int  := 1;
  v     int;
  w     int;
  piece text;
begin
  if p_pattern is null or jsonb_typeof(p_pattern) <> 'array' then
    return null;
  end if;
  for seg in select value from jsonb_array_elements(p_pattern) loop
    case seg->>'kind'
      when 'text' then
        out_s := out_s || coalesce(seg->>'value', '');
      when 'date' then
        out_s := out_s || to_char(coalesce(p_stamp, date '2000-01-01'),
                   case seg->>'format'
                     when 'YYYY' then 'YYYY'
                     when 'YY'   then 'YY'
                     when 'MM'   then 'MM'
                     when 'DD'   then 'DD'
                     else 'YYYY'
                   end);
      when 'number' then
        v  := p_counters[ci];
        ci := ci + 1;
        if v is null then return null; end if;
        w := coalesce((seg->>'width')::int, 0);
        -- lpad with a length of 0 returns the EMPTY STRING, not the input, so
        -- the unpadded case has to be branched rather than folded into lpad.
        out_s := out_s || case when w > 0 then lpad(v::text, w, '0') else v::text end;
      when 'letter' then
        v  := p_counters[ci];
        ci := ci + 1;
        if v is null then return null; end if;
        piece := public.flipdesk_sku_base(
                   v,
                   coalesce(seg->>'alphabet', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
                   coalesce((seg->>'width')::int, 1));
        if piece is null then return null; end if;
        out_s := out_s || piece;
      else
        return null;                    -- an unknown kind is not a rendering
    end case;
  end loop;
  return out_s;
end;
$$;

comment on function public.flipdesk_sku_render(jsonb, integer[], date) is
  'US-3414: pattern + counters -> the SKU string. counters is the NEXT value to issue, so this IS the next SKU with no advance in between. NULL when the pattern or the counters do not line up.';

-- THE ODOMETER. Increment the rightmost wheel; on overflow reset it to its min
-- and carry left. NULL means the leftmost wheel overflowed and the sequence is
-- exhausted. It never wraps -- see the header.
create or replace function public.flipdesk_sku_advance(
  p_pattern jsonb, p_counters integer[]
) returns integer[]
language plpgsql
immutable
as $$
declare
  bounds jsonb     := public.flipdesk_sku_bounds(p_pattern);
  n      int       := jsonb_array_length(bounds);
  c      integer[] := p_counters;
  i      int;
  lo     int;
  hi     int;
begin
  if n = 0 or coalesce(array_length(c, 1), 0) <> n then
    return null;
  end if;
  i := n;
  loop
    lo := (bounds->(i - 1)->>'min')::int;
    hi := (bounds->(i - 1)->>'max')::int;
    if c[i] < hi then
      c[i] := c[i] + 1;
      return c;
    end if;
    c[i] := lo;                         -- this wheel rolls over
    i := i - 1;
    if i < 1 then
      return null;                      -- EXHAUSTED
    end if;
  end loop;
end;
$$;

comment on function public.flipdesk_sku_advance(jsonb, integer[]) is
  'US-3414: the carry rule, and its only home. NULL means exhausted; it never wraps, because a wrap reissues a number the tenant already used.';

-- The inverse of render, used only by the seed in US-3416. NULL means "this
-- string is not one of ours", which the seed reads as "ignore it".
create or replace function public.flipdesk_sku_parse(
  p_pattern jsonb, p_candidate text
) returns integer[]
language plpgsql
immutable
as $$
declare
  seg   jsonb;
  rest  text      := p_candidate;
  out_c integer[] := '{}';
  lit   text;
  w     int;
  chunk text;
  alpha text;
  v     int;
  i     int;
  pos   int;
begin
  if p_candidate is null or p_pattern is null
     or jsonb_typeof(p_pattern) <> 'array' then
    return null;
  end if;
  for seg in select value from jsonb_array_elements(p_pattern) loop
    case seg->>'kind'
      when 'text' then
        lit := coalesce(seg->>'value', '');
        if left(rest, length(lit)) <> lit then return null; end if;
        rest := substr(rest, length(lit) + 1);
      when 'date' then
        -- A date does not participate in ordering, so it is consumed and
        -- discarded rather than checked. Two SKUs from different years still
        -- compare on their counters, which is the ordering that matters.
        w := case seg->>'format' when 'YYYY' then 4 else 2 end;
        if length(rest) < w then return null; end if;
        rest := substr(rest, w + 1);
      when 'number' then
        w := coalesce((seg->>'width')::int, 0);
        if w > 0 then
          chunk := left(rest, w);
          if length(chunk) <> w or chunk !~ '^[0-9]+$' then return null; end if;
        else
          -- Greedy. flipdesk_sku_save (US-3416) is what stops an unpadded
          -- number sitting in front of anything that can start with a digit,
          -- which would make this ambiguous.
          chunk := substring(rest from '^[0-9]+');
          if chunk is null then return null; end if;
        end if;
        rest  := substr(rest, length(chunk) + 1);
        out_c := out_c || chunk::int;
      when 'letter' then
        alpha := coalesce(seg->>'alphabet', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
        w     := coalesce((seg->>'width')::int, 1);
        chunk := left(rest, w);
        if length(chunk) <> w then return null; end if;
        v := 0;
        for i in 1..w loop
          -- position() picks the FIRST match, so a duplicate character in an
          -- alphabet would be silently ambiguous here. flipdesk_sku_save
          -- rejects that at write time instead.
          pos := position(substr(chunk, i, 1) in alpha);
          if pos = 0 then return null; end if;
          v := v * length(alpha) + (pos - 1);
        end loop;
        rest  := substr(rest, w + 1);
        out_c := out_c || v;
      else
        return null;
    end case;
  end loop;
  if rest <> '' then return null; end if; -- trailing junk is not a match
  return out_c;
end;
$$;

comment on function public.flipdesk_sku_parse(jsonb, text) is
  'US-3414: the inverse of flipdesk_sku_render. Returns the counters a SKU string decodes to, or NULL when the string does not fit the pattern. int[] compares element-wise, which IS the odometer order, so the seed can take the highest with an ORDER BY.';

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00802') on conflict do nothing;
