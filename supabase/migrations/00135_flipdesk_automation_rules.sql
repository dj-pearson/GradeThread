-- Price-drop and promo scheduler (US-150).
--
-- User-defined automation rules over active eBay listings: a trigger
-- (days listed / no views / low watchers), an action (price drop %, set promo
-- rate %, end listing), and a scope (all listings, or a US-143 filter query).
-- The hourly cron (/api/jobs/automation-rules) evaluates active rules per
-- owner; every applied action is logged to flipdesk_automation_actions.
--
-- trigger_json / action_json / scope_json shapes are validated by the edge
-- service (services/edge-functions/src/lib/automation-rules.ts) — kept as
-- jsonb so trigger/action vocabularies can grow without migrations.

CREATE TABLE IF NOT EXISTS public.flipdesk_automation_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  trigger_json jsonb NOT NULL,
  action_json  jsonb NOT NULL,
  scope_json   jsonb NOT NULL DEFAULT '{"type":"all"}'::jsonb,
  is_active    boolean NOT NULL DEFAULT true,
  last_run_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automation_rules_user
  ON public.flipdesk_automation_rules (user_id);

-- The hourly cron fans out per active rule owner.
CREATE INDEX IF NOT EXISTS idx_automation_rules_active
  ON public.flipdesk_automation_rules (user_id)
  WHERE is_active;

CREATE TRIGGER set_flipdesk_automation_rules_updated_at
  BEFORE UPDATE ON public.flipdesk_automation_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.flipdesk_automation_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own automation rules"
  ON public.flipdesk_automation_rules FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own automation rules"
  ON public.flipdesk_automation_rules FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own automation rules"
  ON public.flipdesk_automation_rules FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own automation rules"
  ON public.flipdesk_automation_rules FOR DELETE
  USING (auth.uid() = user_id);

-- Per-rule activity log: what the automation actually did (before/after).
-- Also the cooldown anchor — a rule won't re-fire on a listing until
-- trigger_json.cooldown_days have elapsed since its latest logged action.
CREATE TABLE IF NOT EXISTS public.flipdesk_automation_actions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id           uuid NOT NULL REFERENCES public.flipdesk_automation_rules(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  listing_id        uuid REFERENCES public.listings(id) ON DELETE SET NULL,
  inventory_item_id uuid REFERENCES public.inventory_items(id) ON DELETE SET NULL,
  action_type       text NOT NULL,
  before_json       jsonb,
  after_json        jsonb,
  ebay_synced       boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automation_actions_rule
  ON public.flipdesk_automation_actions (rule_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_automation_actions_user_listing
  ON public.flipdesk_automation_actions (user_id, listing_id);

ALTER TABLE public.flipdesk_automation_actions ENABLE ROW LEVEL SECURITY;

-- Rows are written only by the edge service (service role); users read their own.
CREATE POLICY "Users can view own automation actions"
  ON public.flipdesk_automation_actions FOR SELECT
  USING (auth.uid() = user_id);

-- Per-listing override (AC: "Exclude from automations" toggle on item detail).
-- Item-level because the toggle lives on the item page and a relist (new
-- listings row) should stay excluded.
ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS exclude_from_automations boolean NOT NULL DEFAULT false;

-- Promoted Listings ad rate, local-first (the eBay Marketing API push is
-- deferred — same precedent as US-141's promote action).
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS promo_rate_pct numeric(5,2);
