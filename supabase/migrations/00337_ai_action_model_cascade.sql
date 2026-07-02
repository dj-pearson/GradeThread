-- US-1065 follow-up: quality-gated model cascade for FlipDesk AI ACTIONS.
--
-- Seeds the `ai_action_model_cascade` config into the system_settings registry
-- (00208) so the cascade can be tuned or turned OFF without a deploy. The
-- AutoLister listing generator (lib/ai-listing.ts) runs a cheap first pass
-- (firstPassModel = Haiku) and re-runs ("revises") on the stronger escalationModel
-- (Sonnet 5) ONLY when the first pass is low-confidence (< confidenceThreshold),
-- missing a category, has no item-specifics, or errors.
--
-- Shipped DISABLED (enabled:false) so listing quality is unchanged until an
-- operator flips enabled=true after spot-checking Haiku output. Unlike grading
-- there is no model allowlist — any Coolify-configured model id is accepted; a
-- non-string / cleared model falls back in code (lib/ai-action-cascade.ts) to the
-- env-derived LIGHTWEIGHT_AI_MODEL / DEFAULT_AI_MODEL, so if you re-point those
-- vars, either clear the model fields here or update them to match.

insert into public.system_settings (key, value, value_type, default_value, category, description)
values
  (
    'ai_action_model_cascade',
    '{"enabled": false, "firstPassModel": "claude-haiku-4-5-20251001", "escalationModel": "claude-sonnet-5", "confidenceThreshold": 0.7}'::jsonb,
    'json',
    '{"enabled": false, "firstPassModel": "claude-haiku-4-5-20251001", "escalationModel": "claude-sonnet-5", "confidenceThreshold": 0.7}'::jsonb,
    'ai',
    'US-1065: quality-gated Haiku->Sonnet cascade for AI actions (AutoLister listing gen). enabled=run the cheap firstPassModel and re-run on escalationModel when the first pass is low-confidence (< confidenceThreshold), missing a category, has no item-specifics, or errors. No allowlist; a cleared model falls back to LIGHTWEIGHT_AI_MODEL / DEFAULT_AI_MODEL.'
  )
on conflict (key) do nothing;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00337') on conflict do nothing;
