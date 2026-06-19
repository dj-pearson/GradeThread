-- 00264_passport_integrity.sql
--
-- US-1103: Garment Passport admin integrity & fraud signals. Keeps the ledger
-- credible by surfacing anomalies an admin can triage + act on:
--   • wear_reversal         — condition that IMPROVED across a 'same item' link
--                             (a later fingerprint is in better shape than an
--                             earlier one — physically impossible without a swap).
--   • duplicate_fingerprint — the SAME visual fingerprint on two ACTIVE garments
--                             held by DIFFERENT owner nodes (one physical item
--                             can't be in two active chains at once).
--   • rapid_reclaim         — a garment's passport reclaimed many times in a short
--                             window (claim-link churn / resale laundering).
--   • token_replay          — repeated redemption attempts against an already-used
--                             or expired claim token (a replay probe).
--
-- This MIRRORS the durable abuse_signals lifecycle (00212) — one row per concern,
-- idempotent via a stable dedupe_key, moved through open→reviewing→
-- actioned/dismissed — but is keyed on garment_id (not a user) because passport
-- participants are PSEUDONYMOUS owner_nodes, not accounts. It REUSES the existing
-- abuse_signal_severity / abuse_signal_status enums rather than re-declaring them.
--
-- Two supporting pieces:
--   • passport_claim_attempts — an append-only log of claim-token redemption
--     attempts (success + rejection) so the token_replay / rapid_reclaim detectors
--     have something to count. Records only a token HASH + outcome + a SALTED
--     source hash — never the raw token, never a raw IP.
--   • garment_events.severed_* — lets an admin SEVER a probable link (AC2): a
--     severed event is dropped from the public passport timeline + chain.
--
-- Security: all three surfaces are OPERATOR-only (service-role write, deny-all to
-- anon/authenticated) — a tenant must not read anomalies raised about a chain.
-- Keyed on garment_id (not user_id/created_by) so the tenant-isolation guard does
-- not misclassify these admin-only tables as user-owned tenant data.
--
-- Idempotent: enum guarded, tables IF NOT EXISTS, columns ADD IF NOT EXISTS,
-- trigger dropped-then-created. Fresh-schema safe (db verify lane).

BEGIN;

-- ── Anomaly type enum ─────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.passport_integrity_type AS ENUM (
    'wear_reversal', 'duplicate_fingerprint', 'rapid_reclaim', 'token_replay'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── passport_claim_attempts (append-only redemption log) ──────────────────────
-- Written by the anonymous /api/passport/claim route (service role). Holds only
-- the attempted token HASH (so we can join to passport_claim_tokens), the garment
-- when resolvable, the outcome, and a SALTED source hash — never the raw token,
-- never a raw IP/email. Cascade-deletes with the garment.
CREATE TABLE IF NOT EXISTS public.passport_claim_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 of the attempted raw token (same hashing as passport_claim_tokens).
  token_hash      text NOT NULL,
  -- The garment, when the token resolved to one (NULL for an unknown token).
  garment_id      uuid REFERENCES public.garments(id) ON DELETE CASCADE,
  -- 'claimed' (first valid redemption) | 'rejected' (invalid/expired/replay).
  outcome         text NOT NULL CHECK (outcome IN ('claimed', 'rejected')),
  -- The buyer node a successful claim minted (NULL on rejection).
  claimed_node_id uuid REFERENCES public.owner_nodes(id) ON DELETE SET NULL,
  -- Salted SHA-256 of the caller IP (PII-minimized; NULL when absent).
  source_hash     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.passport_claim_attempts IS
  'US-1103: append-only log of passport claim-token redemption attempts (success '
  '+ rejection). Token HASH + outcome + salted source hash only — never the raw '
  'token or a raw IP. Feeds the token_replay / rapid_reclaim integrity detectors. '
  'Service-role only.';

-- Replay detection joins attempts to a token by hash; both detectors scan recent.
CREATE INDEX IF NOT EXISTS idx_passport_claim_attempts_token
  ON public.passport_claim_attempts(token_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_passport_claim_attempts_garment
  ON public.passport_claim_attempts(garment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_passport_claim_attempts_created
  ON public.passport_claim_attempts(created_at DESC);

ALTER TABLE public.passport_claim_attempts ENABLE ROW LEVEL SECURITY;
-- Service-role only — no client policies (deny-all to anon/authenticated).
REVOKE INSERT, UPDATE, DELETE ON public.passport_claim_attempts FROM anon, authenticated;

-- ── garment_events: admin "sever a probable link" (AC2) ───────────────────────
-- The ledger stays append-only for tenants; an admin can SEVER a specific link
-- (a probable ownership_transfer/listed event flagged as fraudulent). A severed
-- event is filtered out of the public passport timeline + chain. Service-role
-- write only (the existing REVOKE on garment_events already blocks clients).
ALTER TABLE public.garment_events
  ADD COLUMN IF NOT EXISTS severed_at     timestamptz;
ALTER TABLE public.garment_events
  ADD COLUMN IF NOT EXISTS severed_by     uuid REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.garment_events
  ADD COLUMN IF NOT EXISTS severed_reason text;

-- Public read filters severed events; index the live (un-severed) ledger.
CREATE INDEX IF NOT EXISTS idx_garment_events_live
  ON public.garment_events(garment_id, created_at)
  WHERE severed_at IS NULL;

-- ── passport_integrity_signals (durable, triageable anomalies) ────────────────
CREATE TABLE IF NOT EXISTS public.passport_integrity_signals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_type       public.passport_integrity_type not null,
  severity          public.abuse_signal_severity   not null default 'medium',
  status            public.abuse_signal_status     not null default 'open',
  -- The garment the anomaly is RAISED ABOUT (the primary subject). A
  -- duplicate_fingerprint also names a counterpart garment in evidence.
  garment_id        uuid not null references public.garments(id) on delete cascade,
  -- Stable identity for an in-progress concern → the scan is idempotent: a re-run
  -- UPDATES evidence/last_seen of an existing open/reviewing signal rather than
  -- duplicating, and never reopens one already actioned/dismissed.
  dedupe_key        text not null unique,
  -- The anomaly FACT only — garment/owner-node/event ids + hashes + counts. Never
  -- image bytes, signed URLs, or PII (enforced by assertSafePassportEvidence).
  evidence          jsonb not null default '{}'::jsonb,
  -- Admin annotations (AC2): [{ by, at, text }] appended via /notes. Free-form
  -- operator context, kept separate from the machine evidence.
  notes             jsonb not null default '[]'::jsonb,
  -- Triage trail. resolution_reason is required by the API on action/dismiss.
  resolved_by       uuid references public.users(id) on delete set null,
  resolution_reason text,
  resolved_at       timestamptz,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

COMMENT ON TABLE public.passport_integrity_signals IS
  'US-1103: durable, triageable Garment Passport integrity anomalies (wear '
  'reversal, duplicate fingerprint across owners, rapid re-claim, token replay). '
  'Populated by the passport-integrity-scan cron; managed via '
  '/api/admin/passport-integrity/*. Keyed on garment_id (not user_id) so the '
  'tenant-isolation guard does not treat this admin-only table as user-owned '
  'data. evidence holds only ids + hashes + counts, never image bytes. '
  'Service-role only (deny-all RLS).';

-- The console lists by status, filtered by type/severity, newest first.
CREATE INDEX IF NOT EXISTS idx_passport_integrity_triage
  ON public.passport_integrity_signals (status, signal_type, severity, last_seen_at desc);
CREATE INDEX IF NOT EXISTS idx_passport_integrity_garment
  ON public.passport_integrity_signals (garment_id);

DROP TRIGGER IF EXISTS trg_passport_integrity_updated_at ON public.passport_integrity_signals;
CREATE TRIGGER trg_passport_integrity_updated_at
  BEFORE UPDATE ON public.passport_integrity_signals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.passport_integrity_signals ENABLE ROW LEVEL SECURITY;
-- Service-role only (no client policies). Deny-all to anon/authenticated.
REVOKE INSERT, UPDATE, DELETE ON public.passport_integrity_signals FROM anon, authenticated;

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync no
-- matter how this migration is applied. Version = this file's NNNNN prefix.
INSERT INTO public.applied_migrations (version) VALUES ('00264')
ON CONFLICT (version) DO NOTHING;

COMMIT;
