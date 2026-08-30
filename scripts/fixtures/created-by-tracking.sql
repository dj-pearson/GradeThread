-- US-3023 -- created_by is stamped, is not stamped, and cannot be rewritten.
--
-- Run it with: node scripts/check-created-by.mjs
--
-- One transaction that ROLLS BACK. The claim is one no source scan can make:
-- CREATE TRIGGER succeeding says nothing about whether the trigger fires, what
-- it writes, or whether a later UPDATE can undo it. Five cases:
--
--   1. An authenticated insert is stamped with that member's uid.
--   2. A service-role insert is left NULL -- and does not error.
--   3. An authenticated UPDATE cannot rewrite the column, in either direction
--      (to another uid, or to NULL).
--   4. The rest of that same UPDATE still lands, so the guard pins one column
--      rather than silently dropping the write.
--   5. Service-role CAN still correct a row.
--
-- Listings are checked too, not only items: they carry their own pre-existing
-- BEFORE INSERT trigger (set_tenant_from_inventory_item, which fills user_id
-- from the parent), and a second trigger landing beside an existing one is
-- exactly the kind of interaction that works on one table and not the other.
--
-- The actor is a MEMBER of the owner's workspace, not the owner. That is the
-- whole point of the column: user_id is the tenant and created_by is the
-- actor, and a fixture where they are the same person cannot tell them apart.

begin;

insert into auth.users (id, email, instance_id, aud, role)
values ('aaaaaaaa-0000-0000-0000-00000000c001', 'owner-cb@example.com',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
       ('aaaaaaaa-0000-0000-0000-00000000c002', 'member-cb@example.com',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
on conflict (id) do nothing;

-- Without this the authenticated inserts below are refused by the RLS INSERT
-- policy and the whole fixture fails for a reason that has nothing to do with
-- the trigger it exists to test.
insert into public.workspace_members (owner_id, member_id, role)
values ('aaaaaaaa-0000-0000-0000-00000000c001',
        'aaaaaaaa-0000-0000-0000-00000000c002', 'listing_manager')
on conflict do nothing;

-- ── 1. an authenticated insert is stamped ────────────────────────────────────
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"aaaaaaaa-0000-0000-0000-00000000c002","role":"authenticated"}';

insert into public.inventory_items (id, user_id, title, status)
values ('bbbbbbbb-0000-0000-0000-00000000c001',
        'aaaaaaaa-0000-0000-0000-00000000c001', 'Stamped item', 'listed');

insert into public.listings (id, inventory_item_id, platform, listing_price)
values ('11111111-0000-0000-0000-00000000c001',
        'bbbbbbbb-0000-0000-0000-00000000c001', 'ebay', 40.00);

-- SNAPSHOT THE VALUE BEFORE THE UPDATE TOUCHES IT.
--
-- Without this the fixture reports one number for two different questions, and
-- a broken immutability guard shows up as "the insert was not stamped" --
-- sending the next reader to the wrong trigger entirely. Measured: dropping the
-- guard produced exactly that misattribution before the snapshot existed.
create temp table _cb_after_insert on commit drop as
select
  (select created_by from public.inventory_items
    where id = 'bbbbbbbb-0000-0000-0000-00000000c001') as item_created_by,
  (select created_by from public.listings
    where id = '11111111-0000-0000-0000-00000000c001') as listing_created_by;

-- ── 3 + 4. an authenticated UPDATE must not rewrite it, but must still land ──
update public.inventory_items
   set created_by = 'aaaaaaaa-0000-0000-0000-00000000c001',
       title = 'Stamped item, renamed'
 where id = 'bbbbbbbb-0000-0000-0000-00000000c001';

-- Nulling it is the other half, and the likelier one in practice: a client
-- reading a whole row, changing one field and writing the object back.
update public.listings
   set created_by = null, listing_price = 41.00
 where id = '11111111-0000-0000-0000-00000000c001';

reset role;

-- ── 2. a service-role insert is left NULL and does not error ─────────────────
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

insert into public.inventory_items (id, user_id, title, status)
values ('bbbbbbbb-0000-0000-0000-00000000c002',
        'aaaaaaaa-0000-0000-0000-00000000c001', 'Job-made item', 'listed');

insert into public.listings (id, inventory_item_id, platform, listing_price)
values ('11111111-0000-0000-0000-00000000c002',
        'bbbbbbbb-0000-0000-0000-00000000c002', 'ebay', 15.00);

-- ── 5. service-role can still correct a row ──────────────────────────────────
-- A THIRD item, on purpose. Correcting the job-made item would overwrite the
-- very NULL case 2 asserts, and the fixture would then prove one of the two
-- claims while quietly destroying the evidence for the other.
insert into public.inventory_items (id, user_id, title, status)
values ('bbbbbbbb-0000-0000-0000-00000000c003',
        'aaaaaaaa-0000-0000-0000-00000000c001', 'Correctable item', 'listed');

update public.inventory_items
   set created_by = 'aaaaaaaa-0000-0000-0000-00000000c002'
 where id = 'bbbbbbbb-0000-0000-0000-00000000c003';

reset role;

select jsonb_pretty(jsonb_build_object(
  -- What the INSERT trigger wrote, before anything else ran.
  'item_stamped_by', (select item_created_by::text from _cb_after_insert),
  'listing_stamped_by_at_insert', (
    select listing_created_by::text from _cb_after_insert),
  -- What survived the authenticated UPDATE. Same column, different question.
  'item_after_update', (
    select created_by::text from public.inventory_items
     where id = 'bbbbbbbb-0000-0000-0000-00000000c001'),
  'item_title_did_change', (
    select title = 'Stamped item, renamed' from public.inventory_items
     where id = 'bbbbbbbb-0000-0000-0000-00000000c001'),
  'listing_stamped_by', (
    select created_by::text from public.listings
     where id = '11111111-0000-0000-0000-00000000c001'),
  'listing_price_did_change', (
    select listing_price = 41.00 from public.listings
     where id = '11111111-0000-0000-0000-00000000c001'),
  'job_item_created_by_is_null', (
    select created_by is null from public.inventory_items
     where id = 'bbbbbbbb-0000-0000-0000-00000000c002'),
  'job_listing_created_by_is_null', (
    select created_by is null from public.listings
     where id = '11111111-0000-0000-0000-00000000c002'),
  'service_role_correction_took', (
    select created_by::text from public.inventory_items
     where id = 'bbbbbbbb-0000-0000-0000-00000000c003'),
  'member_uid', 'aaaaaaaa-0000-0000-0000-00000000c002',
  'owner_uid', 'aaaaaaaa-0000-0000-0000-00000000c001'
)) as result;

rollback;
