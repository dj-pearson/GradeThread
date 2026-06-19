-- 00256_garment_passport_core.sql
--
-- US-1089: Garment Passport core data model — the foundation of the
-- CARFAX-for-clothing "Garment Passport". A single physical garment gets a
-- persistent identity (`garments`) plus an APPEND-ONLY event ledger
-- (`garment_events`) so condition + ownership history accumulates across many
-- grades and sales. Participants are PSEUDONYMOUS nodes (`owner_nodes`) — no
-- PII; real-identity linkage is deferred to the opt-in story (US-1105).
--
-- Security model (US-268): the edge writes everything via the service-role
-- client (bypasses RLS). Direct PostgREST access is locked down:
--   • garments       — owner reads own (created_by = auth.uid()); no client writes.
--   • garment_events — owner reads via the parent garment; APPEND-ONLY (no
--                      update/delete policy at all — corrections are new events).
--   • owner_nodes    — pseudonymous; service-role only (deny-all to anon/auth) so
--                      no tenant can enumerate another's nodes. The public
--                      passport is served by the edge (US-1092/1093) from a
--                      PII-free projection, never direct anon PostgREST.
--
-- Idempotent: enum creation is guarded, tables use IF NOT EXISTS, the trigger is
-- dropped-then-created. Applies cleanly on a fresh schema (db verify lane).

BEGIN;

-- ── Enums (fixed sets, per repo convention) ──────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.garment_status AS ENUM ('active', 'merged', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.owner_node_kind AS ENUM ('seller', 'buyer', 'system');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.garment_event_type AS ENUM (
    'graded', 'listed', 'sold', 'ownership_transfer', 'fingerprinted'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.garment_event_confidence AS ENUM (
    'deterministic', 'probable', 'unknown'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── owner_nodes (pseudonymous participants) ──────────────────────────────────
-- Created first: garments + garment_events reference it. No PII columns;
-- linked_user_id stays NULL until the deferred opt-in identity story (US-1105).
CREATE TABLE IF NOT EXISTS public.owner_nodes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pseudonymous_label text NOT NULL,
  kind            public.owner_node_kind NOT NULL,
  linked_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.owner_nodes IS
  'US-1089: pseudonymous Garment Passport participants (no PII). linked_user_id '
  'is null until the opt-in identity story (US-1105). Service-role only.';

-- ── garments (the persistent passport identity) ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.garments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Public, URL-safe handle for the passport page (32 hex chars). Unique.
  public_passport_slug  text NOT NULL UNIQUE
                          DEFAULT replace(gen_random_uuid()::text, '-', ''),
  -- Brand / model / size / colorway descriptor (not a tenant key).
  sku_class             jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_owner_node_id uuid REFERENCES public.owner_nodes(id) ON DELETE SET NULL,
  status                public.garment_status NOT NULL DEFAULT 'active',
  -- The tenant key: who created this passport (RLS scopes reads to them).
  created_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.garments IS
  'US-1089: persistent Garment Passport identity. created_by is the tenant key; '
  'current_owner_node_id points at the pseudonymous current holder.';

-- ── garment_events (APPEND-ONLY ledger) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.garment_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  garment_id    uuid NOT NULL REFERENCES public.garments(id) ON DELETE CASCADE,
  event_type    public.garment_event_type NOT NULL,
  actor_node_id uuid REFERENCES public.owner_nodes(id) ON DELETE SET NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence    public.garment_event_confidence NOT NULL DEFAULT 'unknown',
  source        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.garment_events IS
  'US-1089: append-only Garment Passport event ledger (graded/listed/sold/'
  'ownership_transfer/fingerprinted). No update/delete — corrections are new rows.';

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_garments_created_by
  ON public.garments(created_by);
CREATE INDEX IF NOT EXISTS idx_garments_current_owner_node
  ON public.garments(current_owner_node_id);
CREATE INDEX IF NOT EXISTS idx_owner_nodes_linked_user
  ON public.owner_nodes(linked_user_id) WHERE linked_user_id IS NOT NULL;
-- Timeline read: a garment's events oldest→newest.
CREATE INDEX IF NOT EXISTS idx_garment_events_garment_created
  ON public.garment_events(garment_id, created_at);

-- ── updated_at trigger (shared convention, public.set_updated_at) ─────────────
DROP TRIGGER IF EXISTS trg_garments_updated_at ON public.garments;
CREATE TRIGGER trg_garments_updated_at
  BEFORE UPDATE ON public.garments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.owner_nodes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.garments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.garment_events ENABLE ROW LEVEL SECURITY;

-- owner_nodes: service-role only (deny-all to anon/authenticated, zero policies)
-- so pseudonymity holds — no tenant can enumerate another's nodes. The edge
-- service-role client reads/writes them; the public passport is edge-served.
REVOKE ALL ON public.owner_nodes FROM anon, authenticated;

-- garments: owner reads own; all writes are service-role only (no write policy).
REVOKE INSERT, UPDATE, DELETE ON public.garments FROM anon, authenticated;
CREATE POLICY garments_select_own ON public.garments
  FOR SELECT
  USING (created_by = auth.uid());

-- garment_events: owner reads via the parent garment. APPEND-ONLY — there is
-- deliberately NO insert/update/delete policy, so non-service-role clients can
-- never write or mutate the ledger (the edge appends via the service role).
REVOKE INSERT, UPDATE, DELETE ON public.garment_events FROM anon, authenticated;
CREATE POLICY garment_events_select_via_garment ON public.garment_events
  FOR SELECT
  USING (
    garment_id IN (
      SELECT id FROM public.garments WHERE created_by = auth.uid()
    )
  );

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync no
-- matter how this migration is applied. Version = this file's NNNNN prefix.
INSERT INTO public.applied_migrations (version) VALUES ('00256')
ON CONFLICT (version) DO NOTHING;

COMMIT;
