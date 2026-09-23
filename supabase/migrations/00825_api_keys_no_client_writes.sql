-- api_keys: take away the client UPDATE and INSERT policies.
--
-- "Users can update own API keys" (00005, re-added by 00322) lets a signed-in
-- user PATCH their own api_keys row through PostgREST with no column limit.
-- That row carries rate_tier and monthly_quota (00409), and api-key-auth.ts
-- trusts both: rate_tier 'enterprise' buys the top per-minute tier, and a NULL
-- monthly_quota means unlimited. So any key owner could raise their own tier
-- and clear their own cap. The policy was added for PATCH /api/v1/webhook,
-- which has written through the service-role client for a long time.
--
-- The two INSERT policies (00001 owner, 00042 workspace admin) let a client
-- insert a row with any rate_tier, monthly_quota, scopes and expiry. Only
-- harmless today because API_KEY_PEPPER stops a client computing a usable
-- key_hash, and that is not a thing to lean on.
--
-- Who writes api_keys, checked 2026-09-23: routes/api-keys.ts (create, rotate,
-- revoke, branding), api-v1.ts (webhook) and admin-compliance.ts, all with the
-- service-role client, which bypasses RLS. src/, ios/ and android/ never write
-- the table; the web app only reads it (account export, activation count).
-- So both write policies go and nothing replaces them. SELECT and DELETE stay.
--
-- No REVOKE: dropping the policy is enough under RLS, and a table REVOKE would
-- be grant state this repo cannot verify locally (US-3350).
--
-- Idempotent: DROP POLICY IF EXISTS only.

DROP POLICY IF EXISTS "Users can update own API keys" ON public.api_keys;
DROP POLICY IF EXISTS "Users can create API keys" ON public.api_keys;
DROP POLICY IF EXISTS "Workspace admins can create api keys" ON public.api_keys;

insert into public.applied_migrations (version) values ('00825') on conflict do nothing;
