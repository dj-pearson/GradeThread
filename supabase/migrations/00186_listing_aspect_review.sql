-- US-828: AutoLister aspect reconciliation at generation time.
--
-- After category resolution the generation pipeline now validates every
-- AI-generated item-specific NAME and VALUE against the cached eBay category
-- spec, normalizes SELECTION_ONLY near-misses through the US-823 normalizer, and
-- keeps anything still unmatched VISIBLY as needs-review on the draft instead of
-- letting it silently drop at publish.
--
-- That needs-review list is stored here as a jsonb array on the listing draft:
--   [ { "aspect": "Material", "values": ["Hemp"], "reason": "unmatched_value" }, … ]
-- where reason ∈ ('unmatched_value','unknown_aspect'). It sits ALONGSIDE the
-- existing item_specifics_override value map (which still carries the kept
-- values) and the boolean needs_review flag — additive and back-compatible, so
-- existing rows need no backfill (NULL = "no aspects flagged"). The web drafts
-- cockpit shows a count badge from it and the composer highlights the matching
-- aspect rows; iOS reads the same column.

ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS aspect_review jsonb;

COMMENT ON COLUMN listings.aspect_review IS
  'US-828: per-aspect needs-review list from generation-time reconciliation — [{aspect, values[], reason: unmatched_value|unknown_aspect}]. NULL = nothing flagged.';
