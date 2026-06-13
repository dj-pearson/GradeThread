-- US-603: Affiliate / earned-link channel on top of the existing referral ledger.
--
-- US-629 (migration 00102) already gives every user a referral code + a reward
-- ledger (referral_events) that grants grade credits when a referred user
-- qualifies. This migration adds the *earned-link* acquisition channel that the
-- heavy SEO/content investment (US-291..435) can amplify: a "Graded by
-- GradeThread" badge a seller embeds on their listings/site. A click on that
-- badge lands a visitor on the site with ?ref=<code>; we log the click here for
-- attribution analytics, and when that visitor signs up + redeems we tag the
-- referral with attribution_source = 'affiliate' so the channel is measurable.
--
-- The reward/payout side is intentionally NOT re-built — affiliate conversions
-- flow through the SAME referral_events ledger and the SAME admin-side credit
-- grant (admin-growth.ts), which is step-up gated + audited. This file only adds
-- the click-tracking surface + the attribution tag.

BEGIN;

-- ══════════════════════════════════════════════════════════
-- TABLES
-- ══════════════════════════════════════════════════════════

-- One row per click on a "Graded by GradeThread" earned link / badge. Written
-- by the PUBLIC (unauthenticated) /api/affiliate/click endpoint via the
-- service-role client, so there is no FK to an authenticated user here — the
-- code is the join key back to its owner (referral_codes.code). converted_user_id
-- is best-effort stamped when a landed visitor later redeems.
CREATE TABLE public.affiliate_clicks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL,
  -- Where the badge/link lives: 'badge' (embedded image badge), 'link' (plain
  -- text/share link), or 'certificate' (the public cert "graded by" link).
  source            text NOT NULL DEFAULT 'link',
  landing_path      text,
  referrer_host     text,
  converted_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- US-603: tag a referral with the channel it came through so the affiliate
-- earned-link funnel is measurable separately from direct/manual redemptions.
-- 'direct' = code typed in by hand; 'affiliate' = attributed from a stored
-- ?ref= captured off an earned link.
ALTER TABLE public.referral_events
  ADD COLUMN IF NOT EXISTS attribution_source text NOT NULL DEFAULT 'direct';

-- ══════════════════════════════════════════════════════════
-- INDEXES
-- ══════════════════════════════════════════════════════════

CREATE INDEX idx_affiliate_clicks_code ON public.affiliate_clicks(code);
CREATE INDEX idx_affiliate_clicks_created ON public.affiliate_clicks(created_at);
CREATE INDEX idx_affiliate_clicks_converted
  ON public.affiliate_clicks(converted_user_id)
  WHERE converted_user_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.affiliate_clicks ENABLE ROW LEVEL SECURITY;

-- A user reads only the clicks attributed to THEIR code (joined through the
-- referral_codes table they already own). The edge service writes via the
-- service-role key (bypasses RLS); this policy covers any direct client read.
CREATE POLICY "Users read own affiliate clicks" ON public.affiliate_clicks
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.referral_codes rc
      WHERE rc.code = affiliate_clicks.code
        AND rc.user_id = auth.uid()
    )
  );
CREATE POLICY "Admins read affiliate clicks" ON public.affiliate_clicks
  FOR SELECT USING (public.is_admin());

COMMIT;
