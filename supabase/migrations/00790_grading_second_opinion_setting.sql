-- 00790: seed the switch for the grading second opinion (US-2279 / US-3359).
--
-- The second-opinion pass reads system_settings.grading_second_opinion, and
-- admin-settings.ts answers PUT /:key with 404 when no row exists, so for
-- three weeks the feature had a config resolver, a model tier and a pipeline
-- hook and no way to be turned on. A feature switch with no seed row is a
-- feature with no switch.
--
-- DISABLED on purpose: applying a migration must never start paying for a
-- second model pass. Every field mirrors DEFAULT_SECOND_OPINION_CONFIG in
-- services/edge-functions/src/lib/second-opinion.ts, and second-opinion_test.ts
-- byte-checks the values below against it, so the seed and the code default
-- cannot drift apart. ON CONFLICT DO NOTHING keeps any hand-seeded row,
-- including one an operator already turned on.

insert into public.system_settings (key, value, value_type, default_value, category, description)
values (
  'grading_second_opinion',
  jsonb_build_object(
    'enabled',      false,
    'bandMin',      0.75,
    'bandMax',      0.85,
    'highValueMin', null,
    'epsilon',      0.5,
    'model',        'claude-opus-4-8',
    'maxPerHour',   null
  ),
  'json',
  jsonb_build_object(
    'enabled',      false,
    'bandMin',      0.75,
    'bandMax',      0.85,
    'highValueMin', null,
    'epsilon',      0.5,
    'model',        'claude-opus-4-8',
    'maxPerHour',   null
  ),
  'grading',
  'US-2279: re-run the composite stage under a second model on borderline grades (confidence inside [bandMin, bandMax], or list price at or above highValueMin) and route a disagreement wider than epsilon to human review. OFF until an operator turns it on; maxPerHour caps spend, null means uncapped.'
)
on conflict (key) do nothing;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00790') on conflict do nothing;
