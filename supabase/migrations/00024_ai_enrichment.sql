-- AI item-enrichment foundation: per-field provenance of AI suggestions,
-- per-user AI usage accounting, and a full log of extraction calls.
-- Data foundation for US-159 through US-167.

ALTER TABLE public.inventory_items
  ADD COLUMN ai_field_sources jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN ai_enriched_at timestamptz;

ALTER TABLE public.users
  ADD COLUMN ai_actions_used_this_month int NOT NULL DEFAULT 0,
  ADD COLUMN ai_actions_reset_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN ai_enrichment_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE public.ai_enrichment_log (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  inventory_item_id  uuid REFERENCES public.inventory_items(id) ON DELETE SET NULL,
  model              text NOT NULL,
  input_kind         text NOT NULL CHECK (input_kind IN ('text', 'photo', 'both')),
  tokens_in          int NOT NULL DEFAULT 0,
  tokens_out         int NOT NULL DEFAULT 0,
  cost_usd           numeric(10,5) NOT NULL DEFAULT 0,
  latency_ms         int NOT NULL DEFAULT 0,
  suggested_fields   jsonb NOT NULL DEFAULT '{}'::jsonb,
  accepted_fields    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_enrichment_log_user
  ON public.ai_enrichment_log (user_id, created_at DESC);
CREATE INDEX idx_ai_enrichment_log_item
  ON public.ai_enrichment_log (inventory_item_id);

ALTER TABLE public.ai_enrichment_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read their own AI enrichment logs"
  ON public.ai_enrichment_log FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users insert their own AI enrichment logs"
  ON public.ai_enrichment_log FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users update their own AI enrichment logs"
  ON public.ai_enrichment_log FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Resets the monthly counter when ai_actions_reset_at falls in a prior
-- calendar month, then increments. Mirrors increment_grades_used (00004).
CREATE OR REPLACE FUNCTION public.increment_ai_actions(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.users
  SET
    ai_actions_used_this_month = CASE
      WHEN date_trunc('month', ai_actions_reset_at) < date_trunc('month', now())
        THEN 1
      ELSE ai_actions_used_this_month + 1
    END,
    ai_actions_reset_at = CASE
      WHEN date_trunc('month', ai_actions_reset_at) < date_trunc('month', now())
        THEN now()
      ELSE ai_actions_reset_at
    END,
    updated_at = now()
  WHERE id = p_user_id;
END;
$$;
