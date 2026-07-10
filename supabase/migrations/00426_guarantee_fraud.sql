-- US-1823: anti-fraud & abuse controls for buyer guarantee coverage claims.
--
-- Fraud signals gate the US-1821 auto-payout: a suspicious claim (velocity /
-- repeat-rejection pattern / low trust / thin evidence / a tamper-flagged grade)
-- is downgraded to manual review instead of auto-remedy, and the signals are
-- retained on the claim for dispute defense. An admin who upholds fraud
-- penalizes the buyer's reputation (US-1816) and can REVOKE their coverage.

-- ── fraud signals + resolution audit on the claim ───────────────────────────
ALTER TABLE public.buyer_guarantee_claims
  -- The fraud reasons that fired (['velocity','low_trust',…]); [] when clean.
  ADD COLUMN IF NOT EXISTS fraud_flags     jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS fraud_score     numeric NOT NULL DEFAULT 0,
  -- Admin resolution audit (who closed a manual-review claim, and how).
  ADD COLUMN IF NOT EXISTS resolved_by     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolved_at     timestamptz,
  ADD COLUMN IF NOT EXISTS resolution_note text;

-- ── coverage revoke (fraud remedy) ──────────────────────────────────────────
-- When set, the buyer's purchase guarantee is revoked: snapshotCoverageForPurchase
-- resolves ineligible ('coverage_revoked') so no new purchase can be covered.
-- Edge-written (service role), so the users self-update guard is untouched.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS buyer_coverage_revoked_at timestamptz;

COMMENT ON COLUMN public.users.buyer_coverage_revoked_at IS
  'US-1823: when set, the buyer''s insured purchase guarantee is revoked (upheld fraud). New coverage snapshots resolve ineligible.';

-- ── admin-tunable fraud thresholds ──────────────────────────────────────────
INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES (
  'buyer.guarantee_fraud',
  jsonb_build_object(
    'max_claims_per_period', 3,
    'max_recent_rejected', 2,
    'min_trust_level_for_auto', 1,
    'suspicious_score_threshold', 3,
    'require_full_arrival_evidence', true
  ),
  'json',
  jsonb_build_object(
    'max_claims_per_period', 3,
    'max_recent_rejected', 2,
    'min_trust_level_for_auto', 1,
    'suspicious_score_threshold', 3,
    'require_full_arrival_evidence', true
  ),
  'buyer',
  'Buyer guarantee anti-fraud thresholds (US-1823), read at claim time. '
  'max_claims_per_period = claims this period above which velocity fires; '
  'max_recent_rejected = prior rejected claims above which the pattern fires; '
  'min_trust_level_for_auto = Trust Score level below which auto-payout is '
  'withheld; suspicious_score_threshold = summed signal weight that routes a claim '
  'to manual review; require_full_arrival_evidence = a thin arrival photo set is a '
  'signal. Negative/invalid values are clamped.'
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record so the edge schema-version guard stays truthful.
INSERT INTO public.applied_migrations (version) VALUES ('00426')
ON CONFLICT (version) DO NOTHING;
