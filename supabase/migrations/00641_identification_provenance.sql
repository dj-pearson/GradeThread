-- US-2774: where the identification decisions go.
--
-- Two things were already computed correctly on every run and then discarded:
-- how the eBay category was chosen (decideCategory returns method, support and
-- rejectedReason; flipdesk-ai.ts console.logged them) and what the model ruled
-- on each visual candidate (decodeExtraction returns visualRulings; only the
-- accepted half acted on anything). Without a place to write them, "the
-- category was wrong" is unactionable and the visual provider's accuracy is
-- assumed rather than measured.
--
-- Why a new table. inventory_items.attributes is the canonical garment
-- attribute map (00182) and a decision key inside it would read as a garment
-- attribute to everything that iterates it. ai_enrichment_log.suggested_fields
-- is keyed by FIELD NAME for the same reason. Both were considered and
-- rejected.
--
-- OFFERED AND RULED ARE SEPARATE COLUMNS ON PURPOSE. A candidate the model
-- rejected and a candidate that was never offered look identical if only the
-- rulings are kept, and only one of them means the visual provider is wrong -
-- which is the entire measurement this table exists for. So: empty
-- visual_candidates means nothing was put to the model; a candidate present
-- there with no matching ruling means the model ignored it; a ruling with
-- verdict 'rejected' means it was refused on evidence. Three different
-- findings, three different fixes.
--
-- Operator table: deny-all RLS, service-role writes only, registered in
-- SERVICE_ROLE_ONLY (rls-guard_test.ts). Sellers never read it; it holds the
-- AI's working-out, not their data.

CREATE TABLE IF NOT EXISTS public.identification_provenance (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  inventory_item_id  uuid REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  enrichment_log_id  uuid REFERENCES public.ai_enrichment_log(id) ON DELETE SET NULL,
  category_method    text CHECK (category_method IN
                       ('saved', 'visual_consensus', 'keyword', 'none')),
  category_id        text,
  category_name      text,
  category_support   int NOT NULL DEFAULT 0,
  category_rejected_reason text CHECK (category_rejected_reason IN
                       ('no_votes', 'tied', 'below_min_support', 'not_a_leaf')),
  category_decided_at timestamptz,
  visual_candidates  jsonb NOT NULL DEFAULT '[]'::jsonb,
  visual_rulings     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- "Why did THIS item get that category" — the trace query, newest run first.
CREATE INDEX IF NOT EXISTS idx_ident_provenance_item
  ON public.identification_provenance (inventory_item_id, created_at DESC);

-- "How often does each method decide, and how often does a vote lose" — the
-- measurement query. Partial, because a row whose category half never ran
-- (the eBay prep phase is fire-and-forget and does not always execute) is not
-- part of that population and should not be scanned by it.
CREATE INDEX IF NOT EXISTS idx_ident_provenance_method
  ON public.identification_provenance (category_method, created_at DESC)
  WHERE category_method IS NOT NULL;

ALTER TABLE public.identification_provenance ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON public.identification_provenance
  FROM anon, authenticated;

insert into public.applied_migrations (version) values ('00641') on conflict do nothing;
