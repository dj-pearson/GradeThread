-- US-3415 -- the SKU trigger fires, writes the right thing, and knows when not
-- to.
--
-- Run it with: node scripts/check-sku-sequences.mjs
--
-- One transaction that ROLLS BACK. CREATE TRIGGER succeeding says nothing about
-- whether the trigger fires, which counter it reads, or whether two concurrent
-- inserts can collide -- and the migration source reads as correct in all three
-- failure modes. Ten cases:
--
--   1. A plain counter issues its value and moves on.
--   2. The letter wheel carries: J9999 then K0000.
--   3. An exhausted sequence flags itself and the NEXT item still saves.
--   4. Twenty inserts in one transaction yield twenty DISTINCT skus.
--   5. A hand-typed J1235 is skipped, not collided with.
--   6. A supplied sku survives untouched AND does not move the counter.
--   7. reset_on_date_change restarts at the floor when the period rolls.
--   8. enabled = false issues nothing.
--   9. A MEMBER inserting into the OWNER's workspace draws from the OWNER's
--      counter. On a solo account a trigger keyed on auth.uid() looks
--      identical, so this is the only case that can tell them apart.
--  10. A tenant with no sequence row at all inserts normally and raises
--      nothing.
--
-- Six separate tenants, because a counter is per tenant and cases sharing one
-- would contaminate each other's counters in ways that read as trigger bugs.

begin;

insert into auth.users (id, email, instance_id, aud, role)
values
  ('aaaaaaaa-0000-0000-0000-00000000d001', 'owner-sku@example.com',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('aaaaaaaa-0000-0000-0000-00000000d002', 'member-sku@example.com',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('aaaaaaaa-0000-0000-0000-00000000d003', 'letters-sku@example.com',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('aaaaaaaa-0000-0000-0000-00000000d004', 'exhaust-sku@example.com',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('aaaaaaaa-0000-0000-0000-00000000d005', 'skip-sku@example.com',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('aaaaaaaa-0000-0000-0000-00000000d006', 'reset-sku@example.com',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('aaaaaaaa-0000-0000-0000-00000000d007', 'norow-sku@example.com',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
on conflict (id) do nothing;

-- Case 9's actor. Without the membership row the authenticated insert is
-- refused by inventory_items' RLS INSERT policy and the fixture fails for a
-- reason that has nothing to do with the trigger.
insert into public.workspace_members (owner_id, member_id, role)
values ('aaaaaaaa-0000-0000-0000-00000000d001',
        'aaaaaaaa-0000-0000-0000-00000000d002', 'listing_manager')
on conflict do nothing;

-- Sequence rows. Everything here is written directly rather than through
-- flipdesk_sku_save, which does not exist until US-3416.
insert into public.flipdesk_sku_sequences
  (user_id, enabled, pattern, counters, reset_on_date_change, date_stamp)
values
  -- 1 + 9: a plain unpadded counter sitting at 1032, owned by d001.
  ('aaaaaaaa-0000-0000-0000-00000000d001', true,
   '[{"kind":"number","width":0,"min":1,"max":99999999}]'::jsonb,
   array[1032], false, ''),
  -- 2: the letter wheel, one tick from the carry.
  ('aaaaaaaa-0000-0000-0000-00000000d003', true,
   '[{"kind":"letter","alphabet":"ABCDEFGHIJKLMNOPQRSTUVWXYZ","width":1},
     {"kind":"number","width":4,"min":0,"max":9999}]'::jsonb,
   array[9, 9999], false, ''),
  -- 3: the very last value the pattern can produce.
  ('aaaaaaaa-0000-0000-0000-00000000d004', true,
   '[{"kind":"letter","alphabet":"ABCDEFGHIJKLMNOPQRSTUVWXYZ","width":1},
     {"kind":"number","width":4,"min":0,"max":9999}]'::jsonb,
   array[25, 9999], false, ''),
  -- 5: sitting on J1234, with J1235 about to be planted in front of it.
  ('aaaaaaaa-0000-0000-0000-00000000d005', true,
   '[{"kind":"letter","alphabet":"ABCDEFGHIJKLMNOPQRSTUVWXYZ","width":1},
     {"kind":"number","width":4,"min":0,"max":9999}]'::jsonb,
   array[9, 1234], false, ''),
  -- 7: a yearly pattern whose stored stamp is LAST year, with the counter well
  -- past the floor. today's render is '26', so the period has rolled.
  ('aaaaaaaa-0000-0000-0000-00000000d006', true,
   '[{"kind":"date","format":"YY"},{"kind":"text","value":"-"},
     {"kind":"number","width":5,"min":1,"max":99999}]'::jsonb,
   array[842], true, '25'),
  -- 8: configured, populated, and switched OFF.
  ('aaaaaaaa-0000-0000-0000-00000000d002', false,
   '[{"kind":"number","width":0,"min":1,"max":99999999}]'::jsonb,
   array[500], false, '');
-- d007 deliberately gets NO row at all. That is case 10.

-- ── 5 (setup). Plant the hand-typed SKU BEFORE anything is generated ─────────
insert into public.inventory_items (id, user_id, title, sku, status)
values ('bbbbbbbb-0000-0000-0000-00000000d050',
        'aaaaaaaa-0000-0000-0000-00000000d005', 'Typed by hand', 'J1235', 'sourced');

-- ── 1. a plain counter issues 1032 and advances ──────────────────────────────
insert into public.inventory_items (id, user_id, title, status)
values ('bbbbbbbb-0000-0000-0000-00000000d010',
        'aaaaaaaa-0000-0000-0000-00000000d001', 'Plain one', 'sourced');

-- ── 6. a supplied sku survives, and the counter must NOT move ────────────────
--
-- SNAPSHOT EITHER SIDE OF THE SUPPLIED INSERT, rather than reading the live row
-- at the end. Tenant d001 is used again by case 9 further down, so a late read
-- reports one number for two different questions: the first draft of this
-- fixture asserted [1033] against a counter that case 9 had already moved to
-- [1034], and reported a perfectly correct trigger as a bug.
create temp table _sku_before_supplied on commit drop as
select counters from public.flipdesk_sku_sequences
 where user_id = 'aaaaaaaa-0000-0000-0000-00000000d001';

insert into public.inventory_items (id, user_id, title, sku, status)
values ('bbbbbbbb-0000-0000-0000-00000000d011',
        'aaaaaaaa-0000-0000-0000-00000000d001', 'Mine', 'MINE-1', 'sourced');

create temp table _sku_after_supplied on commit drop as
select counters from public.flipdesk_sku_sequences
 where user_id = 'aaaaaaaa-0000-0000-0000-00000000d001';

-- ── 2. J9999, then the carry to K0000 ────────────────────────────────────────
insert into public.inventory_items (id, user_id, title, status)
values ('bbbbbbbb-0000-0000-0000-00000000d020',
        'aaaaaaaa-0000-0000-0000-00000000d003', 'Letter one', 'sourced'),
       ('bbbbbbbb-0000-0000-0000-00000000d021',
        'aaaaaaaa-0000-0000-0000-00000000d003', 'Letter two', 'sourced');

-- ── 3. the last value, then one more ─────────────────────────────────────────
insert into public.inventory_items (id, user_id, title, status)
values ('bbbbbbbb-0000-0000-0000-00000000d030',
        'aaaaaaaa-0000-0000-0000-00000000d004', 'Last one', 'sourced');

create temp table _sku_exhaust on commit drop as
select
  (select sku from public.inventory_items
    where id = 'bbbbbbbb-0000-0000-0000-00000000d030') as last_sku,
  (select exhausted from public.flipdesk_sku_sequences
    where user_id = 'aaaaaaaa-0000-0000-0000-00000000d004') as flagged;

-- This one must SAVE, with a NULL sku, rather than raise.
insert into public.inventory_items (id, user_id, title, status)
values ('bbbbbbbb-0000-0000-0000-00000000d031',
        'aaaaaaaa-0000-0000-0000-00000000d004', 'One too many', 'sourced');

-- ── 5. the skip. Two inserts either side of the planted J1235 ────────────────
insert into public.inventory_items (id, user_id, title, status)
values ('bbbbbbbb-0000-0000-0000-00000000d051',
        'aaaaaaaa-0000-0000-0000-00000000d005', 'Skip one', 'sourced'),
       ('bbbbbbbb-0000-0000-0000-00000000d052',
        'aaaaaaaa-0000-0000-0000-00000000d005', 'Skip two', 'sourced');

-- ── 7. the yearly reset ──────────────────────────────────────────────────────
insert into public.inventory_items (id, user_id, title, status)
values ('bbbbbbbb-0000-0000-0000-00000000d060',
        'aaaaaaaa-0000-0000-0000-00000000d006', 'New year', 'sourced');

-- ── 8. numbering off ─────────────────────────────────────────────────────────
insert into public.inventory_items (id, user_id, title, status)
values ('bbbbbbbb-0000-0000-0000-00000000d070',
        'aaaaaaaa-0000-0000-0000-00000000d002', 'Off', 'sourced');

-- ── 10. no sequence row at all ───────────────────────────────────────────────
insert into public.inventory_items (id, user_id, title, status)
values ('bbbbbbbb-0000-0000-0000-00000000d080',
        'aaaaaaaa-0000-0000-0000-00000000d007', 'No row', 'sourced');

-- ── 9. a MEMBER inserting into the OWNER's workspace ─────────────────────────
--
-- The role switch is what makes this case worth anything: as service_role,
-- auth.uid() is NULL and a trigger keyed on it would produce NULL rather than
-- the owner's number, which is a different bug wearing the same symptom.
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"aaaaaaaa-0000-0000-0000-00000000d002","role":"authenticated"}';

insert into public.inventory_items (id, user_id, title, status)
values ('bbbbbbbb-0000-0000-0000-00000000d012',
        'aaaaaaaa-0000-0000-0000-00000000d001', 'By a member', 'sourced');

reset role;

-- ── 4. twenty in one statement, all distinct ─────────────────────────────────
--
-- Not true concurrency -- one transaction cannot contend with itself -- but it
-- is the case that catches the likelier bug by far: a trigger that reads the
-- counter without advancing it, or advances a local copy it never writes back,
-- issues the SAME value twenty times here.
insert into public.inventory_items (user_id, title, status)
select 'aaaaaaaa-0000-0000-0000-00000000d003', 'Bulk ' || g, 'sourced'
  from generate_series(1, 20) g;

select jsonb_build_object(
  -- Asked so a NULL sku can be told apart from a MISSING trigger. Without it
  -- every wrong-tenant bug reports as "the trigger did not fire" and sends the
  -- next reader to look for a CREATE TRIGGER that is right there.
  'trigger_installed', exists (
     select 1 from pg_trigger
      where tgrelid = 'public.inventory_items'::regclass
        and tgname  = 'assign_sku_on_insert'
        and not tgisinternal),

  'plain_sku',        (select sku from public.inventory_items
                        where id = 'bbbbbbbb-0000-0000-0000-00000000d010'),
  -- The snapshot taken straight after case 1, NOT the live row. See the note
  -- above _sku_before_supplied.
  'plain_counters',   (select counters from _sku_before_supplied),

  'supplied_sku',     (select sku from public.inventory_items
                        where id = 'bbbbbbbb-0000-0000-0000-00000000d011'),
  'counters_before_supplied', (select counters from _sku_before_supplied),
  'counters_after_supplied',  (select counters from _sku_after_supplied),

  -- Case 9 issues from the SAME tenant, so the live counter has moved once
  -- more. Reading it here is the proof that it did.
  'counters_after_member', (select counters from public.flipdesk_sku_sequences
                             where user_id = 'aaaaaaaa-0000-0000-0000-00000000d001'),

  'j9999_sku',        (select sku from public.inventory_items
                        where id = 'bbbbbbbb-0000-0000-0000-00000000d020'),
  'k0000_sku',        (select sku from public.inventory_items
                        where id = 'bbbbbbbb-0000-0000-0000-00000000d021'),

  'last_sku',         (select last_sku from _sku_exhaust),
  'exhausted_flag',   (select flagged  from _sku_exhaust),
  'after_exhaust_sku',(select sku from public.inventory_items
                        where id = 'bbbbbbbb-0000-0000-0000-00000000d031'),
  'after_exhaust_saved', exists (select 1 from public.inventory_items
                                  where id = 'bbbbbbbb-0000-0000-0000-00000000d031'),

  'skip_first',       (select sku from public.inventory_items
                        where id = 'bbbbbbbb-0000-0000-0000-00000000d051'),
  'skip_second',      (select sku from public.inventory_items
                        where id = 'bbbbbbbb-0000-0000-0000-00000000d052'),
  'planted_sku',      (select sku from public.inventory_items
                        where id = 'bbbbbbbb-0000-0000-0000-00000000d050'),

  'reset_sku',        (select sku from public.inventory_items
                        where id = 'bbbbbbbb-0000-0000-0000-00000000d060'),
  'reset_stamp',      (select date_stamp from public.flipdesk_sku_sequences
                        where user_id = 'aaaaaaaa-0000-0000-0000-00000000d006'),
  'expected_stamp',   to_char((now() at time zone 'UTC')::date, 'YY'),

  'disabled_sku',     (select sku from public.inventory_items
                        where id = 'bbbbbbbb-0000-0000-0000-00000000d070'),
  'no_row_sku',       (select sku from public.inventory_items
                        where id = 'bbbbbbbb-0000-0000-0000-00000000d080'),
  'no_row_saved',     exists (select 1 from public.inventory_items
                               where id = 'bbbbbbbb-0000-0000-0000-00000000d080'),

  'member_sku',       (select sku from public.inventory_items
                        where id = 'bbbbbbbb-0000-0000-0000-00000000d012'),

  'bulk_total',       (select count(*) from public.inventory_items
                        where user_id = 'aaaaaaaa-0000-0000-0000-00000000d003'
                          and title like 'Bulk %'),
  'bulk_distinct',    (select count(distinct sku) from public.inventory_items
                        where user_id = 'aaaaaaaa-0000-0000-0000-00000000d003'
                          and title like 'Bulk %')
);

rollback;
