-- US-2351 [P0]: impersonation becomes bounded, visible and revocable.
--
-- See vault/20-domain/impersonation.md for the contract. This header states
-- what the table is and why its shape is what it is.
--
-- WHAT WAS MISSING. The ENTRY to impersonation was well guarded — super_admin,
-- users:role scope, fresh step-up, privileged targets refused, start audited.
-- Everything after the token was minted was open:
--
--   • no time limit — the minted magic link yields an ordinary Supabase session
--     for the target, access token plus long-lived refresh token, sitting in the
--     admin's browser with no cap anywhere;
--   • no revocation — /stop only redeemed the admin's resume token and never
--     signed the target out, so a copied refresh token outlived the session;
--   • no marker — nothing server-side said "this request is an impersonation",
--     so every action taken while impersonating was indistinguishable from the
--     real user's, including deleting their account.
--
-- This table is the marker, the clock and the revocation record in one. It has
-- to be server-side: a claim in the token would be equally invisible to a route
-- that does not parse it, and could not be revoked once minted.
--
-- COLUMN NAMES, deliberately `actor_id` / `target_id` rather than
-- `actor_user_id` / `target_user_id`: rls-guard_test discovers tenant tables by
-- looking for the literal string `user_id` in the CREATE TABLE block, and this
-- is an OPERATOR table, not tenant data. The migrations skill calls this out.
--
-- NULLABLE ACTOR AND TARGET WITH SET NULL, and the emails denormalized beside
-- them — the same lesson 00519 learned on the audit log. A NOT NULL column
-- cannot be SET NULL, so the FK would have to cascade, and a cascade would let
-- the deletion of either party erase the record that the impersonation happened.

create table if not exists public.admin_impersonation_sessions (
  id            uuid primary key default gen_random_uuid(),
  -- The super_admin who started it.
  actor_id      uuid references public.users(id) on delete set null,
  actor_email   text,
  -- The person impersonated.
  target_id     uuid references public.users(id) on delete set null,
  target_email  text,
  started_at    timestamptz not null default now(),
  -- The hard cap (US-2351 AC1). Enforced by every reader, not by a scheduler:
  -- a job that has not run yet is not a security control.
  expires_at    timestamptz not null,
  ended_at      timestamptz,
  -- 'stopped' (the admin exited) | 'expired' (the cap ran out) |
  -- 'revoked' (an operator killed it).
  end_reason    text,
  created_at    timestamptz not null default now()
);

-- The hot lookup: "is this person being impersonated right now?", asked by every
-- destructive route. Partial, so it only indexes live rows.
create index if not exists idx_impersonation_active_target
  on public.admin_impersonation_sessions (target_id, expires_at)
  where ended_at is null;

-- The operator view: what has this admin been doing.
create index if not exists idx_impersonation_actor
  on public.admin_impersonation_sessions (actor_id, started_at desc);

-- RLS enabled with ZERO policies by design: anon and authenticated get nothing.
-- Only the service-role edge reads or writes it. Classified in rls-guard_test's
-- SERVICE_ROLE_ONLY. Note the target must NOT be able to read this — a support
-- surface that showed a user their own impersonation history would leak
-- operator activity, and one that let them WRITE it would let them end the
-- record while the session continued.
alter table public.admin_impersonation_sessions enable row level security;
revoke all on public.admin_impersonation_sessions from anon, authenticated;

comment on table public.admin_impersonation_sessions is
  'US-2351: one row per impersonation. Carries the hard expiry, the end reason '
  'and the server-visible marker that destructive routes check. Operator '
  'surface — service-role only, deny-all RLS. Rows survive deletion of either '
  'party (SET NULL + denormalized emails), because the record of an '
  'impersonation is not the impersonator''s to erase.';

insert into public.applied_migrations (version) values ('00521') on conflict do nothing;
