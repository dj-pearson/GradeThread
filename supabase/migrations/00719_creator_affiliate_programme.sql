-- US-9212: separate the CREATOR programme from user referral.
--
-- The decision (vault/60-decisions/adr-referral-cash-payout.md section 6) is
-- cash for creators, grade credits for users. Until this migration the payout
-- engine could not tell them apart: every affiliate-attributed conversion was
-- the same row, so flipping affiliate_payout_config.mode to "batched" would
-- have started paying cash to every user who had ever shared a link.
--
-- Two changes make the split structural rather than a convention:
--
--   1. affiliate_accounts.program says which programme the account is in. The
--      default is 'user', so an existing row cannot become a cash creator by
--      accident, and the CHECK below refuses 'creator' without a recorded
--      terms acceptance -- the separate consent AC2 asks for is a column the
--      database enforces, not a checkbox the client remembers.
--   2. affiliate_commissions records WHICH model each row was accrued under
--      and, for the percentage model, which paid invoice earned it. That is
--      what makes a model switch safe: rows accrued as 'flat' keep their
--      amount and their meaning.
--
-- Terms text and version: vault/50-business/creator-affiliate-terms.md.

-- ══════════════════════════════════════════════════════════
-- 1. The programme flag + the consent that unlocks it
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.affiliate_accounts
  ADD COLUMN IF NOT EXISTS program text NOT NULL DEFAULT 'user';
ALTER TABLE public.affiliate_accounts
  ADD COLUMN IF NOT EXISTS creator_terms_version text;
ALTER TABLE public.affiliate_accounts
  ADD COLUMN IF NOT EXISTS creator_terms_accepted_at timestamptz;
-- An operator admits a creator to the programme. Terms acceptance alone is an
-- application, not an admission: the first ten creators are sourced by hand
-- (AC7), and self-serve cash is not what the ADR decided.
ALTER TABLE public.affiliate_accounts
  ADD COLUMN IF NOT EXISTS creator_approved_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_accounts_program_check'
  ) THEN
    ALTER TABLE public.affiliate_accounts
      ADD CONSTRAINT affiliate_accounts_program_check
      CHECK (program IN ('user', 'creator'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_accounts_creator_needs_consent'
  ) THEN
    ALTER TABLE public.affiliate_accounts
      ADD CONSTRAINT affiliate_accounts_creator_needs_consent
      CHECK (
        program <> 'creator'
        OR (creator_terms_accepted_at IS NOT NULL AND creator_terms_version IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_affiliate_accounts_creator
  ON public.affiliate_accounts (program) WHERE program = 'creator';

COMMENT ON COLUMN public.affiliate_accounts.program IS
  'US-9212: user (grade credits, no cash) or creator (cash commission). creator requires a recorded terms acceptance.';

-- ══════════════════════════════════════════════════════════
-- 2. What each commission row was earned under
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.affiliate_commissions
  ADD COLUMN IF NOT EXISTS commission_model text NOT NULL DEFAULT 'flat';
-- The referred account whose subscription earned this row. Kept alongside the
-- referral event so the per-account cap can be summed without a join through
-- referral_events.
ALTER TABLE public.affiliate_commissions
  ADD COLUMN IF NOT EXISTS referred_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;
-- The paid Stripe invoice that earned it. NULL for the flat bounty.
ALTER TABLE public.affiliate_commissions
  ADD COLUMN IF NOT EXISTS stripe_invoice_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_commissions_model_check'
  ) THEN
    ALTER TABLE public.affiliate_commissions
      ADD CONSTRAINT affiliate_commissions_model_check
      CHECK (commission_model IN ('flat', 'subscription_pct'));
  END IF;
END $$;

-- Idempotency, split in two. The flat bounty is one row per conversion, which
-- is what the original UNIQUE(referral_event_id) said. The percentage model is
-- one row per PAID INVOICE, and a referred account pays many invoices inside
-- its window -- so that constraint would have refused every renewal after the
-- first. Replace it with two partial unique indexes that each say the right
-- thing for their own model.
ALTER TABLE public.affiliate_commissions
  DROP CONSTRAINT IF EXISTS uniq_affiliate_commission_event;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_affiliate_commission_event
  ON public.affiliate_commissions (referral_event_id)
  WHERE stripe_invoice_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_affiliate_commission_invoice
  ON public.affiliate_commissions (stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;

-- The cap is per referred account: sum what this affiliate has already earned
-- from this account.
CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_referred
  ON public.affiliate_commissions (affiliate_user_id, referred_user_id)
  WHERE referred_user_id IS NOT NULL;

COMMENT ON COLUMN public.affiliate_commissions.commission_model IS
  'US-9212: flat (fixed bounty per conversion, US-1295) or subscription_pct (percent of a paid invoice, capped per referred account).';

insert into public.applied_migrations (version) values ('00719') on conflict do nothing;
