-- US-3416 -- preview, seed and save do what the settings screen believes.
--
-- Run it with: node scripts/check-sku-sequences.mjs
--
-- One transaction that ROLLS BACK. The seed is the case worth the most here: a
-- seller whose SKUs run 1 to 1031 must be told 1032, and must be told it
-- without any row of theirs being touched. Getting that wrong by one starts a
-- tenant's numbering on top of items they already own, and the unique index
-- then rejects saves they cannot explain.
--
-- Every rejection is asserted on its MESSAGE, not merely on "it raised". The
-- settings screen shows these strings verbatim, so a validator that refuses the
-- right patterns while saying the wrong thing is still broken.

begin;

insert into auth.users (id, email, instance_id, aud, role)
values
  ('aaaaaaaa-0000-0000-0000-00000000e001', 'owner-rpc@example.com',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('aaaaaaaa-0000-0000-0000-00000000e002', 'viewer-rpc@example.com',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('aaaaaaaa-0000-0000-0000-00000000e003', 'empty-rpc@example.com',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
on conflict (id) do nothing;

insert into public.workspace_members (owner_id, member_id, role)
values ('aaaaaaaa-0000-0000-0000-00000000e001',
        'aaaaaaaa-0000-0000-0000-00000000e002', 'viewer')
on conflict do nothing;

-- 1031 items numbered 1..1031, plus two that do NOT fit the pattern. The
-- non-matching pair is the half that proves the seed IGNORES rather than
-- chokes: an account that has ever used another numbering scheme, or imported
-- somebody else's SKUs, has strings like these in it.
insert into public.inventory_items (user_id, title, sku, status)
select 'aaaaaaaa-0000-0000-0000-00000000e001', 'Item ' || g, g::text, 'sourced'
  from generate_series(1, 1031) g;

insert into public.inventory_items (user_id, title, sku, status)
values ('aaaaaaaa-0000-0000-0000-00000000e001', 'Not ours',    'hoodie-blue', 'sourced'),
       ('aaaaaaaa-0000-0000-0000-00000000e001', 'Other scheme', 'J1234',      'sourced');

-- A helper that runs a statement and returns its error message, so a rejection
-- can be asserted on its WORDING rather than on the fact that something threw.
create or replace function pg_temp._sku_err(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return null;                       -- no error: the validator let it through
exception when others then
  return sqlerrm;
end;
$$;

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"aaaaaaaa-0000-0000-0000-00000000e001","role":"authenticated"}';

create temp table _sku_rpc on commit drop as
select
  -- ── 1. the seed, against 1..1031 ──────────────────────────────────────────
  public.flipdesk_sku_seed(
    'aaaaaaaa-0000-0000-0000-00000000e001',
    '[{"kind":"number","width":0,"min":1,"max":99999999}]'::jsonb) as seed_plain,

  -- ── 2. the seed against a pattern nothing matches ─────────────────────────
  public.flipdesk_sku_seed(
    'aaaaaaaa-0000-0000-0000-00000000e001',
    '[{"kind":"text","value":"ZZ-"},
      {"kind":"number","width":4,"min":7,"max":9999}]'::jsonb)     as seed_nomatch,

  -- ── 4. preview does not advance before the first value ────────────────────
  public.flipdesk_sku_preview(
    'aaaaaaaa-0000-0000-0000-00000000e001',
    '[{"kind":"letter","alphabet":"ABCDEFGHIJKLMNOPQRSTUVWXYZ","width":1},
      {"kind":"number","width":4,"min":0,"max":9999}]'::jsonb,
    array[9, 1230], 5)                                             as preview_letters,

  -- ── 5. preview skips what the tenant already holds. J1234 is planted above,
  --       so a window starting at J1232 must come back without it.
  public.flipdesk_sku_preview(
    'aaaaaaaa-0000-0000-0000-00000000e001',
    '[{"kind":"letter","alphabet":"ABCDEFGHIJKLMNOPQRSTUVWXYZ","width":1},
      {"kind":"number","width":4,"min":0,"max":9999}]'::jsonb,
    array[9, 1232], 4)                                             as preview_skips,

  -- ── 6..11. the rejections, each read back as its message ──────────────────
  pg_temp._sku_err($$select public.flipdesk_sku_save(
    'aaaaaaaa-0000-0000-0000-00000000e001',
    '[{"kind":"text","value":"NOPE"}]'::jsonb, array[]::integer[], true, false)$$)
                                                                   as err_no_counter,
  pg_temp._sku_err($$select public.flipdesk_sku_save(
    'aaaaaaaa-0000-0000-0000-00000000e001',
    '[{"kind":"letter","alphabet":"AABB","width":1}]'::jsonb, array[0], true, false)$$)
                                                                   as err_dupe_alpha,
  pg_temp._sku_err($$select public.flipdesk_sku_save(
    'aaaaaaaa-0000-0000-0000-00000000e001',
    '[{"kind":"number","width":0,"min":1,"max":9999},
      {"kind":"number","width":4,"min":0,"max":9999}]'::jsonb, array[1,0], true, false)$$)
                                                                   as err_greedy,
  pg_temp._sku_err($$select public.flipdesk_sku_save(
    'aaaaaaaa-0000-0000-0000-00000000e001',
    '[{"kind":"number","width":9,"min":0,"max":999999999},
      {"kind":"text","value":"-0123456789012345678901234567890123456789012"}]'::jsonb,
    array[0], true, false)$$)                                      as err_too_long,
  pg_temp._sku_err($$select public.flipdesk_sku_save(
    'aaaaaaaa-0000-0000-0000-00000000e001',
    '[{"kind":"number","width":4,"min":0,"max":9999}]'::jsonb, array[1,2], true, false)$$)
                                                                   as err_wrong_len,
  pg_temp._sku_err($$select public.flipdesk_sku_save(
    'aaaaaaaa-0000-0000-0000-00000000e001',
    '[{"kind":"number","width":4,"min":0,"max":9999}]'::jsonb, array[50000], true, false)$$)
                                                                   as err_out_of_range;

-- ── 12. a good save lands, and CLEARS a previously set exhausted ────────────
--
-- The flag is planted as service_role because 00802 gives the table no write
-- policy at all -- which is the property being relied on, not a workaround.
reset role;
insert into public.flipdesk_sku_sequences (user_id, enabled, pattern, counters, exhausted)
values ('aaaaaaaa-0000-0000-0000-00000000e001', true,
        '[{"kind":"number","width":4,"min":0,"max":9999}]'::jsonb, array[9999], true)
on conflict (user_id) do update set exhausted = true;

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"aaaaaaaa-0000-0000-0000-00000000e001","role":"authenticated"}';

select public.flipdesk_sku_save(
  'aaaaaaaa-0000-0000-0000-00000000e001',
  '[{"kind":"number","width":0,"min":1,"max":99999999}]'::jsonb,
  array[1032], true, false);

-- ── 13. a VIEWER may preview but may not save ──────────────────────────────
set local request.jwt.claims =
  '{"sub":"aaaaaaaa-0000-0000-0000-00000000e002","role":"authenticated"}';

create temp table _sku_viewer on commit drop as
select
  pg_temp._sku_err($$select public.flipdesk_sku_save(
    'aaaaaaaa-0000-0000-0000-00000000e001',
    '[{"kind":"number","width":0,"min":1,"max":99999999}]'::jsonb,
    array[5], true, false)$$)                                      as viewer_save_err,
  pg_temp._sku_err($$select public.flipdesk_sku_preview(
    'aaaaaaaa-0000-0000-0000-00000000e001',
    '[{"kind":"number","width":0,"min":1,"max":99999999}]'::jsonb,
    array[5], 2)$$)                                                as viewer_preview_err;

-- ── 14. somebody with no membership at all reads nothing ───────────────────
--
-- e003 owns no items and belongs to nobody's workspace, so it does double duty:
-- it is the stranger here, and it is the empty-account seed below. Asking for
-- e003's OWN seed while acting as e001 is what the first draft of this fixture
-- did, and the refusal it got was correct -- a tenant cannot read another
-- tenant's numbering. The empty-account case has to be asked as its own owner.
set local request.jwt.claims =
  '{"sub":"aaaaaaaa-0000-0000-0000-00000000e003","role":"authenticated"}';

create temp table _sku_stranger on commit drop as
select
  pg_temp._sku_err($$select public.flipdesk_sku_preview(
    'aaaaaaaa-0000-0000-0000-00000000e001',
    '[{"kind":"number","width":0,"min":1,"max":99999999}]'::jsonb,
    array[5], 2)$$)                                                as stranger_err,
  -- ── 3. the seed for a tenant with no items at all ───────────────────────
  public.flipdesk_sku_seed(
    'aaaaaaaa-0000-0000-0000-00000000e003',
    '[{"kind":"number","width":0,"min":1,"max":99999999}]'::jsonb)  as seed_empty;

reset role;

select jsonb_build_object(
  'seed_plain_counters',  (select seed_plain->'counters'    from _sku_rpc),
  'seed_plain_matched',   (select seed_plain->>'matched'    from _sku_rpc),
  'seed_plain_count',     (select seed_plain->>'match_count' from _sku_rpc),
  'seed_nomatch_counters',(select seed_nomatch->'counters'  from _sku_rpc),
  'seed_nomatch_matched', (select seed_nomatch->>'matched'  from _sku_rpc),
  'seed_empty_counters',  (select seed_empty->'counters'    from _sku_stranger),

  'preview_letters',      (select preview_letters from _sku_rpc),
  'preview_skips',        (select preview_skips   from _sku_rpc),

  'err_no_counter',       (select err_no_counter   from _sku_rpc),
  'err_dupe_alpha',       (select err_dupe_alpha   from _sku_rpc),
  'err_greedy',           (select err_greedy       from _sku_rpc),
  'err_too_long',         (select err_too_long     from _sku_rpc),
  'err_wrong_len',        (select err_wrong_len    from _sku_rpc),
  'err_out_of_range',     (select err_out_of_range from _sku_rpc),

  'saved_enabled',   (select enabled   from public.flipdesk_sku_sequences
                       where user_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  'saved_counters',  (select counters  from public.flipdesk_sku_sequences
                       where user_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),
  'saved_exhausted', (select exhausted from public.flipdesk_sku_sequences
                       where user_id = 'aaaaaaaa-0000-0000-0000-00000000e001'),

  'viewer_save_err',    (select viewer_save_err    from _sku_viewer),
  'viewer_preview_err', (select viewer_preview_err from _sku_viewer),
  'stranger_err',       (select stranger_err       from _sku_stranger)
);

rollback;
