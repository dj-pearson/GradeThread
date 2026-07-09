-- US-1760: badge click attribution ledger.
--
-- Records a click on a GradeThread badge (a per-item certificate badge or a
-- verified-seller storefront badge) that a seller embedded off-platform, tagged
-- with the ?s= source. Powers the seller-visible + admin badge funnel (clicks by
-- source, joined to referral conversions). Deny-all / service-role only: writes
-- come from the public recording endpoint (owner resolved server-side) and reads
-- from the owner-scoped funnel endpoints — the SPA never queries this directly.
-- No buyer PII is stored (no IP, no identity) — only the seller who owns the
-- badge, what was clicked, and the source channel.

CREATE TABLE IF NOT EXISTS public.badge_click_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The seller whose badge was clicked (operator-table naming convention).
  owner_user_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- What was clicked: 'cert' (a certificate badge) or 'seller' (a storefront badge).
  target_type    text NOT NULL,
  -- The certificate_id or the verified handle the badge pointed at.
  target_id      text NOT NULL,
  -- The ?s= attribution source, e.g. 'embed' / 'badge' / 'qr' / 'share'.
  source         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.badge_click_events
  DROP CONSTRAINT IF EXISTS badge_click_events_target_type_check;
ALTER TABLE public.badge_click_events
  ADD CONSTRAINT badge_click_events_target_type_check
  CHECK (target_type IN ('cert', 'seller'));

-- Deny-all: RLS on, ZERO policies — anon/authenticated get nothing; the
-- service-role client bypasses RLS. Same posture as the other operator tables.
ALTER TABLE public.badge_click_events ENABLE ROW LEVEL SECURITY;

-- The owner-scoped funnel reads by owner over a recent window.
CREATE INDEX IF NOT EXISTS idx_badge_click_events_owner
  ON public.badge_click_events (owner_user_id, created_at DESC);

COMMENT ON TABLE public.badge_click_events IS
  'US-1760: per-badge click attribution (deny-all, service-role only). No buyer PII.';

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00404')
ON CONFLICT (version) DO NOTHING;
