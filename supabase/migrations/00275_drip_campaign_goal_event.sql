-- US-935: make the drip campaign's GOAL a first-class, declared property.
--
-- The branching drip data model (drip_campaigns, 00255) embeds the step graph in
-- `graph` jsonb and gates the engine on `status` + `feature_flag_key`. What it
-- did NOT carry was an explicit declaration of the campaign's conversion GOAL and
-- its target AUDIENCE — the goal (customer.subscription.created → exit the whole
-- journey) was hardcoded in the engine (lib/drip-conversion.ts) rather than
-- declared on the row. This migration adds those two declarative columns so the
-- data model is self-describing (AC1/AC3): a campaign now DECLARES its
-- goal_event, and reaching that goal is what exits the campaign (the engine
-- already short-circuits a converted enrollment).
--
-- Additive + idempotent: new columns are nullable / defaulted, so the live engine
-- and admin builder keep working unchanged; admin reads surface them.
--
-- NOTE on US-929: there is no separate email_journeys/email_journey_steps table —
-- US-929's linear "three series" (welcome / win-back / trial) were never built as
-- their own engine; this branching engine subsumes them. welcome + win-back are
-- PHASES of the seeded `trial_conversion` campaign (graph phase = in_trial |
-- win_back), so there is nothing to migrate FROM — drip_campaigns is the engine.

BEGIN;

ALTER TABLE public.drip_campaigns
  -- The conversion event whose arrival exits the whole campaign (first-class
  -- goal, AC3). Defaults to the trial→paid conversion the engine watches.
  ADD COLUMN IF NOT EXISTS goal_event text NOT NULL DEFAULT 'subscription_created',
  -- Free-text descriptor of who the campaign targets (e.g. 'trial_no_card').
  -- Documentation/admin-facing; entry filtering still lives in the engine.
  ADD COLUMN IF NOT EXISTS audience text;

COMMENT ON COLUMN public.drip_campaigns.goal_event IS
  'US-935: the conversion event that exits this campaign (e.g. subscription_created).';
COMMENT ON COLUMN public.drip_campaigns.audience IS
  'US-935: human descriptor of the campaign audience (e.g. trial_no_card).';

-- Stamp the seeded trial-conversion campaign's audience (goal_event already
-- defaults correctly). Only touch the row if its audience is still unset so a
-- re-run / operator edit is never clobbered.
UPDATE public.drip_campaigns
   SET audience = 'trial_no_card'
 WHERE campaign = 'trial_conversion'
   AND audience IS NULL;

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00275')
ON CONFLICT DO NOTHING;
