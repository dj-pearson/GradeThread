-- New-user onboarding: capture the user's primary use case and record when
-- they finished (or skipped) the onboarding flow so it shows only once.

ALTER TABLE public.users
  ADD COLUMN use_case text
    CHECK (use_case IN ('seller', 'buyer', 'consignment', 'developer')),
  ADD COLUMN onboarded_at timestamptz;
