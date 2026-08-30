-- US-2997: the QuickBooks Online connection and its account mapping.
--
-- WHY THIS IS NOT marketplace_connections. That table's `marketplace` column is
-- the `listing_platform` enum, and QuickBooks is not a place you list a garment.
-- Adding a value to that enum would put "quickbooks" into every dropdown, every
-- platform breakdown and every "which marketplaces am I on" count in the app,
-- for a row that can never hold a listing. The OAuth SHAPE is copied exactly --
-- AES-GCM tokens with the user id as AAD, a single-use state row, lazy refresh
-- with a permanent-failure branch -- and only the table is separate.
--
-- THE REALM IS THE POINT. A QBO connection is to ONE company file, identified
-- by its realm id, and a seller with a personal file and a business file must
-- never have transactions land in the wrong one. Every API call is scoped by
-- the realm stored here; the realm is never taken from a request body.
--
-- SANDBOX AND PRODUCTION ARE DIFFERENT COMPANIES, and pushing test data into a
-- real file cannot be undone. The environment is part of the row and part of
-- the unique key, so the two can coexist and neither can be mistaken for the
-- other.
--
-- The contract is in vault/50-business/books-and-taxes.md.

CREATE TABLE IF NOT EXISTS public.qbo_connections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- Intuit's id for the company file. Text, not uuid: it is a decimal string.
  realm_id      text NOT NULL,
  environment   text NOT NULL DEFAULT 'production'
                CHECK (environment IN ('sandbox', 'production')),

  -- Shown so a seller can tell two company files apart. Best effort: the
  -- CompanyInfo call can fail without the connection being broken.
  company_name  text,

  -- AES-GCM, encrypted by services/edge-functions/src/lib/crypto-aes.ts with
  -- the owning user id as additional authenticated data, so a blob lifted from
  -- one row cannot be decrypted against another tenant's.
  access_token_encrypted  text,
  refresh_token_encrypted text,

  -- QBO access tokens last an hour. The REFRESH token is the one that matters:
  -- it rotates on every use and dies after 100 days of disuse, which is the
  -- failure this schema exists to make visible rather than silent.
  token_expires_at         timestamptz,
  refresh_token_expires_at timestamptz,

  is_active     boolean NOT NULL DEFAULT true,
  last_synced_at           timestamptz,
  last_refresh_attempt_at  timestamptz,

  -- AC6. Non-null means the seller must act. The refresh sweep writes the
  -- reconnect wording here and clears is_active only when the failure is
  -- permanent, so a transient Intuit outage does not look like a disconnect.
  refresh_error text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS qbo_connections_user_realm_env_idx
  ON public.qbo_connections (user_id, realm_id, environment);
CREATE INDEX IF NOT EXISTS qbo_connections_user_idx
  ON public.qbo_connections (user_id);
-- The refresh sweep's exact query: active rows whose token is about to lapse.
CREATE INDEX IF NOT EXISTS qbo_connections_expiry_idx
  ON public.qbo_connections (token_expires_at) WHERE is_active;

comment on column public.qbo_connections.realm_id is
  'US-2997 AC2. The QuickBooks company file. Every API call is scoped by it, and it is never read from a request body -- a seller with two company files must not have a sale land in the wrong one.';
comment on column public.qbo_connections.refresh_token_expires_at is
  'US-2997 AC6. The refresh token rotates on use and expires after 100 days of disuse. A silent stop here is how a seller discovers in March that nothing has synced since November.';

ALTER TABLE public.qbo_connections ENABLE ROW LEVEL SECURITY;

-- Per-user policies, in the (select auth.uid()) initplan form (US-1927): the
-- SPA reads its own connection directly through PostgREST for the status card,
-- exactly as use-ebay.ts reads marketplace_connections. The token columns are
-- ciphertext and the key never leaves the edge.
DROP POLICY IF EXISTS "qbo_connections_select_own" ON public.qbo_connections;
CREATE POLICY "qbo_connections_select_own" ON public.qbo_connections
  FOR SELECT USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "qbo_connections_insert_own" ON public.qbo_connections;
CREATE POLICY "qbo_connections_insert_own" ON public.qbo_connections
  FOR INSERT WITH CHECK ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "qbo_connections_update_own" ON public.qbo_connections;
CREATE POLICY "qbo_connections_update_own" ON public.qbo_connections
  FOR UPDATE USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "qbo_connections_delete_own" ON public.qbo_connections;
CREATE POLICY "qbo_connections_delete_own" ON public.qbo_connections
  FOR DELETE USING ((select auth.uid()) = user_id);

DROP TRIGGER IF EXISTS set_qbo_connections_updated_at ON public.qbo_connections;
CREATE TRIGGER set_qbo_connections_updated_at
  BEFORE UPDATE ON public.qbo_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ---------------------------------------------------------------------------
-- The mapping. AC3.
--
-- One row per GradeThread account the seller has mapped. ABSENCE IS MEANINGFUL:
-- no row means unmapped, which blocks that account's push and nothing else
-- (AC4). Storing the whole mapping as one jsonb blob would make "which accounts
-- are unmapped" a parse rather than a query, and would lose the per-account
-- audit of when a mapping changed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.qbo_account_mappings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.qbo_connections(id) ON DELETE CASCADE,

  -- public.ledger_accounts.code. Deliberately NOT a foreign key: a seller's
  -- mapping must survive a chart-of-accounts edit, and a cascade delete here
  -- would silently unmap an account rather than telling anyone.
  account_code  text NOT NULL,

  qbo_account_id   text NOT NULL,
  qbo_account_name text,

  -- How the id was arrived at, so the screen can show which rows were guessed:
  -- 'subtype' is precise, 'name' and 'type' are guesses, 'manual' is the
  -- seller's own choice and is never overwritten by a re-proposal.
  basis         text NOT NULL DEFAULT 'manual'
                CHECK (basis IN ('subtype', 'type', 'name', 'manual')),

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS qbo_account_mappings_conn_code_idx
  ON public.qbo_account_mappings (connection_id, account_code);
CREATE INDEX IF NOT EXISTS qbo_account_mappings_user_idx
  ON public.qbo_account_mappings (user_id);

comment on table public.qbo_account_mappings is
  'US-2997 AC3/AC4. One row per mapped account; absence means unmapped, which blocks that account only. Validated against the live QBO chart before a sync, because an id can go stale between the mapping screen and the push.';

ALTER TABLE public.qbo_account_mappings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "qbo_account_mappings_select_own" ON public.qbo_account_mappings;
CREATE POLICY "qbo_account_mappings_select_own" ON public.qbo_account_mappings
  FOR SELECT USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "qbo_account_mappings_insert_own" ON public.qbo_account_mappings;
CREATE POLICY "qbo_account_mappings_insert_own" ON public.qbo_account_mappings
  FOR INSERT WITH CHECK ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "qbo_account_mappings_update_own" ON public.qbo_account_mappings;
CREATE POLICY "qbo_account_mappings_update_own" ON public.qbo_account_mappings
  FOR UPDATE USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS "qbo_account_mappings_delete_own" ON public.qbo_account_mappings;
CREATE POLICY "qbo_account_mappings_delete_own" ON public.qbo_account_mappings
  FOR DELETE USING ((select auth.uid()) = user_id);

DROP TRIGGER IF EXISTS set_qbo_account_mappings_updated_at ON public.qbo_account_mappings;
CREATE TRIGGER set_qbo_account_mappings_updated_at
  BEFORE UPDATE ON public.qbo_account_mappings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ---------------------------------------------------------------------------
-- The OAuth state. Deny-all, service-role only, like public.oauth_states.
--
-- A state row is the CSRF defence for the whole flow: the callback arrives with
-- no session, and the only thing proving the browser is the one that started is
-- this single-use token. It is deleted-and-returned in one statement, so a
-- replay finds nothing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.qbo_oauth_states (
  state         text PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  environment   text NOT NULL DEFAULT 'production'
                CHECK (environment IN ('sandbox', 'production')),
  redirect_to   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '15 minutes')
);

CREATE INDEX IF NOT EXISTS qbo_oauth_states_expiry_idx
  ON public.qbo_oauth_states (expires_at);

comment on table public.qbo_oauth_states is
  'US-2997. RLS enabled, zero policies by design: read and written only by the service-role edge client. Single-use and self-expiring; the SPA never reads it. Registered in SERVICE_ROLE_ONLY in rls-guard_test.ts.';

ALTER TABLE public.qbo_oauth_states ENABLE ROW LEVEL SECURITY;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00704') on conflict do nothing;
