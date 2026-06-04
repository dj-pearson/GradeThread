-- US-537: AI photo-QA readiness score per item. An on-device-free vision pass
-- scores an item's listing photos 0-100 and records specific issues (blurry,
-- dark, tag unreadable, missing angle, …) so the AutoLister queue can nudge the
-- seller to reshoot BEFORE publishing. Persisted on the item so the score
-- survives reloads and is read by the queue without re-running the model.

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS photo_qa_score smallint,
  ADD COLUMN IF NOT EXISTS photo_qa_issues jsonb,
  ADD COLUMN IF NOT EXISTS photo_qa_at timestamptz;

COMMENT ON COLUMN public.inventory_items.photo_qa_score IS
  'US-537: 0-100 listing-readiness score for the item''s photos; null until assessed.';
COMMENT ON COLUMN public.inventory_items.photo_qa_issues IS
  'US-537: array of { type, severity, message, photo_index? } issues the vision pass found.';
COMMENT ON COLUMN public.inventory_items.photo_qa_at IS
  'US-537: when the photo-QA pass last ran for this item.';
