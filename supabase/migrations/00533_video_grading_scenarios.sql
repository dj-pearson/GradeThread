-- US-1765: model video grading in the AI usage scenarios.
--
-- 00532 added video_grading to `ai_feature_economics`, so the admin
-- profitability report already breaks it out in the OBSERVED per-feature table.
-- The projection half reads a different setting — `ai_usage_scenarios` — and
-- projects only the features a scenario lists volumes for. video_grading was in
-- none of them, so every modeled scenario projected the platform's spend as if
-- no seller ever graded from a clip.
--
-- The modeled share is 15% of grades, and it is taken OUT of the photo grading
-- volume rather than added on top: a seller grading from a clip would otherwise
-- have graded from photos, so the grade count and the revenue are unchanged and
-- only the cost mix moves. Modeling it as additive would have projected extra
-- spend against revenue that does not exist, which overstates the very ratio
-- the report is consulted for.
--
-- Idempotent: a scenario that already carries a video_grading volume is left
-- alone, so re-running never re-shifts the split.

UPDATE public.system_settings
SET value = coalesce(
  (
    SELECT jsonb_agg(
             CASE
               WHEN (elem -> 'volumes') ? 'grading'
                AND NOT ((elem -> 'volumes') ? 'video_grading')
               THEN jsonb_set(
                      jsonb_set(
                        elem,
                        '{volumes,video_grading}',
                        to_jsonb(
                          greatest(
                            1,
                            round(((elem -> 'volumes' ->> 'grading')::numeric) * 0.15)::int
                          )
                        ),
                        true
                      ),
                      '{volumes,grading}',
                      to_jsonb(
                        greatest(
                          0,
                          ((elem -> 'volumes' ->> 'grading')::numeric)::int
                            - greatest(
                                1,
                                round(((elem -> 'volumes' ->> 'grading')::numeric) * 0.15)::int
                              )
                        )
                      ),
                      true
                    )
               ELSE elem
             END
             ORDER BY ord
           )
    FROM jsonb_array_elements(value) WITH ORDINALITY AS t(elem, ord)
  ),
  value
)
WHERE key = 'ai_usage_scenarios'
  AND jsonb_typeof(value) = 'array';

-- default_value for this setting is seeded as '[]' (00240), so "reset to
-- default" produces an empty scenario list with no grading volumes either.
-- There is nothing to patch there and patching it would invent a default the
-- operator never configured.

-- Belt-and-braces: 00532 adds the video_grading economics entry, but it is
-- guarded on the row not already having the key. If an operator had hand-edited
-- `ai_feature_economics` between the two migrations, the scenarios above would
-- reference a feature with no configured revenue basis and the projection would
-- price it at zero. Ensure the entry exists rather than assume the order held.
UPDATE public.system_settings
SET value = jsonb_set(
  value,
  '{video_grading}',
  jsonb_build_object(
    'label', 'Video grading',
    'action_unit', 'submission',
    'revenue_basis', 'per_action',
    'revenue_per_action_usd', 2.99,
    'subscription_ref_usd', 0,
    'current_model', 'claude-sonnet-4-6',
    'recommended_model', 'claude-sonnet-4-6',
    'quality_note', 'Same vision work as a photo grade, over frames the server '
      'chose — so the only cost lever is the frame count '
      '(video_grading_max_frames, clamped 4..8 in code).',
    'fallback_cost_per_action_usd', 0.05
  ),
  true
)
WHERE key = 'ai_feature_economics'
  AND jsonb_typeof(value) = 'object'
  AND NOT (value ? 'video_grading');

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00533')
ON CONFLICT (version) DO NOTHING;
