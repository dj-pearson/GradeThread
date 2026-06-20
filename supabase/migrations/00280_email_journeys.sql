-- US-929: Lifecycle drip series (welcome, trial-nurture, win-back).
--
-- A general lifecycle email-journey engine that complements the focused
-- trial-conversion drip (drip_campaigns, 00255). A daily evaluation job
-- (POST /api/jobs/journey-tick) enrolls users whose state matches a journey's
-- trigger and walks them through an ordered, time-offset series of steps,
-- reusing the SAME send stack (emailLayout render + coordinateMarketingSend for
-- marketing classes / durable transactional send for lifecycle-transactional
-- ones), honoring consent (US-911) + suppression (US-914) + the cross-program
-- frequency cap (US-934).
--
-- Substrate:
--   • email_journeys            — one row per journey: its trigger, email class
--                                 (transactional vs marketing), enrolment window
--                                 and the master enable toggle the admin flips.
--   • email_journey_steps       — the ordered, day-offset steps (subject + body
--                                 template + CTA), reusing {{token}} personalization.
--   • email_journey_enrollments — per-(journey,user) enrolment; UNIQUE so each user
--                                 advances through a series ONCE (idempotent), with
--                                 the cursor (current_step / next_step_at) and the
--                                 exit/goal terminal.
--   • email_journey_step_sends  — per-(enrollment,step) send/skip ledger; UNIQUE so
--                                 a step is sent once + the admin metrics roll up
--                                 per step.
--
-- The trial-nurture journey (trigger = trial_ending) finally closes the
-- long-standing gap where the trial-expiry downgrade cron (US-383) demotes a
-- user without ever warning them first.
--
-- All four tables are service-role only (RLS enabled, REVOKE, zero policies):
-- they are written/read ONLY by the edge journey engine + the role-gated
-- /api/admin/journeys console via the service-role client; the SPA never reads
-- the raw rows. (email_journey_enrollments.user_id is the enrolled tenant, not a
-- client read key — same model as drip_enrollments.)
--
-- Additive + idempotent.

BEGIN;

-- ── Journeys ─────────────────────────────────────────────────────────────────
-- `trigger` is the user-state event that enrols a user. `email_class` decides
-- the send path: 'transactional' (welcome — never capped, no opt-out, durable
-- retry) vs 'marketing' (win-back / nurture — consent + suppression + cap +
-- one-click unsubscribe, via coordinateMarketingSend). `trigger_window_days`
-- parameterizes the trigger (trial_ending: enrol when trial_ends_at is within N
-- days; inactivity: enrol after N days with no activity; signup/first_*: enrol on
-- the event within the last N days). `enabled` is the admin master switch — every
-- seeded journey ships OFF so an operator deliberately turns each on.
CREATE TABLE IF NOT EXISTS public.email_journeys (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_key         text NOT NULL UNIQUE,                  -- stable slug (e.g. 'welcome')
  name                text NOT NULL,
  description         text NOT NULL DEFAULT '',
  trigger             text NOT NULL
                        CHECK (trigger IN (
                          'signup', 'trial_ending', 'inactivity',
                          'first_grade', 'first_sale'
                        )),
  email_class         text NOT NULL DEFAULT 'marketing'
                        CHECK (email_class IN ('transactional', 'marketing')),
  trigger_window_days integer NOT NULL DEFAULT 3
                        CHECK (trigger_window_days >= 0),
  enabled             boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_journeys IS
  'US-929: lifecycle email journeys (welcome/trial-nurture/win-back). Operator '
  'surface — service-role only. trigger drives enrolment; email_class drives the '
  'send path (transactional vs marketing); enabled is the admin master switch.';

CREATE INDEX IF NOT EXISTS email_journeys_enabled_idx
  ON public.email_journeys (enabled);
CREATE INDEX IF NOT EXISTS email_journeys_trigger_idx
  ON public.email_journeys (trigger);

CREATE OR REPLACE FUNCTION public.set_email_journeys_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_email_journeys_updated_at ON public.email_journeys;
CREATE TRIGGER trg_email_journeys_updated_at
  BEFORE UPDATE ON public.email_journeys
  FOR EACH ROW EXECUTE FUNCTION public.set_email_journeys_updated_at();

ALTER TABLE public.email_journeys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_journeys FROM anon, authenticated;

-- ── Steps ────────────────────────────────────────────────────────────────────
-- Ordered, day-offset steps. `offset_days` is days after enrolment that the step
-- becomes due. `body_html` is the editable content fragment (may carry {{tokens}}
-- — firstName, trialEndsAt, dashboardUrl, aiIntro); the renderer appends the CTA
-- from cta_label/cta_url. `ai_personalize` opts a step into the optional AI
-- intro line (US-911 consent + content_ai kill-switch still apply; falls back to
-- the static template on any failure).
CREATE TABLE IF NOT EXISTS public.email_journey_steps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id      uuid NOT NULL REFERENCES public.email_journeys(id) ON DELETE CASCADE,
  step_order      integer NOT NULL CHECK (step_order >= 1),
  offset_days     integer NOT NULL DEFAULT 0 CHECK (offset_days >= 0),
  subject         text NOT NULL DEFAULT '',
  body_html       text NOT NULL DEFAULT '',
  cta_label       text,
  cta_url         text,
  ai_personalize  boolean NOT NULL DEFAULT false,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_journey_steps IS
  'US-929: ordered, day-offset steps for an email_journeys row. Operator surface '
  '— service-role only.';

CREATE UNIQUE INDEX IF NOT EXISTS email_journey_steps_order_unique_idx
  ON public.email_journey_steps (journey_id, step_order);
CREATE INDEX IF NOT EXISTS email_journey_steps_journey_idx
  ON public.email_journey_steps (journey_id);

DROP TRIGGER IF EXISTS trg_email_journey_steps_updated_at ON public.email_journey_steps;
CREATE TRIGGER trg_email_journey_steps_updated_at
  BEFORE UPDATE ON public.email_journey_steps
  FOR EACH ROW EXECUTE FUNCTION public.set_email_journeys_updated_at();

ALTER TABLE public.email_journey_steps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_journey_steps FROM anon, authenticated;

-- ── Enrolments ───────────────────────────────────────────────────────────────
-- One row per (journey, user). The UNIQUE index makes "each user advances through
-- a series once" a DB invariant (idempotent enrolment — never re-enrol). The
-- cursor is current_step (highest step_order sent) + next_step_at (when to next
-- evaluate; the engine self-gates on it). A terminal stamps exited_at/exit_reason
-- (goal met / opted-out / suppressed) or completed_at (ran the whole series).
CREATE TABLE IF NOT EXISTS public.email_journey_enrollments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id      uuid NOT NULL REFERENCES public.email_journeys(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  enrolled_at     timestamptz NOT NULL DEFAULT now(),
  current_step    integer NOT NULL DEFAULT 0,
  next_step_at    timestamptz,                              -- when to next evaluate
  completed_at    timestamptz,                              -- ran the whole series
  exited_at       timestamptz,                              -- goal met / opt-out / suppressed
  exit_reason     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_journey_enrollments IS
  'US-929: per-(journey,user) enrolment with the cursor + exit/goal terminal. '
  'UNIQUE(journey_id,user_id) = each user runs a series once (idempotent). '
  'Service-role only; user_id is the enrolled tenant, not a client read key.';

CREATE UNIQUE INDEX IF NOT EXISTS email_journey_enrollments_unique_idx
  ON public.email_journey_enrollments (journey_id, user_id);
CREATE INDEX IF NOT EXISTS email_journey_enrollments_due_idx
  ON public.email_journey_enrollments (journey_id, next_step_at)
  WHERE exited_at IS NULL AND completed_at IS NULL;

DROP TRIGGER IF EXISTS trg_email_journey_enrollments_updated_at ON public.email_journey_enrollments;
CREATE TRIGGER trg_email_journey_enrollments_updated_at
  BEFORE UPDATE ON public.email_journey_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.set_email_journeys_updated_at();

ALTER TABLE public.email_journey_enrollments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_journey_enrollments FROM anon, authenticated;

-- ── Per-step send/skip ledger ────────────────────────────────────────────────
-- One row per (enrollment, step). UNIQUE makes the send idempotent (a step is
-- sent once) and powers the per-step admin metrics roll-up. sent_at set = sent
-- (or durably enqueued); skip_reason set with sent_at null = skipped (opted-out /
-- suppressed / deferred-elsewhere). No user_id of its own (tenancy flows through
-- the enrollment), so it is not auto-discovered by the rls-guard.
CREATE TABLE IF NOT EXISTS public.email_journey_step_sends (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id   uuid NOT NULL REFERENCES public.email_journey_enrollments(id) ON DELETE CASCADE,
  journey_id      uuid NOT NULL REFERENCES public.email_journeys(id) ON DELETE CASCADE,
  step_order      integer NOT NULL,
  recipient       text,
  sent_at         timestamptz,
  skip_reason     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_journey_step_sends IS
  'US-929: per-(enrollment,step) send/skip ledger. UNIQUE(enrollment_id,step_order) '
  '= idempotent per-step send + admin per-step metrics. Service-role only.';

CREATE UNIQUE INDEX IF NOT EXISTS email_journey_step_sends_unique_idx
  ON public.email_journey_step_sends (enrollment_id, step_order);
CREATE INDEX IF NOT EXISTS email_journey_step_sends_metrics_idx
  ON public.email_journey_step_sends (journey_id, step_order);

ALTER TABLE public.email_journey_step_sends ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_journey_step_sends FROM anon, authenticated;

-- ── Platform-wide kill-switch (feature flag) ─────────────────────────────────
-- A dedicated feature_flags row so the whole lifecycle-journey engine can be
-- halted instantly fleet-wide. Seeded ENABLED; the journey tick gates on
-- isFeatureEnabled('lifecycle_journeys'). (Individual journeys still ship OFF via
-- email_journeys.enabled, so nothing sends until an operator enables a journey.)
INSERT INTO public.feature_flags (key, enabled, description)
VALUES (
  'lifecycle_journeys',
  true,
  'US-929: master kill-switch for the lifecycle email-journey engine (welcome / trial-nurture / win-back). Disable to halt all journey sends instantly platform-wide.'
)
ON CONFLICT (key) DO NOTHING;

-- ── Seed the three lifecycle journeys (all disabled by default) ───────────────
-- Idempotent: keyed on journey_key; steps keyed on (journey_id, step_order).

-- 1. Welcome (signup) — lifecycle-transactional onboarding.
INSERT INTO public.email_journeys (journey_key, name, description, trigger, email_class, trigger_window_days, enabled)
VALUES (
  'welcome', 'Welcome series',
  'Onboards a new signup: a welcome + getting-started nudge over the first few days.',
  'signup', 'transactional', 7, false
)
ON CONFLICT (journey_key) DO NOTHING;

-- 2. Trial-ending nurture — marketing; closes the no-warning trial-expiry gap (US-383).
INSERT INTO public.email_journeys (journey_key, name, description, trigger, email_class, trigger_window_days, enabled)
VALUES (
  'trial-nurture', 'Trial-ending nurture',
  'Warns a trialist their Pro trial is ending and nudges them to add a card before the auto-downgrade.',
  'trial_ending', 'marketing', 3, false
)
ON CONFLICT (journey_key) DO NOTHING;

-- 3. Win-back — marketing; re-engages an inactive user.
INSERT INTO public.email_journeys (journey_key, name, description, trigger, email_class, trigger_window_days, enabled)
VALUES (
  'win-back', 'Win-back series',
  'Re-engages a user who has had no activity for the configured window.',
  'inactivity', 'marketing', 21, false
)
ON CONFLICT (journey_key) DO NOTHING;

-- Seed steps for each journey (resolve journey_id by key; idempotent on step_order).
INSERT INTO public.email_journey_steps (journey_id, step_order, offset_days, subject, body_html, cta_label, cta_url, ai_personalize)
SELECT j.id, v.step_order, v.offset_days, v.subject, v.body_html, v.cta_label, v.cta_url, v.ai_personalize
FROM public.email_journeys j
JOIN (
  VALUES
    -- Welcome series
    ('welcome', 1, 0,
      'Welcome to GradeThread, {{firstName}}',
      '<h2 style="margin:0 0 8px;color:#1A1A2E;font-size:20px;">Welcome to GradeThread!</h2>{{aiIntro}}<p style="margin:0 0 16px;color:#666;font-size:15px;line-height:1.5;">Hi {{firstName}}, thanks for joining. You''re ready to start grading clothing with AI precision — upload front, back, label and a detail photo and we''ll grade it instantly. You''re on a 14-day Pro trial, no card required.</p>',
      'Go to your dashboard', '{{dashboardUrl}}', true),
    ('welcome', 2, 2,
      'Grade your first item, {{firstName}}',
      '<h2 style="margin:0 0 8px;color:#1A1A2E;font-size:20px;">Ready for your first grade?</h2><p style="margin:0 0 16px;color:#666;font-size:15px;line-height:1.5;">Hi {{firstName}}, the fastest way to see GradeThread''s value is to grade a real item. Our AI scores fabric, structure, cosmetics, function and cleanliness, then gives you a shareable condition certificate buyers trust.</p>',
      'Submit your first item', '{{dashboardUrl}}/submissions/new', false),
    ('welcome', 3, 5,
      'Get more out of GradeThread',
      '<h2 style="margin:0 0 8px;color:#1A1A2E;font-size:20px;">Three ways to get more value</h2><p style="margin:0 0 16px;color:#666;font-size:15px;line-height:1.5;">Hi {{firstName}}, share your certificates with buyers to build trust, use FlipDesk to manage your eBay listings end-to-end, and grade in bulk to keep your pipeline moving. Your Pro trial unlocks all of it.</p>',
      'Explore your dashboard', '{{dashboardUrl}}', false),
    -- Trial-ending nurture
    ('trial-nurture', 1, 0,
      'Your Pro trial ends {{trialEndsAt}}',
      '<h2 style="margin:0 0 8px;color:#1A1A2E;font-size:20px;">Your Pro trial is ending soon</h2><p style="margin:0 0 16px;color:#666;font-size:15px;line-height:1.5;">Hi {{firstName}}, your 14-day FlipDesk Pro trial ends on <strong>{{trialEndsAt}}</strong>. Add a card now to keep your Pro features without interruption — if you don''t, your account will automatically drop to Free and your caps will tighten (your data stays safe).</p>',
      'Add a card to keep Pro', '{{dashboardUrl}}/billing', false),
    ('trial-nurture', 2, 2,
      'Last chance to keep Pro, {{firstName}}',
      '<h2 style="margin:0 0 8px;color:#1A1A2E;font-size:20px;">Last chance to stay on Pro</h2><p style="margin:0 0 16px;color:#666;font-size:15px;line-height:1.5;">Hi {{firstName}}, your trial ends {{trialEndsAt}}. After that you''ll move to Free automatically — bulk actions, comp pricing, auto-relist and unlimited grading will pause. Add a card now and nothing changes.</p>',
      'Keep my Pro features', '{{dashboardUrl}}/billing', false),
    -- Win-back
    ('win-back', 1, 0,
      'We miss you at GradeThread, {{firstName}}',
      '<h2 style="margin:0 0 8px;color:#1A1A2E;font-size:20px;">We miss you</h2><p style="margin:0 0 16px;color:#666;font-size:15px;line-height:1.5;">Hi {{firstName}}, it''s been a while. Your GradeThread account, grade history and credits are all still here. Grade an item or list one on FlipDesk to pick up right where you left off.</p>',
      'Come back', '{{dashboardUrl}}', false),
    ('win-back', 2, 5,
      'Here''s what''s new at GradeThread',
      '<h2 style="margin:0 0 8px;color:#1A1A2E;font-size:20px;">A lot has improved</h2><p style="margin:0 0 16px;color:#666;font-size:15px;line-height:1.5;">Hi {{firstName}}, we''ve been busy — faster grading, sharper condition reports and a smoother FlipDesk listing flow. Take a fresh look; your account is ready when you are.</p>',
      'See what''s new', '{{dashboardUrl}}', false)
) AS v(journey_key, step_order, offset_days, subject, body_html, cta_label, cta_url, ai_personalize)
  ON v.journey_key = j.journey_key
ON CONFLICT (journey_id, step_order) DO NOTHING;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00280')
ON CONFLICT (version) DO NOTHING;
