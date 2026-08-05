-- US-2398 AC4: a comped subscription status, so an admin plan grant entitles.
--
-- POST /api/admin/users/:id/plan wrote the frozen users.plan column, which
-- nothing reads for entitlement, so the grant did nothing. Rewiring it to
-- flipdesk_plan alone is not enough: effectivePlanFor (lib/grade-pricing.ts)
-- demotes a paid plan to Free whenever subscription_status is 'none' or
-- 'canceled', which is exactly what a cardless account carries. The plan would
-- be written and the caps would still be Free.
--
-- 'comp' is the missing lifecycle state: on a paid tier, deliberately not
-- billed. It entitles (it is not one of the non-entitling statuses) while the
-- revenue RPC keeps counting only 'active' and 'past_due', so a comp grants
-- caps without inventing MRR that nobody paid.
--
-- NOTE ON THE ENUM VALUE: 'comp' is added here and is NOT used by any statement
-- in this file. A new enum value cannot be USED in the same transaction that
-- adds it (Postgres), and the edge only writes it after the boot guard confirms
-- this version.

ALTER TYPE public.subscription_status ADD VALUE IF NOT EXISTS 'comp';

COMMENT ON COLUMN public.users.subscription_status IS
  'Subscription lifecycle. Free users without Stripe = ''none''. '
  'Paused subscribers retain credits + data but caps drop to Free in plan-gate (US-208). '
  '''comp'' (US-2398) = an admin grant with no billing behind it: it entitles like a '
  'paid status but is excluded from MRR, which counts only ''active'' and ''past_due''. '
  'Only POST /api/admin/users/:id/plan writes it, and that route refuses to touch an '
  'account with a live Stripe or app-store subscription.';

insert into public.applied_migrations (version) values ('00529') on conflict do nothing;
