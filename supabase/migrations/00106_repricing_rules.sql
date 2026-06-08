-- Repricing automation (US-672). The existing /pricing engine is one-shot:
-- scan → comp-based suggestion → manual tap-to-apply. This adds owner-defined
-- RULES that a server-side runner (on-demand + a daily cron) applies
-- automatically: "drop X% every N days down to a floor", optionally auto-
-- accepting a high-confidence comp suggestion instead. Automation only ever
-- LOWERS prices (stale inventory markdown) — never raises them unattended.
--
-- repricing_actions is the audit log the app reads to "report applied changes".

CREATE TABLE public.repricing_rules (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name                   text NOT NULL,
  enabled                boolean NOT NULL DEFAULT true,
  -- Scope. A single item (inventory_item_id set) OR a saved filter
  -- (brand / category / minimum listing age). All filters NULL/0 = every active
  -- eBay listing the owner has.
  inventory_item_id      uuid REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  filter_brand           text,
  filter_category_id     text,
  min_age_days           integer NOT NULL DEFAULT 0 CHECK (min_age_days >= 0),
  -- Action: drop drop_pct% no more often than every interval_days, never below
  -- floor_price_cents.
  drop_pct               numeric(5,2) NOT NULL DEFAULT 0
                           CHECK (drop_pct >= 0 AND drop_pct <= 90),
  interval_days          integer NOT NULL DEFAULT 7 CHECK (interval_days >= 1),
  floor_price_cents      integer CHECK (floor_price_cents IS NULL OR floor_price_cents >= 0),
  -- Optional: instead of a flat drop, auto-apply a pending comp suggestion whose
  -- confidence >= this (0..1) — but only when it's a price CUT.
  auto_accept_confidence numeric(3,2)
                           CHECK (auto_accept_confidence IS NULL
                                  OR (auto_accept_confidence >= 0 AND auto_accept_confidence <= 1)),
  last_run_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_repricing_rules_user_id
  ON public.repricing_rules(user_id);
CREATE INDEX idx_repricing_rules_enabled
  ON public.repricing_rules(user_id) WHERE enabled;

CREATE TRIGGER set_repricing_rules_updated_at
  BEFORE UPDATE ON public.repricing_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.repricing_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own repricing rules"
  ON public.repricing_rules FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create repricing rules"
  ON public.repricing_rules FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own repricing rules"
  ON public.repricing_rules FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own repricing rules"
  ON public.repricing_rules FOR DELETE USING (auth.uid() = user_id);

-- ══════════════════════════════════════════════════════════
-- Audit log: every automatic price change a rule applied.
-- Written by the service-role runner; users only read their own.
-- ══════════════════════════════════════════════════════════

CREATE TABLE public.repricing_actions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  rule_id            uuid REFERENCES public.repricing_rules(id) ON DELETE SET NULL,
  listing_id         uuid REFERENCES public.listings(id) ON DELETE CASCADE,
  inventory_item_id  uuid REFERENCES public.inventory_items(id) ON DELETE SET NULL,
  old_price_cents    integer NOT NULL,
  new_price_cents    integer NOT NULL,
  -- 'scheduled_markdown' | 'auto_accept'
  reason             text NOT NULL,
  ebay_synced        boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_repricing_actions_user_created
  ON public.repricing_actions(user_id, created_at DESC);
CREATE INDEX idx_repricing_actions_listing_created
  ON public.repricing_actions(listing_id, created_at DESC);
CREATE INDEX idx_repricing_actions_rule
  ON public.repricing_actions(rule_id) WHERE rule_id IS NOT NULL;

ALTER TABLE public.repricing_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own repricing actions"
  ON public.repricing_actions FOR SELECT USING (auth.uid() = user_id);
