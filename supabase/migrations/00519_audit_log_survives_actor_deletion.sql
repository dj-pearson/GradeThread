-- US-2350: an admin can no longer erase their own audit trail by leaving.
--
-- See vault/20-domain/audit-log-access-control.md for the full contract; this
-- header states only what the SQL does and why it is shaped this way.
--
-- THE DEFECT. `admin_audit_log.admin_user_id` was declared ON DELETE CASCADE
-- (00003). The append-only guarantee is enforced by RLS policies that permit
-- SELECT and INSERT and nothing else — and a cascade is not a policy-checked
-- DELETE, it is referential action. It goes straight through. So the self-serve
-- account deletion at POST /api/account/delete, which an admin can call for
-- themselves, removed every row that admin had ever authored.
--
-- Three changes, and the order matters because the third depends on the second.
--
-- 1. The FK becomes ON DELETE SET NULL. `admin_user_id` is already nullable
--    (00065 dropped NOT NULL so system entries could be attributed to no human),
--    so nothing else has to change to allow it.
--
-- 2. The row carries the actor's identity itself. SET NULL alone would leave a
--    row that survives but says nothing about who acted — an audit trail with
--    the name cut out is not much better than no row. `actor_email` is captured
--    at write time, so a later deletion cannot take it away.
--
-- 3. A BEFORE INSERT trigger fills `actor_email` and `actor_role` from the
--    users table when the writer did not. Doing it in the database rather than
--    in the edge writer is deliberate: rows arrive from at least three places —
--    lib/audit-log.ts, the 00065 dispute trigger, and the 00518 audit-search
--    self-audit — and a rule that lives in one of them is a rule the other two
--    do not follow.
--
-- ON THE PRIVACY QUESTION, because it is a real one. This deliberately retains
-- an email address after a user asks to be deleted. It applies ONLY to rows
-- where that person acted as an ADMIN, on other people's accounts — refunds,
-- credit grants, role changes, grade voids. An audit trail that a subject can
-- erase by leaving is not an audit trail, and the record of an administrative
-- action taken on someone else is not the actor's personal data to withdraw.
-- Ordinary users are untouched: they author no admin_audit_log rows.

-- 1. FK: CASCADE → SET NULL ─────────────────────────────────────────────────
-- Named explicitly rather than looked up, and dropped with IF EXISTS, so this
-- is safe to re-run and safe on a database where it has already been replaced.
alter table public.admin_audit_log
  drop constraint if exists admin_audit_log_admin_user_id_fkey;

alter table public.admin_audit_log
  add constraint admin_audit_log_admin_user_id_fkey
  foreign key (admin_user_id) references public.users(id) on delete set null;

-- 2. Denormalized actor identity ────────────────────────────────────────────
alter table public.admin_audit_log
  add column if not exists actor_email text;

comment on column public.admin_audit_log.actor_email is
  'US-2350: the acting admin''s email, captured at write time so the row stays '
  'attributable after that user is deleted. NULL for system-originated rows.';

-- Backfill what is still resolvable. Rows whose actor is already gone cannot be
-- recovered — those admins are exactly the ones whose trail the CASCADE erased,
-- so there is nothing left to name.
update public.admin_audit_log a
   set actor_email = u.email
  from public.users u
 where u.id = a.admin_user_id
   and a.actor_email is null;

-- 3. Stamp identity at write time, wherever the row comes from ──────────────
create or replace function public.stamp_audit_actor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only fill what the writer left blank. A caller that knows better — an
  -- impersonation path recording the real operator, say — keeps its own value.
  if new.admin_user_id is not null and (new.actor_email is null or new.actor_role is null) then
    select coalesce(new.actor_email, u.email),
           coalesce(new.actor_role, u.role::text)
      into new.actor_email, new.actor_role
      from public.users u
     where u.id = new.admin_user_id;
  end if;
  return new;
end;
$$;

comment on function public.stamp_audit_actor() is
  'US-2350: fills admin_audit_log.actor_email / actor_role from the users row '
  'at INSERT time. In the database rather than the edge writer because rows '
  'arrive from lib/audit-log.ts, the 00065 dispute trigger and the 00518 '
  'audit-search self-audit — a rule in one writer is not followed by the rest.';

drop trigger if exists trg_stamp_audit_actor on public.admin_audit_log;
create trigger trg_stamp_audit_actor
  before insert on public.admin_audit_log
  for each row execute function public.stamp_audit_actor();

insert into public.applied_migrations (version) values ('00519') on conflict do nothing;
