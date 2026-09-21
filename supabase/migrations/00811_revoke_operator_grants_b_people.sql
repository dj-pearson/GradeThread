-- 00811: revoke the anon and authenticated grants on the operator tables that
-- never had them removed (US-3355, batch B of three, 25 tables).
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

-- Group 3
revoke all on table public.affiliate_tax_profiles from anon, authenticated;
revoke all on table public.ai_usage_events from anon, authenticated;
revoke all on table public.appstore_processed_transactions from anon, authenticated;
revoke all on table public.billing_reconciliation_flags from anon, authenticated;
revoke all on table public.email_consent_audit from anon, authenticated;
revoke all on table public.flipdesk_subscription_events from anon, authenticated;
revoke all on table public.google_processed_purchases from anon, authenticated;
revoke all on table public.guarantee_claims from anon, authenticated;
revoke all on table public.guarantee_remedies from anon, authenticated;
revoke all on table public.measure_card_requests from anon, authenticated;
revoke all on table public.pending_refunds from anon, authenticated;
revoke all on table public.subscription_agreements from anon, authenticated;
revoke all on table public.subscription_cancellations from anon, authenticated;
revoke all on table public.support_abuse_events from anon, authenticated;

-- Group 4
revoke all on table public.ad_click_attributions from anon, authenticated;
revoke all on table public.api_idempotency_records from anon, authenticated;
revoke all on table public.badge_click_events from anon, authenticated;
revoke all on table public.ebay_pending_webhook_events from anon, authenticated;
revoke all on table public.flipdesk_sync_conflicts from anon, authenticated;
revoke all on table public.google_sheet_sync_state from anon, authenticated;
revoke all on table public.help_deflections from anon, authenticated;
revoke all on table public.help_feedback from anon, authenticated;
revoke all on table public.mcp_tool_calls from anon, authenticated;
revoke all on table public.measure_corrections from anon, authenticated;
revoke all on table public.support_assistant_usage from anon, authenticated;

-- Readback inside the file, because "applied" and "took effect" are different
-- claims and the second one is cheap here.
do $$
declare
  still int;
begin
  select count(*) into still
    from unnest(array[
      'affiliate_tax_profiles',
      'ai_usage_events',
      'appstore_processed_transactions',
      'billing_reconciliation_flags',
      'email_consent_audit',
      'flipdesk_subscription_events',
      'google_processed_purchases',
      'guarantee_claims',
      'guarantee_remedies',
      'measure_card_requests',
      'pending_refunds',
      'subscription_agreements',
      'subscription_cancellations',
      'support_abuse_events',
      'ad_click_attributions',
      'api_idempotency_records',
      'badge_click_events',
      'ebay_pending_webhook_events',
      'flipdesk_sync_conflicts',
      'google_sheet_sync_state',
      'help_deflections',
      'help_feedback',
      'mcp_tool_calls',
      'measure_corrections',
      'support_assistant_usage'
    ]) t
   where to_regclass('public.' || t) is not null
     and (has_table_privilege('anon', 'public.' || t, 'SELECT')
       or has_table_privilege('authenticated', 'public.' || t, 'SELECT'));
  if still > 0 then
    raise exception '[00811] % of 25 tables still grant SELECT to anon or authenticated', still;
  end if;
  raise notice '[00811] all 25 tables are closed to anon and authenticated';
end;
$$;

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00811') on conflict do nothing;
