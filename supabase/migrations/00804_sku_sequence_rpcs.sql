-- US-3416: preview, seed-from-existing, and validated save.
--
-- The three things the settings screen needs, as RPCs rather than as table
-- writes. 00802 gave flipdesk_sku_sequences a SELECT policy and deliberately no
-- write policy: a client that can set `counters` backwards can mint duplicate
-- SKUs, which is the one failure this whole feature exists to prevent. So every
-- write lands here, behind validation, with the caller's right to act on the
-- tenant resolved first.
--
-- THE SEED IS THE POINT OF THE STORY. A seller whose SKUs run 1 to 1031 picks a
-- pattern and is told "Next: 1032" with no typing and no knowledge of their own
-- high-water mark. It reads inventory_items, parses each SKU against the
-- pattern, and returns. It writes NOTHING -- no existing row is renumbered,
-- ever.
--
-- WHO MAY DO WHAT mirrors what workspaceMiddleware enforces on the edge
-- (services/edge-functions/src/middleware/workspace.ts): reading is viewer and
-- up, changing the settings is owner or admin. Two paths to the same data that
-- disagree about permission is its own bug class, so the floors are stated once
-- here and once there, and they match.

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

-- is_workspace_member_with_role already contains the owner disjunct, so these
-- wrappers exist for the NAME rather than for the logic: a reader of
-- flipdesk_sku_save should not have to work out what role floor a bare helper
-- call implies. The repeated (select auth.uid()) = p_owner is the initplan
-- fast path, same as the RLS policies use -- it settles the common solo-account
-- case without calling into a SECURITY DEFINER function at all.

create or replace function public.flipdesk_sku_may_read(p_owner uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (select auth.uid()) = p_owner
      or public.is_workspace_member_with_role(p_owner, 'viewer');
$$;

create or replace function public.flipdesk_sku_may_write(p_owner uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (select auth.uid()) = p_owner
      or public.is_workspace_member_with_role(p_owner, 'admin');
$$;

comment on function public.flipdesk_sku_may_write(uuid) is
  'US-3416: owner or admin. A listing_manager can create items all day and every one of them draws a number; what they cannot do is change the shape of everybody else''s SKUs.';

-- ---------------------------------------------------------------------------
-- Validation, in ONE place
--
-- Returns NULL when the pattern is usable, otherwise a message written for a
-- seller to read -- the settings screen shows these verbatim rather than
-- inventing its own wording. flipdesk_sku_save raises it and flipdesk_sku_preview
-- raises it too, so a half-built pattern explains itself while it is being
-- built instead of only at the moment of saving.
-- ---------------------------------------------------------------------------

create or replace function public.flipdesk_sku_validate(
  p_pattern jsonb, p_counters integer[]
) returns text
language plpgsql
immutable
as $$
declare
  seg     jsonb;
  nxt_seg jsonb;
  ord     int := 0;
  total   int;
  n       int;
  bounds  jsonb;
  alpha   text;
  w       int;
  lo      int;
  hi      int;
  top_c   integer[];
  longest text;
  i       int;
begin
  if p_pattern is null or jsonb_typeof(p_pattern) <> 'array' then
    return 'The pattern must be a list of segments.';
  end if;

  total := jsonb_array_length(p_pattern);
  if total = 0 then
    return 'A SKU pattern needs at least one segment.';
  end if;

  for seg in select value from jsonb_array_elements(p_pattern) loop
    ord := ord + 1;

    if seg->>'kind' not in ('text', 'date', 'number', 'letter') then
      return format('%s is not a kind of segment this understands.',
                    coalesce(seg->>'kind', 'A blank segment'));
    end if;

    if seg->>'kind' = 'date'
       and coalesce(seg->>'format', '') not in ('YYYY', 'YY', 'MM', 'DD') then
      return 'A date segment must be YYYY, YY, MM or DD.';
    end if;

    if seg->>'kind' = 'letter' then
      alpha := coalesce(seg->>'alphabet', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      w     := coalesce((seg->>'width')::int, 1);
      if length(alpha) < 2 then
        return 'A letter segment needs at least two characters to cycle through.';
      end if;
      -- position() picks the FIRST match when it reads a SKU back, so a repeat
      -- would be silently ambiguous rather than wrong in any visible way.
      if length(alpha) <> (
        select count(distinct ch) from unnest(string_to_array(alpha, null)) ch
      ) then
        return format('A letter segment cannot repeat a character: %s', alpha);
      end if;
      -- 26^6 overflows a four-byte integer, and the overflow surfaces as a
      -- Postgres error rather than as anything a seller could act on.
      if w < 1 or w > 5 then
        return 'A letter segment has to be between one and five letters wide.';
      end if;
    end if;

    if seg->>'kind' = 'number' then
      w  := coalesce((seg->>'width')::int, 0);
      lo := coalesce((seg->>'min')::int, 0);
      hi := coalesce((seg->>'max')::int, 0);
      if w < 0 or w > 9 then
        return 'A number segment has to be between zero and nine digits wide.';
      end if;
      if lo > hi then
        return 'A number segment cannot have a minimum above its maximum.';
      end if;
      if hi < 1 then
        return 'A number segment needs a maximum of at least 1 to count to.';
      end if;
      -- An unpadded number is read back greedily when the seed parses existing
      -- SKUs, so anything after it that can begin with a digit makes the string
      -- ambiguous: '1032' followed by a '5' segment reads as 10325.
      if w = 0 and ord < total then
        nxt_seg := p_pattern->ord;          -- ord is 1-based, -> is 0-based
        if nxt_seg->>'kind' <> 'text'
           or coalesce(nxt_seg->>'value', '') ~ '^[0-9]' then
          return 'A number with no leading zeros has to be last, or be followed by text that does not start with a digit.';
        end if;
      end if;
    end if;
  end loop;

  bounds := public.flipdesk_sku_bounds(p_pattern);
  n      := jsonb_array_length(bounds);
  if n = 0 then
    return 'A SKU pattern needs at least one number or letter to count.';
  end if;

  if p_counters is not null then
    if coalesce(array_length(p_counters, 1), 0) <> n then
      return format(
        'The starting value has %s part(s) but the pattern counts %s of them.',
        coalesce(array_length(p_counters, 1), 0), n);
    end if;
    for i in 1..n loop
      if p_counters[i] < (bounds->(i - 1)->>'min')::int
         or p_counters[i] > (bounds->(i - 1)->>'max')::int then
        return format('Part %s of the starting value is outside what the pattern allows.', i);
      end if;
    end loop;
  end if;

  -- The longest this pattern can ever render. eBay caps its own SKU at 50 and
  -- this string is what a seller reaches for when they fill listings
  -- .inventory_sku, so catching it here beats discovering it at publish time.
  select array_agg((b->>'max')::int order by o) into top_c
    from jsonb_array_elements(bounds) with ordinality t(b, o);
  longest := public.flipdesk_sku_render(p_pattern, top_c, date '2026-12-31');
  if longest is null then
    return 'That pattern cannot be rendered. Check the segment widths.';
  end if;
  if length(longest) > 50 then
    return format('This pattern can reach %s characters. SKUs are capped at 50.',
                  length(longest));
  end if;

  return null;
end;
$$;

comment on function public.flipdesk_sku_validate(jsonb, integer[]) is
  'US-3416: NULL when the pattern is usable, otherwise a message written for a seller to read. flipdesk_sku_preview and flipdesk_sku_save both raise it, so the rule has one home and the wording is identical wherever it surfaces.';

-- ---------------------------------------------------------------------------
-- Preview
-- ---------------------------------------------------------------------------

create or replace function public.flipdesk_sku_preview(
  p_owner uuid, p_pattern jsonb, p_counters integer[], p_count int
) returns text[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  out_a text[]     := '{}';
  c     integer[]  := p_counters;
  cand  text;
  bad   text;
  today date := (now() at time zone 'UTC')::date;
  n     int  := least(greatest(coalesce(p_count, 5), 1), 25);
  tries int  := 0;
begin
  if not public.flipdesk_sku_may_read(p_owner) then
    raise exception 'You do not have access to that workspace' using errcode = '42501';
  end if;

  bad := public.flipdesk_sku_validate(p_pattern, p_counters);
  if bad is not null then
    raise exception '%', bad using errcode = '22023';
  end if;

  while coalesce(array_length(out_a, 1), 0) < n loop
    tries := tries + 1;
    if c is null or tries > 1000 then
      -- A SHORT LIST IS THE HONEST ANSWER. Returning fewer than asked means the
      -- sequence genuinely runs out inside that many values, and the settings
      -- screen showing three where it asked for five is the truth.
      exit;
    end if;
    cand := public.flipdesk_sku_render(p_pattern, c, today);
    exit when cand is null;
    -- Skip what is already taken, for the same reason the trigger does: the
    -- preview has to show what the seller will ACTUALLY get, not what an empty
    -- account would have got.
    if not exists (select 1 from public.inventory_items
                    where user_id = p_owner and sku = cand) then
      out_a := out_a || cand;
    end if;
    c := public.flipdesk_sku_advance(p_pattern, c);
  end loop;

  return out_a;
end;
$$;

comment on function public.flipdesk_sku_preview(uuid, jsonb, integer[], int) is
  'US-3416: the next p_count SKUs this pattern would issue, skipping values the tenant already holds. Reads only. The FIRST element is render(pattern, counters) with no advance, because counters is the next value to issue.';

-- ---------------------------------------------------------------------------
-- Seed
-- ---------------------------------------------------------------------------

create or replace function public.flipdesk_sku_seed(
  p_owner uuid, p_pattern jsonb
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  best_sku text;
  best_c   integer[];
  hits     int;
  nxt      integer[];
  bad      text;
begin
  if not public.flipdesk_sku_may_read(p_owner) then
    raise exception 'You do not have access to that workspace' using errcode = '42501';
  end if;

  -- Counters are not supplied here; the whole point is to work out what they
  -- should be. NULL tells the validator to check the pattern alone.
  bad := public.flipdesk_sku_validate(p_pattern, null);
  if bad is not null then
    raise exception '%', bad using errcode = '22023';
  end if;

  -- int[] compares element-wise, left to right, which IS the odometer order --
  -- so "the highest SKU" is an ORDER BY on the parsed counters and needs no
  -- special-casing for a letter wheel. There is no max() over arrays, hence
  -- ORDER BY ... LIMIT 1 rather than an aggregate.
  select m.sku, m.c, m.cnt
    into best_sku, best_c, hits
  from (
    select i.sku,
           public.flipdesk_sku_parse(p_pattern, i.sku) as c,
           count(*) over ()                            as cnt
      from public.inventory_items i
     where i.user_id = p_owner
       and i.sku is not null
       and public.flipdesk_sku_parse(p_pattern, i.sku) is not null
  ) m
  order by m.c desc
  limit 1;

  if best_c is null then
    return jsonb_build_object(
      'counters',    public.flipdesk_sku_floor(p_pattern),
      'matched',     null,
      'match_count', 0);
  end if;

  -- One past the highest. When the highest IS the last value the pattern can
  -- produce, advance returns NULL and there is nowhere to start; hand back the
  -- matched value so the screen can say so rather than silently offering a
  -- duplicate.
  nxt := public.flipdesk_sku_advance(p_pattern, best_c);
  return jsonb_build_object(
    'counters',    coalesce(nxt, best_c),
    'matched',     best_sku,
    'match_count', coalesce(hits, 0),
    'exhausted',   (nxt is null));
end;
$$;

comment on function public.flipdesk_sku_seed(uuid, jsonb) is
  'US-3416: read the tenant''s existing SKUs, find the highest that fits this pattern, and return the counters that would follow it. Writes nothing; no existing row is ever renumbered. matched is NULL when nothing fits, and counters is then the pattern floor.';

-- ---------------------------------------------------------------------------
-- Save
-- ---------------------------------------------------------------------------

create or replace function public.flipdesk_sku_save(
  p_owner    uuid,
  p_pattern  jsonb,
  p_counters integer[],
  p_enabled  boolean,
  p_reset    boolean
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  bad text;
begin
  if not public.flipdesk_sku_may_write(p_owner) then
    raise exception 'Only the workspace owner or an admin can change SKU numbering'
      using errcode = '42501';
  end if;

  bad := public.flipdesk_sku_validate(p_pattern, p_counters);
  if bad is not null then
    raise exception '%', bad using errcode = '22023';
  end if;

  insert into public.flipdesk_sku_sequences
    (user_id, enabled, pattern, counters, reset_on_date_change, exhausted, date_stamp)
  values
    (p_owner, coalesce(p_enabled, false), p_pattern, p_counters,
     coalesce(p_reset, false), false,
     public.flipdesk_sku_render_date(p_pattern, (now() at time zone 'UTC')::date))
  on conflict (user_id) do update
     set enabled              = excluded.enabled,
         pattern              = excluded.pattern,
         counters             = excluded.counters,
         reset_on_date_change = excluded.reset_on_date_change,
         date_stamp           = excluded.date_stamp,
         -- A widened pattern un-exhausts the sequence, and saving is the only
         -- way a pattern gets wider, so clearing it here is unconditional.
         exhausted            = false,
         updated_at           = now();

  return jsonb_build_object('ok', true);
end;
$$;

comment on function public.flipdesk_sku_save(uuid, jsonb, integer[], boolean, boolean) is
  'US-3416: the only write path to flipdesk_sku_sequences. Validates first, clears exhausted, and refuses anyone below admin.';

grant execute on function public.flipdesk_sku_may_read(uuid)            to authenticated;
grant execute on function public.flipdesk_sku_may_write(uuid)           to authenticated;
grant execute on function public.flipdesk_sku_validate(jsonb, integer[]) to authenticated;
grant execute on function public.flipdesk_sku_preview(uuid, jsonb, integer[], int) to authenticated;
grant execute on function public.flipdesk_sku_seed(uuid, jsonb)         to authenticated;
grant execute on function public.flipdesk_sku_save(uuid, jsonb, integer[], boolean, boolean) to authenticated;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00804') on conflict do nothing;
