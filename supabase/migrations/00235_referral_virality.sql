-- US-1071: Referral virality analytics + stronger viral mechanics.
--
-- Builds on the existing referral program (00102) + affiliate earned-link
-- channel (00174). Adds three things the "go viral for cheap users" goal needs:
--
--   1. MILESTONE / TIERED rewards — a referrer earns a one-time bonus credit
--      grant when they cross a referral threshold (e.g. 5 / 10 / 25 granted
--      referrals). Tier sizes live in the edge leaf module referral-rewards.ts;
--      this table is the idempotent grant ledger (UNIQUE (user_id, threshold)
--      ⇒ a bonus is granted exactly once even under concurrent grants).
--
--   2. NAMED CAMPAIGN CODES — admin-created promo codes (not tied to a single
--      referrer) that a new user redeems for bonus grade credits. Bounded by an
--      active window + an optional max_redemptions cap, one redemption per user.
--      The operator sets the bonus size, so they own the acquisition-cost ⇄
--      abuse tradeoff (these grant immediately on redeem, unlike referral
--      rewards which wait for a paid action).
--
--   3. referral_analytics() — a SECURITY DEFINER rollup powering the admin
--      virality dashboard: a daily funnel time series (clicks → signups →
--      qualified → granted), conversion %, a K-factor proxy, and referred- vs
--      direct-cohort activation / paying / LTV.
--
-- Additive only — no existing table is altered.

BEGIN;

-- ══════════════════════════════════════════════════════════
-- TABLES
-- ══════════════════════════════════════════════════════════

-- Idempotent ledger of milestone bonuses already paid to a referrer. The UNIQUE
-- key makes awardReferralMilestones() safe to call after every grant: a second
-- call for an already-credited threshold is a no-op insert conflict.
CREATE TABLE public.referral_milestone_grants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  threshold    integer NOT NULL,        -- granted-referral count that unlocked it
  bonus_credits integer NOT NULL,
  granted_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, threshold)
);

-- Admin-created named promo / campaign code. No referrer — it attributes to the
-- campaign, not a user. Redeeming it grants bonus_referred_credits to the new
-- user (subject to the active window + max_redemptions cap).
CREATE TABLE public.referral_campaign_codes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                   text NOT NULL UNIQUE,
  name                   text NOT NULL,
  description            text,
  bonus_referred_credits integer NOT NULL DEFAULT 0 CHECK (bonus_referred_credits >= 0),
  is_active              boolean NOT NULL DEFAULT true,
  starts_at              timestamptz NOT NULL DEFAULT now(),
  ends_at                timestamptz,
  max_redemptions        integer CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  redemption_count       integer NOT NULL DEFAULT 0,
  created_by             uuid REFERENCES public.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- One redemption per (campaign code, user). The UNIQUE key enforces one-per-user
-- at the data layer.
CREATE TABLE public.referral_campaign_redemptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_code_id uuid NOT NULL REFERENCES public.referral_campaign_codes(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  credits_granted  integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_code_id, user_id)
);

-- ══════════════════════════════════════════════════════════
-- INDEXES
-- ══════════════════════════════════════════════════════════

CREATE INDEX idx_referral_milestone_grants_user
  ON public.referral_milestone_grants(user_id);
CREATE INDEX idx_referral_campaign_codes_active
  ON public.referral_campaign_codes(is_active, starts_at, ends_at)
  WHERE is_active;
CREATE INDEX idx_referral_campaign_redemptions_user
  ON public.referral_campaign_redemptions(user_id);
CREATE INDEX idx_referral_campaign_redemptions_code
  ON public.referral_campaign_redemptions(campaign_code_id);

-- ══════════════════════════════════════════════════════════
-- UPDATED_AT TRIGGER
-- ══════════════════════════════════════════════════════════

CREATE TRIGGER set_referral_campaign_codes_updated_at
  BEFORE UPDATE ON public.referral_campaign_codes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ══════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.referral_milestone_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_campaign_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_campaign_redemptions ENABLE ROW LEVEL SECURITY;

-- Milestone grants: a user reads their own; admins read all. Writes are
-- service-role only (the edge grant path).
CREATE POLICY "Users read own milestone grants" ON public.referral_milestone_grants
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Admins read milestone grants" ON public.referral_milestone_grants
  FOR SELECT USING (public.is_admin());

-- Campaign codes: admins manage; any authenticated user may read the ones that
-- are live + in-window (so the redeem UI can validate before posting). The edge
-- service writes via the service-role key (bypasses RLS).
CREATE POLICY "Admins manage campaign codes" ON public.referral_campaign_codes
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Users read active campaign codes" ON public.referral_campaign_codes
  FOR SELECT USING (
    is_active
    AND starts_at <= now()
    AND (ends_at IS NULL OR ends_at > now())
  );

-- Redemptions: a user reads their own; admins read all. Writes service-role only.
CREATE POLICY "Users read own campaign redemptions" ON public.referral_campaign_redemptions
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Admins read campaign redemptions" ON public.referral_campaign_redemptions
  FOR SELECT USING (public.is_admin());

-- ══════════════════════════════════════════════════════════
-- ANALYTICS RPC
-- ══════════════════════════════════════════════════════════

-- Virality rollup for the admin referral dashboard (US-1071). One jsonb document:
--   * series         — per-day funnel: clicks, signups, qualified, granted
--   * totals         — same four, summed over the window
--   * conversion     — click→signup, signup→qualified, qualified→granted (0-100 %)
--   * k_factor       — all-time successful referrals per referring user (a viral
--                      K-factor proxy; > 1 means the loop is self-sustaining)
--   * referrers      — distinct referring users (all-time)
--   * cohorts        — referred vs direct: users, activation (≥1 submission),
--                      paying (≥1 pack purchase), revenue + LTV (avg per user)
--
-- LTV is a directional proxy: GROSS credit-pack revenue priced from
-- pricing_config (00209), same tolerance as revenue_dashboard (00215) — it
-- ignores subscriptions, refunds, and the exact Stripe charge.
--
-- SECURITY DEFINER (reads cross-tenant): an authenticated end-user must be an
-- admin; the service-role edge caller (auth.uid() null) passes; anon can't reach
-- it (execute not granted).
CREATE OR REPLACE FUNCTION public.referral_analytics(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result   jsonb;
  v_days   integer;
  v_start  timestamptz;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'referral_analytics: admin role required' USING errcode = '42501';
  END IF;

  v_days := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_start := date_trunc('day', now()) - ((v_days - 1) || ' days')::interval;

  SELECT jsonb_build_object(
    'window_days', v_days,

    -- ── Daily funnel time series (continuous: every day in the window seeded) ──
    'series', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'date', to_char(b.day, 'YYYY-MM-DD'),
        'clicks', coalesce(cl.n, 0),
        'signups', coalesce(su.n, 0),
        'qualified', coalesce(qu.n, 0),
        'granted', coalesce(gr.n, 0)
      ) ORDER BY b.day), '[]'::jsonb)
      FROM generate_series(v_start, date_trunc('day', now()), '1 day'::interval) AS b(day)
      LEFT JOIN LATERAL (
        SELECT count(*) AS n FROM public.affiliate_clicks a
        WHERE a.created_at >= b.day AND a.created_at < b.day + '1 day'::interval
      ) cl ON true
      LEFT JOIN LATERAL (
        SELECT count(*) AS n FROM public.referral_events e
        WHERE e.created_at >= b.day AND e.created_at < b.day + '1 day'::interval
      ) su ON true
      LEFT JOIN LATERAL (
        SELECT count(*) AS n FROM public.referral_events e
        WHERE e.qualified_at >= b.day AND e.qualified_at < b.day + '1 day'::interval
      ) qu ON true
      LEFT JOIN LATERAL (
        SELECT count(*) AS n FROM public.referral_events e
        WHERE e.granted_at >= b.day AND e.granted_at < b.day + '1 day'::interval
      ) gr ON true
    ),

    -- ── Window totals + conversion rates ──
    'totals', (
      SELECT jsonb_build_object(
        'clicks', (SELECT count(*) FROM public.affiliate_clicks WHERE created_at >= v_start),
        'signups', (SELECT count(*) FROM public.referral_events WHERE created_at >= v_start),
        'qualified', (SELECT count(*) FROM public.referral_events WHERE qualified_at >= v_start),
        'granted', (SELECT count(*) FROM public.referral_events WHERE granted_at >= v_start)
      )
    ),

    'conversion', (
      WITH t AS (
        SELECT
          (SELECT count(*) FROM public.affiliate_clicks WHERE created_at >= v_start) AS clicks,
          (SELECT count(*) FROM public.referral_events WHERE created_at >= v_start) AS signups,
          (SELECT count(*) FROM public.referral_events WHERE qualified_at >= v_start) AS qualified,
          (SELECT count(*) FROM public.referral_events WHERE granted_at >= v_start) AS granted
      )
      SELECT jsonb_build_object(
        'click_to_signup', CASE WHEN t.clicks > 0
          THEN round(100.0 * t.signups / t.clicks, 1) ELSE 0 END,
        'signup_to_qualified', CASE WHEN t.signups > 0
          THEN round(100.0 * t.qualified / t.signups, 1) ELSE 0 END,
        'qualified_to_granted', CASE WHEN t.qualified > 0
          THEN round(100.0 * t.granted / t.qualified, 1) ELSE 0 END
      ) FROM t
    ),

    -- ── K-factor proxy: all-time successful referrals per referring user ──
    'k_factor', (
      SELECT CASE WHEN count(DISTINCT referrer_user_id) > 0
        THEN round(count(*)::numeric / count(DISTINCT referrer_user_id), 2)
        ELSE 0 END
      FROM public.referral_events
    ),
    'referrers', (
      SELECT count(DISTINCT referrer_user_id) FROM public.referral_events
    ),

    -- ── Cohort comparison: referred vs direct ──
    'cohorts', (
      WITH referred AS (
        SELECT DISTINCT referred_user_id AS user_id FROM public.referral_events
      ),
      base AS (
        SELECT
          u.id,
          (u.id IN (SELECT user_id FROM referred)) AS is_referred,
          EXISTS (SELECT 1 FROM public.submissions s WHERE s.user_id = u.id) AS activated,
          coalesce((
            SELECT sum(pc.price_cents)
            FROM public.grade_credit_transactions t
            LEFT JOIN public.pricing_config pc
              ON pc.kind = 'credit_pack' AND pc.credits = t.delta
            WHERE t.user_id = u.id AND t.reason = 'pack_purchase'
          ), 0) AS revenue_cents
        FROM public.users u
      ),
      agg AS (
        SELECT
          is_referred,
          count(*) AS users,
          count(*) FILTER (WHERE activated) AS activated,
          count(*) FILTER (WHERE revenue_cents > 0) AS paying,
          sum(revenue_cents) AS revenue_cents
        FROM base
        GROUP BY is_referred
      )
      SELECT jsonb_build_object(
        'referred', (
          SELECT jsonb_build_object(
            'users', coalesce(a.users, 0),
            'activated', coalesce(a.activated, 0),
            'activation_rate', CASE WHEN coalesce(a.users, 0) > 0
              THEN round(100.0 * a.activated / a.users, 1) ELSE 0 END,
            'paying', coalesce(a.paying, 0),
            'paying_rate', CASE WHEN coalesce(a.users, 0) > 0
              THEN round(100.0 * a.paying / a.users, 1) ELSE 0 END,
            'revenue_cents', coalesce(a.revenue_cents, 0),
            'ltv_cents', CASE WHEN coalesce(a.users, 0) > 0
              THEN round(a.revenue_cents::numeric / a.users) ELSE 0 END
          ) FROM (SELECT * FROM agg WHERE is_referred) a
        ),
        'direct', (
          SELECT jsonb_build_object(
            'users', coalesce(a.users, 0),
            'activated', coalesce(a.activated, 0),
            'activation_rate', CASE WHEN coalesce(a.users, 0) > 0
              THEN round(100.0 * a.activated / a.users, 1) ELSE 0 END,
            'paying', coalesce(a.paying, 0),
            'paying_rate', CASE WHEN coalesce(a.users, 0) > 0
              THEN round(100.0 * a.paying / a.users, 1) ELSE 0 END,
            'revenue_cents', coalesce(a.revenue_cents, 0),
            'ltv_cents', CASE WHEN coalesce(a.users, 0) > 0
              THEN round(a.revenue_cents::numeric / a.users) ELSE 0 END
          ) FROM (SELECT * FROM agg WHERE NOT is_referred) a
        )
      )
    )
  ) INTO result;

  RETURN result;
END;
$$;

COMMENT ON FUNCTION public.referral_analytics(integer) IS
  'US-1071: virality rollup for the admin referral dashboard — daily funnel '
  '(clicks→signups→qualified→granted), conversion %, K-factor proxy, and '
  'referred- vs direct-cohort activation/paying/LTV, as one jsonb document. '
  'LTV is gross credit-pack revenue (priced from pricing_config) — directional, '
  'same reconciliation tolerance as revenue_dashboard. SECURITY DEFINER '
  '(cross-tenant); admin or service-role only.';

GRANT EXECUTE ON FUNCTION public.referral_analytics(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.referral_analytics(integer) TO service_role;

COMMIT;
