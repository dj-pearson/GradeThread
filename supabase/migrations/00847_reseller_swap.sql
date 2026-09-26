-- US-3541: Reseller Swap. A seller's stale eBay listings are shown, as tips,
-- to other sellers whose own sales say they move that brand fast. The buyer
-- follows the tip to the EXISTING eBay listing and buys it there, so eBay
-- carries the payment, the label, the tax forms and any dispute. GradeThread
-- never takes part in the sale. Contract: vault/20-domain/reseller-swap.md.
--
-- Two tables, both keyed on the account owner:
--
--   reseller_swap_settings   the two opt-ins (share my stale listings / show me
--                            tips) and the seller's own "stale after" day count.
--                            Both opt-ins default OFF, so nothing is shared
--                            until the seller turns it on.
--   reseller_swap_dismissals "don't show me this one again". A row names
--                            ANOTHER seller's inventory item, which is why it is
--                            readable only by the dismisser and says nothing
--                            about who owns the item.
--
-- The edge service writes both with the service-role client; clients may only
-- read their own rows. Idempotent: IF NOT EXISTS / DROP ... IF EXISTS first.

CREATE TABLE IF NOT EXISTS public.reseller_swap_settings (
  user_id          uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  share_stale      boolean NOT NULL DEFAULT false,
  receive_tips     boolean NOT NULL DEFAULT false,
  stale_after_days integer NOT NULL DEFAULT 60
                   CHECK (stale_after_days BETWEEN 14 AND 365),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- The tips query looks up every seller who shares, so index the opt-in.
CREATE INDEX IF NOT EXISTS idx_reseller_swap_settings_sharing
  ON public.reseller_swap_settings(user_id) WHERE share_stale;

DROP TRIGGER IF EXISTS set_reseller_swap_settings_updated_at ON public.reseller_swap_settings;
CREATE TRIGGER set_reseller_swap_settings_updated_at
  BEFORE UPDATE ON public.reseller_swap_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.reseller_swap_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own swap settings" ON public.reseller_swap_settings;
CREATE POLICY "Users can view own swap settings"
  ON public.reseller_swap_settings FOR SELECT
  TO authenticated
  USING (user_id = (select auth.uid()));

CREATE TABLE IF NOT EXISTS public.reseller_swap_dismissals (
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, inventory_item_id)
);

-- The item FK cascades on delete, which needs an index on the child side.
CREATE INDEX IF NOT EXISTS idx_reseller_swap_dismissals_item
  ON public.reseller_swap_dismissals(inventory_item_id);

ALTER TABLE public.reseller_swap_dismissals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own swap dismissals" ON public.reseller_swap_dismissals;
CREATE POLICY "Users can view own swap dismissals"
  ON public.reseller_swap_dismissals FOR SELECT
  TO authenticated
  USING (user_id = (select auth.uid()));

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00847') ON CONFLICT DO NOTHING;
