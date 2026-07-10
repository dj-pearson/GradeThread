-- US-1830: 'Graded Wanted' reverse demand board — want/request model + matches.
--
-- A want is a buyer's ACTIVE broadcast ("I want a Nike hoodie, grade ≥ 8, under
-- $60") — the complement of a passive saved-search alert (US-1806). It reuses the
-- SAME matching engine (condition-alerts.matchesSearch, against the public-cert
-- universe) rather than a second engine. Wants can be public (aggregated PII-safe
-- to sellers as a sourcing signal, US-1831) or private (match-only). Matches are
-- recorded here so both the buyer and the graded item's SELLER can be surfaced.
--
-- OWNER-READ / SERVICE-WRITE (like buyer_purchases 00418): the buyer reads their
-- own wants + matches; the edge writes (and runs matching) so criteria are
-- validated server-side and the cross-tenant match query stays service-role.

-- ── buyer_wants ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.buyer_wants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Criteria — same shape the alerts engine matches on (empty array = wildcard).
  brands          text[] NOT NULL DEFAULT '{}',
  categories      text[] NOT NULL DEFAULT '{}',
  keywords        text[] NOT NULL DEFAULT '{}',
  min_grade       numeric(3,1) CHECK (min_grade IS NULL OR (min_grade >= 1.0 AND min_grade <= 10.0)),
  max_price_cents integer CHECK (max_price_cents IS NULL OR max_price_cents >= 0),
  -- Display context (not matched — public certs don't carry a declared size).
  size            text,
  budget_cents    integer CHECK (budget_cents IS NULL OR budget_cents >= 0),
  visibility      text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'fulfilled')),
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_buyer_wants_user ON public.buyer_wants (user_id, created_at DESC);
-- Seller aggregate surface (US-1831) scans active PUBLIC wants.
CREATE INDEX IF NOT EXISTS idx_buyer_wants_public_active
  ON public.buyer_wants (status) WHERE visibility = 'public';

DROP TRIGGER IF EXISTS set_buyer_wants_updated_at ON public.buyer_wants;
CREATE TRIGGER set_buyer_wants_updated_at
  BEFORE UPDATE ON public.buyer_wants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.buyer_wants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own wants" ON public.buyer_wants;
CREATE POLICY "Users read own wants"
  ON public.buyer_wants FOR SELECT USING (auth.uid() = user_id);

-- ── want_matches ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.want_matches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  want_id         uuid NOT NULL REFERENCES public.buyer_wants(id) ON DELETE CASCADE,
  buyer_user_id   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- The SELLER who graded the matched item (the fulfillment target).
  seller_user_id  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  certificate_id  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- One match per (want, cert) — a re-run never duplicates.
  UNIQUE (want_id, certificate_id)
);

CREATE INDEX IF NOT EXISTS idx_want_matches_buyer ON public.want_matches (buyer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_want_matches_seller ON public.want_matches (seller_user_id);

ALTER TABLE public.want_matches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Buyers read own want matches" ON public.want_matches;
CREATE POLICY "Buyers read own want matches"
  ON public.want_matches FOR SELECT USING (auth.uid() = buyer_user_id);

-- US-1108: self-record so the edge schema-version guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00431')
ON CONFLICT (version) DO NOTHING;
