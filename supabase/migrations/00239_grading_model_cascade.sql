-- US-1066: confidence-gated model routing (cheaper-model cascade) for grading.
--
-- Seeds the `grading_model_cascade` config into the system_settings registry
-- (00208) so the cascade can be tuned or turned OFF without a deploy. Grading
-- runs a cheap first pass (firstPassModel) and escalates to a stronger model
-- (escalationModel) only when the first-pass confidence is below
-- confidenceThreshold, or the linked item's value (USD) is at least highValueUsd.
--
-- Shipped DISABLED (enabled:false) so grading behavior is unchanged until an
-- operator BOTH qualifies the cheap first-pass model against the eval gate
-- (runEval with a modelOverride) AND flips enabled to true. Both models are
-- re-validated against the grading allowlist in code (lib/model-routing.ts), so
-- an unvetted model here can never silently grade traffic.

insert into public.system_settings (key, value, value_type, default_value, category, description)
values
  (
    'grading_model_cascade',
    '{"enabled": false, "firstPassModel": "claude-haiku-4-5-20251001", "escalationModel": "claude-sonnet-4-6", "confidenceThreshold": 0.75, "highValueUsd": null}'::jsonb,
    'json',
    '{"enabled": false, "firstPassModel": "claude-haiku-4-5-20251001", "escalationModel": "claude-sonnet-4-6", "confidenceThreshold": 0.75, "highValueUsd": null}'::jsonb,
    'grading',
    'US-1066: confidence-gated model cascade. enabled=run the cheap firstPassModel and escalate to escalationModel when first-pass confidence < confidenceThreshold or the item value (USD) >= highValueUsd (null disables value-based escalation). Both models must be on the grading allowlist.'
  )
on conflict (key) do nothing;
