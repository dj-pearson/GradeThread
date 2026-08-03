-- US-2349 [P0]: the audit log stops being writable — and readable — from a browser.
--
-- See vault/20-domain/audit-log-access-control.md for the contract this completes.
--
-- THE FORGERY. 00003 defined the INSERT policy as `WITH CHECK (is_admin())`,
-- with no constraint tying `admin_user_id` to `auth.uid()`. Any admin could
-- insert rows with an arbitrary actor, action, target and details straight from
-- devtools: grant yourself comp credits, then write a dozen `admin.change_role`
-- rows stamped with the super_admin's user id. Non-repudiation was gone for the
-- whole table, and the 00227 anomaly detectors would have fired on the forged
-- actor — pointing the investigation at the wrong person.
--
-- THE READ HOLE, which US-2352 did not close and this finishes. 00517 moved the
-- search RPC behind super_admin and gave it a self-audit. The TABLE's own SELECT
-- policy was still `is_admin()`, so `supabase.from("admin_audit_log").select()`
-- from the browser returned everything, to any admin, with no record. Hardening
-- the front door while the wall stayed open is worse than leaving both — it
-- reads as fixed.
--
-- THE FIX: no browser policy at all. Both policies are dropped and nothing
-- replaces them, so `anon` and `authenticated` get nothing.
--
-- WHY NOT `WITH CHECK (admin_user_id = auth.uid())`, which AC1 offers as the
-- first option. It stops an admin FRAMING someone else, and stops nothing else:
-- they could still write any action, any target and any details under their own
-- name, so the log would record fictions that are merely correctly attributed.
-- An audit log that its own subjects can append to is not evidence.
--
-- NOTHING LEGITIMATE LOSES ACCESS. Every writer already bypasses RLS:
--   • lib/audit-log.ts writes through the service-role client;
--   • the 00065 dispute trigger is SECURITY DEFINER;
--   • the 00518 audit-search self-audit is SECURITY DEFINER;
--   • 00519's stamping trigger is SECURITY DEFINER.
-- And every reader goes through admin_audit_log_search /
-- admin_audit_log_filter_options, both SECURITY DEFINER and both already
-- super_admin-gated. Checked: no browser code selects this table directly.
--
-- The one client-side writer left (ai-models.tsx) is removed in the same commit.
-- It logged that an admin had VIEWED a weekly accuracy summary, with numbers the
-- browser itself computed — so it was a self-report of a read, unverifiable by
-- construction. It also passed target_id: "weekly" into a `uuid` column, so it
-- had been failing on every call; the error was discarded until US-2357 made
-- that write report itself.

-- Read: the RPCs only. They are SECURITY DEFINER, so narrowing the table
-- changes nothing for them.
drop policy if exists "Admins can view audit log" on public.admin_audit_log;

-- Write: service-role and SECURITY DEFINER only.
drop policy if exists "Admins can create audit log entries" on public.admin_audit_log;

-- Belt and braces. A future migration that adds a policy is a decision someone
-- makes on purpose; a lingering table-level grant is not, and PostgREST needs
-- the grant as well as the policy.
revoke all on public.admin_audit_log from anon, authenticated;

-- RLS was already enabled by 00003; asserted here so a table with no policies
-- can never be a table with no RLS.
alter table public.admin_audit_log enable row level security;

comment on table public.admin_audit_log is
  'Admin action audit trail. US-2349: RLS-enabled with ZERO policies by design — '
  'anon and authenticated get nothing. Writes come from the service-role edge '
  'client and SECURITY DEFINER triggers; reads go through '
  'admin_audit_log_search (super_admin, self-auditing). Rows survive deletion '
  'of their actor (US-2350). Append-only in practice because nothing can '
  'UPDATE or DELETE it either.';

insert into public.applied_migrations (version) values ('00520') on conflict do nothing;
