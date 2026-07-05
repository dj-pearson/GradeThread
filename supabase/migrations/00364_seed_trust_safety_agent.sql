-- US-1597 / AGENTIC-OS Phase 1 (Module T): seed the Trust & Safety agent row.
--
-- Triages abuse / moderation / fraud / passport-integrity queues by severity and
-- pattern, and summarizes cross-account rings. Account-level actions (suspend_
-- account, require_step_up, deny_claim) are HARD-CAPPED at L1 — a permanent
-- design decision enforced BOTH here (the autonomy config seeds them at L1) AND
-- in the policy engine (AUTONOMY_HARD_CAPS in agent-policy.ts clamps them to L1
-- regardless of any later promotion). Approving one files an admin task on the
-- fraud console; it never suspends anyone directly. Prompt lives in the repo
-- charter (agents/charters/trust-safety-agent.ts).
--
-- Seeded PAUSED (the operator enables it in Mission Control). The autonomy map
-- is NON-empty here to make the L1 account-action ceiling explicit; the code cap
-- is the backstop. Idempotent (ON CONFLICT (key) DO NOTHING). Depends on 00357.

INSERT INTO public.agents (key, name, description, module_letter, status, autonomy, config)
VALUES (
  'trust-safety',
  'Trust & Safety',
  'Severity + pattern triage of abuse/moderation/fraud/passport-integrity queues with cross-account ring detection. Account actions (suspend/step-up/claim-denial) are L1 proposals only — hard-capped, human-approved, routed to the fraud console.',
  'T',
  'paused',
  jsonb_build_object(
    'suspend_account', 1,
    'require_step_up', 1,
    'deny_claim', 1
  ),
  jsonb_build_object(
    'schedule', 'daily',
    'model', 'claude-sonnet-5',
    'tools', jsonb_build_array('get_trust_safety_health'),
    'budget_usd_daily', 2,
    'proposal_ttl_hours', 72,
    'max_steps', 8,
    'token_floor', 600
  )
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version guard
-- (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00364') ON CONFLICT DO NOTHING;
