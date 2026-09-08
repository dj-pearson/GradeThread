-- US-3142: tell an extension push subscription apart from a browser one.
--
-- 00474 stores one PushManager subscription per row and deliverPush() fans every
-- notification out to all of them. The extension's service worker now registers
-- a subscription of its own, and the two must never receive each other's
-- traffic: a browser subscription is userVisibleOnly and Chrome will show a
-- generic notification if the page's worker shows none, so a silent wake sent to
-- one would surface as "This site has been updated in the background".
--
-- `kind` defaults to 'browser', so every existing row keeps exactly the
-- behaviour it has today and deliverPush's new filter is a no-op on them.

alter table public.push_subscriptions
  add column if not exists kind text not null default 'browser';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'push_subscriptions_kind_check'
  ) then
    alter table public.push_subscriptions
      add constraint push_subscriptions_kind_check
      check (kind in ('browser', 'extension'));
  end if;
end $$;

-- The delivery queries filter on (user_id, kind); the existing index is on
-- user_id alone.
create index if not exists push_subscriptions_user_kind_idx
  on public.push_subscriptions (user_id, kind);

insert into public.applied_migrations (version) values ('00764') on conflict do nothing;
