-- US-624: Growth / Promote suite schema.
--
-- The super-admin "Promote" surface: reusable audience segments, multi-channel
-- broadcast campaigns (email / in-app / push), in-app announcement banners, and
-- a referral program. All admin-owned tables are RLS-gated to is_admin(); the
-- two user-facing reads (active announcements, own referral code/events) get
-- narrowly scoped policies. Service-role edge handlers do the privileged writes
-- and remain responsible for explicit tenant scoping where a user is the target.
--
-- Additive only — no existing table is altered.

-- ══════════════════════════════════════════════════════════
-- HELPERS
-- ══════════════════════════════════════════════════════════

-- Mirrors public.is_admin() (00003) but restricted to super_admin. Used by RLS
-- on the most sensitive growth surfaces and available to future policies.
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
    AND role = 'super_admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ══════════════════════════════════════════════════════════
-- ENUMS
-- ══════════════════════════════════════════════════════════

CREATE TYPE public.campaign_channel AS ENUM ('email', 'in_app', 'push');
CREATE TYPE public.campaign_status AS ENUM (
  'draft', 'scheduled', 'sending', 'sent', 'failed', 'canceled'
);
CREATE TYPE public.campaign_recipient_status AS ENUM (
  'pending', 'sent', 'failed', 'skipped'
);
CREATE TYPE public.announcement_variant AS ENUM (
  'info', 'success', 'warning', 'promo'
);
CREATE TYPE public.referral_reward_status AS ENUM (
  'pending', 'qualified', 'granted', 'void'
);

-- ══════════════════════════════════════════════════════════
-- TABLES
-- ══════════════════════════════════════════════════════════

-- A saved, rule-based cohort. `rules` is a validated rule tree (see edge
-- lib/segments.ts) — { match: 'all'|'any', conditions: [{field, op, value}] }.
CREATE TABLE public.audience_segments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  rules       jsonb NOT NULL DEFAULT '{"match":"all","conditions":[]}'::jsonb,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES public.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- A broadcast = message + channels + target segment + schedule + status.
-- `stats` caches roll-up counts so the list view doesn't re-aggregate the
-- recipients ledger on every read.
CREATE TABLE public.growth_campaigns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  subject       text NOT NULL,             -- email subject / in-app + push title
  body          text NOT NULL,
  cta_label     text,
  cta_url       text,
  channels      public.campaign_channel[] NOT NULL DEFAULT '{}',
  segment_id    uuid REFERENCES public.audience_segments(id) ON DELETE SET NULL,
  status        public.campaign_status NOT NULL DEFAULT 'draft',
  scheduled_for timestamptz,
  sent_at       timestamptz,
  stats         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by    uuid REFERENCES public.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Per-user-per-channel delivery ledger. The UNIQUE key makes the send engine
-- idempotent: re-running a send can't double-insert a recipient row.
CREATE TABLE public.campaign_recipients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.growth_campaigns(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  channel     public.campaign_channel NOT NULL,
  status      public.campaign_recipient_status NOT NULL DEFAULT 'pending',
  error       text,
  sent_at     timestamptz,
  opened_at   timestamptz,
  clicked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, user_id, channel)
);

-- In-app banner. Optional segment targeting + time window + dismissible flag.
CREATE TABLE public.announcements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  body        text NOT NULL,
  variant     public.announcement_variant NOT NULL DEFAULT 'info',
  cta_label   text,
  cta_url     text,
  segment_id  uuid REFERENCES public.audience_segments(id) ON DELETE SET NULL,
  starts_at   timestamptz NOT NULL DEFAULT now(),
  ends_at     timestamptz,
  dismissible boolean NOT NULL DEFAULT true,
  priority    integer NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES public.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.announcement_dismissals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id uuid NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  dismissed_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (announcement_id, user_id)
);

-- One referral code per user.
CREATE TABLE public.referral_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  code       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- An attributed referral. A user can only be referred once (UNIQUE referred).
CREATE TABLE public.referral_events (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  referred_user_id         uuid NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  code                     text NOT NULL,
  reward_status            public.referral_reward_status NOT NULL DEFAULT 'pending',
  referrer_reward_credits  integer,
  referred_reward_credits  integer,
  qualified_at             timestamptz,
  granted_at               timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  -- Guard against self-referral at the data layer too.
  CONSTRAINT no_self_referral CHECK (referrer_user_id <> referred_user_id)
);

-- ══════════════════════════════════════════════════════════
-- INDEXES
-- ══════════════════════════════════════════════════════════

CREATE INDEX idx_growth_campaigns_status ON public.growth_campaigns(status);
CREATE INDEX idx_growth_campaigns_scheduled
  ON public.growth_campaigns(scheduled_for)
  WHERE status = 'scheduled';
CREATE INDEX idx_campaign_recipients_campaign ON public.campaign_recipients(campaign_id);
CREATE INDEX idx_campaign_recipients_user ON public.campaign_recipients(user_id);
CREATE INDEX idx_announcements_active
  ON public.announcements(is_active, starts_at, ends_at)
  WHERE is_active;
CREATE INDEX idx_announcement_dismissals_user ON public.announcement_dismissals(user_id);
CREATE INDEX idx_referral_events_referrer ON public.referral_events(referrer_user_id);
CREATE INDEX idx_referral_events_status ON public.referral_events(reward_status);

-- ══════════════════════════════════════════════════════════
-- UPDATED_AT TRIGGERS (reuse existing public.set_updated_at)
-- ══════════════════════════════════════════════════════════

CREATE TRIGGER set_audience_segments_updated_at
  BEFORE UPDATE ON public.audience_segments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER set_growth_campaigns_updated_at
  BEFORE UPDATE ON public.growth_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER set_announcements_updated_at
  BEFORE UPDATE ON public.announcements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ══════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.audience_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.growth_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcement_dismissals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_events ENABLE ROW LEVEL SECURITY;

-- Admin-owned tables: full access for admin + super_admin only. The edge
-- service uses the service-role key (bypasses RLS) for its writes; these
-- policies cover any direct client reads from the admin SPA.
CREATE POLICY "Admins manage segments" ON public.audience_segments
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Admins manage campaigns" ON public.growth_campaigns
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Admins read recipients" ON public.campaign_recipients
  FOR SELECT USING (public.is_admin());

-- Announcements: admins manage; any authenticated user may read the ones that
-- are live + in-window (segment matching is applied by the edge, not RLS).
CREATE POLICY "Admins manage announcements" ON public.announcements
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Users read active announcements" ON public.announcements
  FOR SELECT USING (
    is_active
    AND starts_at <= now()
    AND (ends_at IS NULL OR ends_at > now())
  );

-- Dismissals: a user manages their own.
CREATE POLICY "Users manage own dismissals" ON public.announcement_dismissals
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "Admins read dismissals" ON public.announcement_dismissals
  FOR SELECT USING (public.is_admin());

-- Referral codes: a user reads their own; admins read all.
CREATE POLICY "Users read own referral code" ON public.referral_codes
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Admins read referral codes" ON public.referral_codes
  FOR SELECT USING (public.is_admin());

-- Referral events: a user reads rows where they're either side; admins read all.
CREATE POLICY "Users read own referral events" ON public.referral_events
  FOR SELECT USING (
    referrer_user_id = auth.uid() OR referred_user_id = auth.uid()
  );
CREATE POLICY "Admins read referral events" ON public.referral_events
  FOR SELECT USING (public.is_admin());
