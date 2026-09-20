-- 00812: revoke the anon and authenticated grants on the operator tables that
-- never had them removed (US-3355, batch C of three, 57 tables).
--
-- THE FULL REASONING IS IN vault/20-domain/service-role-tables.md,
-- which owns this contract and carries the eleven-group classification, the
-- prod OpenAPI measurement and the before/after numbers. Kept short here on
-- purpose: an applied migration is immutable, so knowledge in this header could
-- never be corrected (US-2059).
--
-- In one paragraph: RLS with zero policies is the only layer on these tables.
-- No row is readable today, but prod's PostgREST OpenAPI document, fetched with
-- the anon key that ships in the browser bundle, advertises 87 of the 88 and
-- publishes 941 of their column names. A revoke takes the schema back and
-- restores the second layer, so one future CREATE POLICY is no longer the whole
-- distance to world-readable.
--
-- NO REVOKE ON FUNCTION, no `revoke all on all tables in schema public`, no
-- ALTER DEFAULT PRIVILEGES, no GRANT, no policy. 00527 is the parked precedent
-- and only half its reasoning transfers; the note explains which half.
--
-- Effect on existing rows: NONE. REVOKE rewrites pg_class.relacl. It takes a
-- brief ACCESS EXCLUSIVE lock per table that queues behind a long-running
-- query, so apply off-peak.
--
-- Idempotent: revoking a privilege that is not held raises nothing. Literal
-- statements rather than a loop, because service-role-grant-posture_test.ts
-- replays every GRANT and REVOKE in the corpus and its regex cannot see a name
-- inside a format() placeholder -- a loop would leave all 94 reading as
-- never-revoked. Every one of the 94 tables is created at or below 00789, which
-- is applied, so none can be absent here.

-- Group 5
revoke all on table public.admin_notifications from anon, authenticated;
revoke all on table public.admin_saved_views from anon, authenticated;
revoke all on table public.admin_scope_grants from anon, authenticated;
revoke all on table public.admin_task_comments from anon, authenticated;
revoke all on table public.admin_task_projects from anon, authenticated;
revoke all on table public.admin_tasks from anon, authenticated;
revoke all on table public.bulk_admin_operations from anon, authenticated;
revoke all on table public.permission_scopes from anon, authenticated;
revoke all on table public.role_scopes from anon, authenticated;

-- Group 6
revoke all on table public.agent_handoffs from anon, authenticated;
revoke all on table public.agent_memory from anon, authenticated;
revoke all on table public.agent_proposals from anon, authenticated;
revoke all on table public.agent_run_steps from anon, authenticated;
revoke all on table public.agent_runs from anon, authenticated;
revoke all on table public.agents from anon, authenticated;

-- Group 7
revoke all on table public.ads_accounts from anon, authenticated;
revoke all on table public.ads_ad_groups from anon, authenticated;
revoke all on table public.ads_ads from anon, authenticated;
revoke all on table public.ads_campaigns from anon, authenticated;
revoke all on table public.ads_change_audit from anon, authenticated;
revoke all on table public.ads_keywords from anon, authenticated;
revoke all on table public.ads_metrics_daily from anon, authenticated;
revoke all on table public.ads_recommendations from anon, authenticated;
revoke all on table public.ads_search_terms from anon, authenticated;
revoke all on table public.ads_sync_runs from anon, authenticated;

-- Group 8
revoke all on table public.authenticity_references from anon, authenticated;
revoke all on table public.brand_colorways from anon, authenticated;
revoke all on table public.brand_knowledge from anon, authenticated;
revoke all on table public.brand_size_charts from anon, authenticated;
revoke all on table public.brand_style_codes from anon, authenticated;
revoke all on table public.brand_styles from anon, authenticated;
revoke all on table public.durability_aggregates from anon, authenticated;
revoke all on table public.garment_baselines from anon, authenticated;
revoke all on table public.garment_measurement_stats from anon, authenticated;
revoke all on table public.impact_factors from anon, authenticated;
revoke all on table public.registered_number_lookups from anon, authenticated;
revoke all on table public.registered_number_registry from anon, authenticated;
revoke all on table public.registered_number_sightings from anon, authenticated;
revoke all on table public.style_code_brand_candidates from anon, authenticated;
revoke all on table public.style_code_discovery_state from anon, authenticated;
revoke all on table public.style_code_names from anon, authenticated;
revoke all on table public.style_code_observations from anon, authenticated;
revoke all on table public.style_code_prospect_state from anon, authenticated;
revoke all on table public.style_code_sweeps from anon, authenticated;

-- Group 9
revoke all on table public.grade_flaws_only from anon, authenticated;
revoke all on table public.grade_report_revisions from anon, authenticated;
revoke all on table public.grading_reference_photos from anon, authenticated;

-- Group 10
revoke all on table public.pricing_plan_revisions from anon, authenticated;
revoke all on table public.quest_definitions from anon, authenticated;
revoke all on table public.reward_quests from anon, authenticated;

-- Group 11
revoke all on table public.help_article_views from anon, authenticated;

-- The six the census did not ask about
revoke all on table public.abuse_signals from anon, authenticated;
revoke all on table public.content_moderation_flags from anon, authenticated;
revoke all on table public.identification_provenance from anon, authenticated;
revoke all on table public.listing_publications from anon, authenticated;
revoke all on table public.rate_limit_overrides from anon, authenticated;
revoke all on table public.reward_budget_breaches from anon, authenticated;

-- Readback inside the file, because "applied" and "took effect" are different
-- claims and the second one is cheap here.
do $$
declare
  still int;
begin
  select count(*) into still
    from unnest(array[
      'admin_notifications',
      'admin_saved_views',
      'admin_scope_grants',
      'admin_task_comments',
      'admin_task_projects',
      'admin_tasks',
      'bulk_admin_operations',
      'permission_scopes',
      'role_scopes',
      'agent_handoffs',
      'agent_memory',
      'agent_proposals',
      'agent_run_steps',
      'agent_runs',
      'agents',
      'ads_accounts',
      'ads_ad_groups',
      'ads_ads',
      'ads_campaigns',
      'ads_change_audit',
      'ads_keywords',
      'ads_metrics_daily',
      'ads_recommendations',
      'ads_search_terms',
      'ads_sync_runs',
      'authenticity_references',
      'brand_colorways',
      'brand_knowledge',
      'brand_size_charts',
      'brand_style_codes',
      'brand_styles',
      'durability_aggregates',
      'garment_baselines',
      'garment_measurement_stats',
      'impact_factors',
      'registered_number_lookups',
      'registered_number_registry',
      'registered_number_sightings',
      'style_code_brand_candidates',
      'style_code_discovery_state',
      'style_code_names',
      'style_code_observations',
      'style_code_prospect_state',
      'style_code_sweeps',
      'grade_flaws_only',
      'grade_report_revisions',
      'grading_reference_photos',
      'pricing_plan_revisions',
      'quest_definitions',
      'reward_quests',
      'help_article_views',
      'abuse_signals',
      'content_moderation_flags',
      'identification_provenance',
      'listing_publications',
      'rate_limit_overrides',
      'reward_budget_breaches'
    ]) t
   where to_regclass('public.' || t) is not null
     and (has_table_privilege('anon', 'public.' || t, 'SELECT')
       or has_table_privilege('authenticated', 'public.' || t, 'SELECT'));
  if still > 0 then
    raise exception '[00812] % of 57 tables still grant SELECT to anon or authenticated', still;
  end if;
  raise notice '[00812] all 57 tables are closed to anon and authenticated';
end;
$$;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00812') on conflict do nothing;
