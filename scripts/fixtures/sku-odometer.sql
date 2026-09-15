-- US-3414 -- the SKU odometer renders, advances and parses.
--
-- Run it with: node scripts/check-sku-sequences.mjs
--
-- These are pure functions, so this fixture inserts nothing and reads no tenant
-- data. It exists because CREATE FUNCTION does not validate a plpgsql body: a
-- function with a typo in it installs cleanly, raises on its first call, and a
-- source scan reads that as correct. Every one of the seven functions is called
-- here with the two patterns the owner actually uses.
--
-- The two cases that matter most:
--   * plain_next  -- 1032 becomes 1033, unpadded, no leading zero
--   * j9999_next  -- J9999 becomes K0000, which is the carry reaching the
--                    letter wheel. J0000 here would mean it did not.

begin;

with pat as (
  select
    '[{"kind":"number","width":0,"min":1,"max":99999999}]'::jsonb as plain,
    '[{"kind":"letter","alphabet":"ABCDEFGHIJKLMNOPQRSTUVWXYZ","width":1},
      {"kind":"number","width":4,"min":0,"max":9999}]'::jsonb     as jnum,
    '[{"kind":"text","value":"GT-"},{"kind":"date","format":"YY"},
      {"kind":"text","value":"-"},
      {"kind":"number","width":5,"min":1,"max":99999}]'::jsonb    as dated
)
select jsonb_build_object(
  -- 1. An unpadded number renders with no leading zeros, and counts up.
  'plain_1032',      public.flipdesk_sku_render(plain, array[1032], date '2026-09-14'),
  'plain_next',      public.flipdesk_sku_render(
                       plain, public.flipdesk_sku_advance(plain, array[1032]),
                       date '2026-09-14'),

  -- 2. The letter wheel carries. J is index 9 in the default alphabet.
  'j9999',           public.flipdesk_sku_render(jnum, array[9, 9999], date '2026-09-14'),
  'j9999_next',      public.flipdesk_sku_render(
                       jnum, public.flipdesk_sku_advance(jnum, array[9, 9999]),
                       date '2026-09-14'),
  'j1234',           public.flipdesk_sku_render(jnum, array[9, 1234], date '2026-09-14'),

  -- 3. The leftmost wheel overflowing returns NULL. It does not wrap to A0000.
  'z9999_next_null', public.flipdesk_sku_advance(jnum, array[25, 9999]) is null,

  -- 4. A padded wheel that has NOT overflowed still carries within itself.
  'padded_rollover', public.flipdesk_sku_render(
                       jnum, public.flipdesk_sku_advance(jnum, array[0, 9999]),
                       date '2026-09-14'),

  -- 5. Date segments render from the argument, and consume no counter slot:
  --    `dated` has three non-counting segments and one counting one.
  'dated',           public.flipdesk_sku_render(dated, array[42], date '2026-09-14'),
  'date_stamp',      public.flipdesk_sku_render_date(dated, date '2026-09-14'),
  'date_stamp_none', public.flipdesk_sku_render_date(plain, date '2026-09-14'),

  -- 6. Parse is the inverse of render.
  'parse_plain',     public.flipdesk_sku_parse(plain, '1031'),
  'parse_jnum',      public.flipdesk_sku_parse(jnum, 'J1234'),
  'parse_dated',     public.flipdesk_sku_parse(dated, 'GT-26-00042'),

  -- 7. A SKU that is not ours parses to NULL rather than to garbage. Each of
  --    these is a different way to not match: wrong shape, too short, trailing
  --    junk, and a digit where the alphabet requires a letter.
  'parse_foreign',   public.flipdesk_sku_parse(jnum, 'hoodie-blue') is null,
  'parse_short',     public.flipdesk_sku_parse(jnum, 'J123')       is null,
  'parse_trailing',  public.flipdesk_sku_parse(jnum, 'J1234X')     is null,
  'parse_badletter', public.flipdesk_sku_parse(jnum, '91234')      is null,

  -- 8. The floor is the min of every counting segment, in pattern order.
  'floor_jnum',      public.flipdesk_sku_floor(jnum),
  'floor_dated',     public.flipdesk_sku_floor(dated),

  -- 9. Bounds index 1:1 onto counters -- non-counting segments are absent.
  'bounds_len_dated', jsonb_array_length(public.flipdesk_sku_bounds(dated)),

  -- 10. The table exists with the defaults the US-3415 trigger relies on, and
  --     with exactly one policy, which is a SELECT.
  'default_enabled',   (select column_default from information_schema.columns
                         where table_schema = 'public'
                           and table_name = 'flipdesk_sku_sequences'
                           and column_name = 'enabled'),
  'default_exhausted', (select column_default from information_schema.columns
                         where table_schema = 'public'
                           and table_name = 'flipdesk_sku_sequences'
                           and column_name = 'exhausted'),
  'policy_cmds',       (select coalesce(jsonb_agg(distinct cmd), '[]'::jsonb)
                          from pg_policies
                         where schemaname = 'public'
                           and tablename = 'flipdesk_sku_sequences'),
  'rls_enabled',       (select relrowsecurity from pg_class
                         where oid = 'public.flipdesk_sku_sequences'::regclass)
) from pat;

rollback;
