-- Listing templates (US-674) — reusable listing presets so power resellers don't
-- retype description boilerplate, item-specifics defaults, condition, and the
-- shipping/return/payment business policies on every listing. Owner-scoped (the
-- workspace owner owns the templates; members read them through the edge, which
-- uses the service-role client + explicit workspace scoping per CLAUDE.md US-268).
--
-- Selectable in the Publish composer (pre-fills the draft) and in AutoLister
-- (POST /batch?template_id applies the template to each generated draft).

CREATE TABLE public.listing_templates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name                text NOT NULL,
  -- Description boilerplate appended to the listing's body (AI/manual text wins
  -- the lead; the template adds the seller's standard footer/terms).
  description_template text,
  -- Default eBay condition enum (e.g. USED_EXCELLENT) + seller-facing narrative.
  ebay_condition       text,
  condition_description text,
  -- Item-specifics defaults: { aspectName: value }. Applied as the listing's
  -- item_specifics_override starting point.
  item_specifics       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ebay_category_id     text,
  -- eBay business policy ids (Business Policies API). Column names mirror
  -- listings.{return,shipping,payment}_policy_id (00052).
  return_policy_id     text,
  shipping_policy_id   text,
  payment_policy_id    text,
  -- The seller's go-to template, pre-selected in the composer. At most one per
  -- owner (enforced by the partial unique index below).
  is_default           boolean NOT NULL DEFAULT false,
  sort_order           integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- Names are unique per owner so the picker is unambiguous.
  UNIQUE (user_id, name)
);

CREATE INDEX idx_listing_templates_user_id
  ON public.listing_templates(user_id);

-- At most one default template per owner.
CREATE UNIQUE INDEX idx_listing_templates_one_default
  ON public.listing_templates(user_id)
  WHERE is_default;

CREATE TRIGGER set_listing_templates_updated_at
  BEFORE UPDATE ON public.listing_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.listing_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own listing templates"
  ON public.listing_templates FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create listing templates"
  ON public.listing_templates FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own listing templates"
  ON public.listing_templates FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own listing templates"
  ON public.listing_templates FOR DELETE USING (auth.uid() = user_id);

-- AutoLister batches remember which template (if any) was applied to their
-- generated drafts, for auditability + so a reclaim/resume re-applies it.
ALTER TABLE public.listing_generation_batches
  ADD COLUMN IF NOT EXISTS template_id uuid
    REFERENCES public.listing_templates(id) ON DELETE SET NULL;
