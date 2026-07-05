-- US-1595 / AGENTIC-OS Phase 1 (Module S): seed the Support Triage agent row.
--
-- The operator-side layer over the support inbox: classifies + prioritizes new
-- tickets, drafts approval-gated replies (draft_reply), persists classifications
-- (triage_tickets, onto the columns 00370 added), and flags issue clusters for
-- Sentinel correlation (file_task). It NEVER sends a reply or changes a ticket
-- itself — every mutation is an L1 proposal a human approves. Prompt lives in the
-- repo charter (agents/charters/support-triage-agent.ts).
--
-- Seeded PAUSED at L0 (autonomy '{}'); scheduled every 2h so support latency
-- drops without unsupervised sends. Idempotent (ON CONFLICT (key) DO NOTHING).
-- Depends on 00357 (the agents table) and 00370 (the triage columns).

INSERT INTO public.agents (key, name, description, module_letter, status, autonomy, config)
VALUES (
  'support-triage',
  'Support Triage',
  'Operator-side support inbox triage: classifies + prioritizes new tickets, drafts approval-gated replies, persists classifications onto the ticket, and flags issue clusters for Sentinel correlation. Never sends a reply or changes a ticket itself.',
  'S',
  'paused',
  '{}'::jsonb,
  jsonb_build_object(
    'schedule', '0 */2 * * *',
    'model', 'claude-sonnet-5',
    'tools', jsonb_build_array('get_support_triage'),
    'budget_usd_daily', 3,
    'proposal_ttl_hours', 48,
    'max_steps', 8,
    'token_floor', 600
  )
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00371') ON CONFLICT DO NOTHING;
