-- US-904: Legal/ToS version manager with forced re-acceptance.
--
-- US-377 (00142) introduced affirmative clickwrap consent: per-user
-- `users.{tos,privacy}_accepted_{version,at}` columns + an append-only
-- `legal_acceptances` audit log. The "current version" a user must match was a
-- HARDCODED constant in code (TOS_VERSION/PRIVACY_VERSION in legal.ts +
-- LEGAL_VERSIONS in constants.ts), so publishing a new Terms/Privacy version and
-- forcing re-acceptance required a code deploy and left no audit of WHO
-- published WHICH version WHEN.
--
-- This migration makes legal documents DATA: an operator publishes a version row
-- and (optionally) flags it `requires_reacceptance`, which immediately becomes
-- the bar the in-app gate enforces — no deploy. The edge legal routes read the
-- current/required version from this table (falling back to the historical
-- 2026-04-01 baseline when empty), so existing acceptances stay consistent.

-- ── Document kind enum ──────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'legal_doc_kind') THEN
    CREATE TYPE public.legal_doc_kind AS ENUM ('tos', 'privacy');
  END IF;
END$$;

-- ── Published legal-document versions (the source of truth) ─────────────────
CREATE TABLE public.legal_documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  public.legal_doc_kind NOT NULL,
  -- The version key. By convention the document's EFFECTIVE DATE (YYYY-MM-DD),
  -- which makes lexical comparison == chronological comparison for the gate.
  version               text NOT NULL,
  effective_date        date NOT NULL,
  url                   text,            -- link to the hosted document (e.g. /terms)
  body                  text,            -- or inline body, if hosted here
  -- When true, publishing this version raises the "must re-accept" bar to it:
  -- everyone whose recorded acceptance predates it is forced to re-accept. When
  -- false (a typo/clarity fix) the version becomes current for new acceptances
  -- but prior acceptors are NOT disturbed.
  requires_reacceptance boolean NOT NULL DEFAULT true,
  published_at          timestamptz NOT NULL DEFAULT now(),
  -- The operator who published it (admin user). SET NULL on account erasure so
  -- the historical document row survives.
  published_by          uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- One row per (kind, version) — re-publishing the same version is a conflict.
CREATE UNIQUE INDEX uq_legal_documents_kind_version
  ON public.legal_documents(kind, version);
-- The gate's hot read: latest published document per kind.
CREATE INDEX idx_legal_documents_kind_effective
  ON public.legal_documents(kind, effective_date DESC, published_at DESC);

COMMENT ON TABLE public.legal_documents IS
  'US-904: published Terms/Privacy versions. Source of truth for the in-app '
  'legal acceptance gate (current + required-since version per kind). Writes are '
  'service-role only via the admin compliance endpoints; reads are public.';

ALTER TABLE public.legal_documents ENABLE ROW LEVEL SECURITY;

-- Published legal documents are inherently public reference data; any
-- authenticated user may read them (the in-app gate shows the current version).
-- There are deliberately NO write policies — versions are published only by the
-- service-role edge client behind the super_admin + MFA-step-up admin endpoint.
CREATE POLICY "Authenticated can read legal documents"
  ON public.legal_documents FOR SELECT
  TO authenticated
  USING (true);

-- ── Seed the historical baseline (keep in sync with src/lib/constants.ts) ───
-- 2026-04-01 is the version every existing user accepted (or is being gated to
-- accept) today. Seeding it with requires_reacceptance = true reproduces the
-- exact pre-US-904 behaviour: a user whose recorded acceptance is NULL/older is
-- gated; a user on 2026-04-01 is current.
INSERT INTO public.legal_documents (kind, version, effective_date, requires_reacceptance, url)
VALUES
  ('tos',     '2026-04-01', '2026-04-01', true, '/terms'),
  ('privacy', '2026-04-01', '2026-04-01', true, '/privacy')
ON CONFLICT (kind, version) DO NOTHING;
