-- FlipDesk onboarding tour (US-135): track whether a user has finished or
-- skipped the FlipDesk getting-started checklist so the welcome card shows
-- only once. Re-openable from Settings regardless of this flag.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS flipdesk_onboarded boolean NOT NULL DEFAULT false;
