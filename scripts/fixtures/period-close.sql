-- US-2995 -- period close, against real Postgres.
--
-- Run it with: node scripts/check-period-close.mjs
--
-- Inside one transaction that ROLLS BACK. What it proves:
--
--   1. THE LOCK HOLDS AGAINST THE SERVICE ROLE. This is the whole of AC2 and
--      the reason the guard is a trigger and not an RLS policy: the edge uses
--      the service-role client, which BYPASSES RLS, and those are exactly the
--      paths -- routes, jobs, webhooks -- that would rewrite a filed year with
--      nobody watching. Every refusal below is checked as `postgres`, the
--      MOST privileged role available, because a guard that only stops the
--      browser stops nothing that matters.
--   2. Ordinary work in a closed year still goes through. Shipping, tracking
--      and status are NOT frozen: a buyer can open a return in February on a
--      December sale, and refusing that write would break the marketplace sync
--      rather than protect the books. A lock that blocks real work gets
--      switched off.
--   3. An OPEN period is untouched, so the lock is not simply refusing
--      everything.
--   4. Reopening restores writes and keeps the audit row.
--   5. Closing takes the inventory snapshot in the same action (AC5).
begin;

insert into auth.users (id, email, instance_id, aud, role)
values ('a0000000-0000-0000-0000-0000000c1053', 'close@example.com',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
on conflict (id) do nothing;

insert into public.inventory_items (id, user_id, title, acquired_price, acquired_date, status)
values ('b3000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000c1053',
        'Sold in the closed year', 30.00, '2025-02-01', 'sold'),
       ('b3000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-0000000c1053',
        'Still held', 20.00, '2025-03-01', 'listed')
on conflict (id) do nothing;

insert into public.listings (id, inventory_item_id, platform, listing_price, listed_at)
values ('d3000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000001',
        'ebay', 100.00, '2025-03-01')
on conflict (id) do nothing;

insert into public.sales
  (id, user_id, inventory_item_id, listing_id, sale_price, platform_fees, sale_date, status)
values ('c3000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000c1053',
        'b3000000-0000-0000-0000-000000000001', 'd3000000-0000-0000-0000-000000000001',
        100.00, 13.00, '2025-06-01', 'completed')
on conflict (id) do nothing;

insert into public.flipdesk_expenses (id, user_id, category, description, amount, spent_on)
values ('e3000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000c1053',
        'shipping_supplies', 'In the closed year', 40.00, '2025-05-01'),
       ('e3000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-0000000c1053',
        'shipping_supplies', 'In the open year', 40.00, '2026-05-01')
on conflict (id) do nothing;

insert into public.mileage_trips (id, user_id, trip_date, miles, purpose)
values ('73000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000c1053',
        '2025-04-01', 20.0, 'Sourcing in the closed year')
on conflict (id) do nothing;

select public.rebuild_ledger_for_user('a0000000-0000-0000-0000-0000000c1053');

-- 5: close 2025. As the seller, because close_period is SECURITY INVOKER.
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-0000000c1053","role":"authenticated"}';
select 'closed period id' as q, (public.close_period('2025-01-01','2026-01-01','2025') IS NOT NULL)::text as a;
reset role;

select 'snapshot taken by the close' as q, count(*)::text as a
  from public.inventory_snapshots
 where user_id = 'a0000000-0000-0000-0000-0000000c1053' and as_of = '2026-01-01';

select 'closing figures recorded' as q,
       (closing_figures ? 'ledger' and closing_figures ? 'cogs')::text as a
  from public.closed_periods
 where user_id = 'a0000000-0000-0000-0000-0000000c1053' and reopened_at is null;

-- ── 1: THE REFUSALS, ALL AS `postgres` (the service role's privilege level) ──
do $$
begin
  begin
    update public.flipdesk_expenses set amount = 999
     where id = 'e3000000-0000-0000-0000-000000000001';
    raise notice 'FAIL: expense in a closed year was edited';
  exception when others then raise notice 'OK: expense edit refused';
  end;

  begin
    delete from public.flipdesk_expenses
     where id = 'e3000000-0000-0000-0000-000000000001';
    raise notice 'FAIL: expense in a closed year was deleted';
  exception when others then raise notice 'OK: expense delete refused';
  end;

  begin
    insert into public.flipdesk_expenses (user_id, category, description, amount, spent_on)
    values ('a0000000-0000-0000-0000-0000000c1053', 'other', 'Backdated', 5.00, '2025-07-01');
    raise notice 'FAIL: a backdated expense was inserted into a closed year';
  exception when others then raise notice 'OK: backdated insert refused';
  end;

  begin
    update public.mileage_trips set miles = 999
     where id = '73000000-0000-0000-0000-000000000001';
    raise notice 'FAIL: trip in a closed year was edited';
  exception when others then raise notice 'OK: trip edit refused';
  end;

  begin
    update public.sales set sale_price = 999
     where id = 'c3000000-0000-0000-0000-000000000001';
    raise notice 'FAIL: sale money in a closed year was edited';
  exception when others then raise notice 'OK: sale money edit refused';
  end;

  begin
    update public.inventory_items set acquired_price = 999
     where id = 'b3000000-0000-0000-0000-000000000001';
    raise notice 'FAIL: cost of an item sold in a closed year was edited';
  exception when others then raise notice 'OK: cost edit refused';
  end;
end $$;

-- ── 2: ORDINARY WORK IN A CLOSED YEAR STILL GOES THROUGH ────────────────────
do $$
begin
  begin
    update public.sales set tracking_number = '1Z999', carrier = 'UPS'
     where id = 'c3000000-0000-0000-0000-000000000001';
    raise notice 'OK: shipping a closed-year sale still works';
  exception when others then raise notice 'FAIL: shipping was blocked - %', SQLERRM;
  end;

  begin
    update public.inventory_items set title = 'Renamed after close'
     where id = 'b3000000-0000-0000-0000-000000000001';
    raise notice 'OK: renaming an item still works';
  exception when others then raise notice 'FAIL: rename was blocked - %', SQLERRM;
  end;

  -- 3: an OPEN period is untouched.
  begin
    update public.flipdesk_expenses set amount = 41.00
     where id = 'e3000000-0000-0000-0000-000000000002';
    raise notice 'OK: the open year is still editable';
  exception when others then raise notice 'FAIL: the open year was blocked - %', SQLERRM;
  end;

  -- An unsold item's cost has reached no return yet.
  begin
    update public.inventory_items set acquired_price = 21.00
     where id = 'b3000000-0000-0000-0000-000000000002';
    raise notice 'OK: an unsold item cost is still editable';
  exception when others then raise notice 'FAIL: unsold cost was blocked - %', SQLERRM;
  end;
end $$;

-- ── 4: reopening ───────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-0000000c1053","role":"authenticated"}';
do $$
declare v_id uuid;
begin
  select id into v_id from public.closed_periods
   where user_id = 'a0000000-0000-0000-0000-0000000c1053' and reopened_at is null;

  begin
    perform public.reopen_period(v_id, '   ');
    raise notice 'FAIL: reopened with a blank reason';
  exception when others then raise notice 'OK: a blank reason is refused';
  end;

  perform public.reopen_period(v_id, 'Found a missing receipt for March');
  raise notice 'OK: reopened with a reason';
end $$;
reset role;

select 'audit row kept after reopen' as q, count(*)::text as a
  from public.closed_periods
 where user_id = 'a0000000-0000-0000-0000-0000000c1053'
   and reopened_at is not null
   and reopen_reason = 'Found a missing receipt for March';

do $$
begin
  begin
    update public.flipdesk_expenses set amount = 42.00
     where id = 'e3000000-0000-0000-0000-000000000001';
    raise notice 'OK: writes work again after reopening';
  exception when others then raise notice 'FAIL: still locked after reopen - %', SQLERRM;
  end;
end $$;

rollback;
