-- FlipDesk cross-promotion (US-136): track whether a user has dismissed the
-- FlipDesk callout shown on the GradeThread dashboard, so it stays hidden
-- once dismissed.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS dismissed_flipdesk_promo boolean NOT NULL DEFAULT false;
