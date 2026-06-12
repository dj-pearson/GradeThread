-- US-377: Capture explicit ToS/Privacy acceptance at signup (clickwrap)
--
-- Today signup.tsx shows only a PASSIVE "by creating an account you agree…"
-- browsewrap line, nothing is recorded, and OAuth (Google) bypasses it entirely.
-- That is not provable/enforceable consent. This migration adds the data needed
-- to record AFFIRMATIVE clickwrap consent with the document VERSION + a TIMESTAMP,
-- for every signup path (email + OAuth), plus a re-acceptance trail for future
-- material changes:
--
--   1. `users.{tos,privacy}_accepted_{version,at}` — the CURRENT accepted version
--      per user. The client gate reads these (RLS-protected own-row read) to
--      decide whether to block the dashboard until the user re-accepts.
--
--   2. `legal_acceptances` — an append-only audit log: one row per acceptance
--      EVENT (signup, oauth, re-acceptance) with both versions, the method, and
--      best-effort user-agent/IP. This is the provable, EXPORTABLE record.
--
--   3. handle_new_user() is extended to persist acceptance passed in the email
--      signup metadata (options.data), so email signups are recorded server-side
--      at account creation. OAuth signups carry no such metadata → the columns
--      stay NULL → the client gate captures consent before first dashboard access.

-- ── 1. Current-acceptance columns (fast gate read) ─────────────────────────
ALTER TABLE public.users
  ADD COLUMN tos_accepted_version     text,
  ADD COLUMN tos_accepted_at          timestamptz,
  ADD COLUMN privacy_accepted_version text,
  ADD COLUMN privacy_accepted_at      timestamptz;

COMMENT ON COLUMN public.users.tos_accepted_version IS
  'US-377: version (effective date) of the Terms of Service this user last '
  'affirmatively accepted. NULL = never recorded; the client legal gate then '
  'blocks the dashboard until the user accepts.';
COMMENT ON COLUMN public.users.privacy_accepted_version IS
  'US-377: version (effective date) of the Privacy Policy this user last '
  'affirmatively accepted. See tos_accepted_version.';

-- ── 2. Append-only acceptance audit log (provable + exportable) ────────────
CREATE TABLE public.legal_acceptances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  tos_version     text NOT NULL,
  privacy_version text NOT NULL,
  -- How consent was captured: signup_clickwrap | oauth_clickwrap | reacceptance.
  method          text NOT NULL,
  user_agent      text,              -- best-effort, captured by the edge on accept
  ip_address      text,              -- best-effort (cf-connecting-ip / x-forwarded-for)
  accepted_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_legal_acceptances_user_id ON public.legal_acceptances(user_id);

ALTER TABLE public.legal_acceptances ENABLE ROW LEVEL SECURITY;

-- A user may read their own acceptance history (powers the exportable record /
-- "you agreed on …" UI). Rows are written only by the edge service-role client
-- (which bypasses RLS) and the SECURITY DEFINER signup trigger, so there are
-- deliberately no INSERT/UPDATE/DELETE policies for end users — the log is
-- append-only and tamper-resistant from the client's side.
CREATE POLICY "Users can view their own legal acceptances"
  ON public.legal_acceptances FOR SELECT
  USING (user_id = auth.uid());

-- ── 3. Record acceptance from email-signup metadata in handle_new_user ─────
--
-- Re-creates the US-376 resilient trigger, additionally persisting the legal
-- acceptance fields the signup client passes in raw_user_meta_data
-- (tos_version / privacy_version / legal_accepted_at). When both versions are
-- present we set the current-acceptance columns AND append an audit row. The
-- whole body stays inside the US-376 EXCEPTION guard so a logging hiccup can
-- never abort the auth signup.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tos     text := NULLIF(NEW.raw_user_meta_data ->> 'tos_version', '');
  v_privacy text := NULLIF(NEW.raw_user_meta_data ->> 'privacy_version', '');
  v_at      timestamptz;
BEGIN
  -- Parse the client-supplied acceptance timestamp; fall back to now() if it's
  -- missing or malformed (the client value is untrusted).
  BEGIN
    v_at := COALESCE((NEW.raw_user_meta_data ->> 'legal_accepted_at')::timestamptz, now());
  EXCEPTION WHEN OTHERS THEN
    v_at := now();
  END;

  INSERT INTO public.users (
    id, email, full_name, avatar_url,
    flipdesk_plan, subscription_status, trial_ends_at,
    tos_accepted_version, tos_accepted_at,
    privacy_accepted_version, privacy_accepted_at
  )
  VALUES (
    NEW.id,
    NEW.email,
    -- Trim, strip control chars, cap at 200 chars; empty -> NULL.
    NULLIF(
      left(regexp_replace(trim(NEW.raw_user_meta_data ->> 'full_name'), '[[:cntrl:]]', '', 'g'), 200),
      ''
    ),
    -- avatar_url is provider-supplied (OAuth); cap defensively.
    left(NEW.raw_user_meta_data ->> 'avatar_url', 1000),
    'pro',
    'trialing',
    now() + interval '14 days',
    -- Only stamp the current-acceptance columns when the clickwrap metadata was
    -- supplied (email signup). OAuth signups leave these NULL for the gate.
    CASE WHEN v_tos IS NOT NULL THEN left(v_tos, 64) END,
    CASE WHEN v_tos IS NOT NULL THEN v_at END,
    CASE WHEN v_privacy IS NOT NULL THEN left(v_privacy, 64) END,
    CASE WHEN v_privacy IS NOT NULL THEN v_at END
  )
  ON CONFLICT (id) DO NOTHING;

  -- Append the audit row for an email clickwrap signup.
  IF v_tos IS NOT NULL AND v_privacy IS NOT NULL THEN
    INSERT INTO public.legal_acceptances (
      user_id, tos_version, privacy_version, method, accepted_at
    )
    VALUES (
      NEW.id, left(v_tos, 64), left(v_privacy, 64), 'signup_clickwrap', v_at
    );
  END IF;

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- A profile / acceptance-row problem must NEVER abort the auth signup.
    RAISE WARNING 'handle_new_user: profile creation failed for % (%): %',
      NEW.id, NEW.email, SQLERRM;
    RETURN NEW;
END;
$$;
