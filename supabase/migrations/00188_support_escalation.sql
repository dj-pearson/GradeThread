-- US-837: human escalation lifecycle for the AI Support Assistant.
--
-- When the bot can't help (low confidence, out-of-scope, the user asks for a
-- person, or repeated answer attempts fail) it hands off to a human. The
-- conversation flips to status='escalated' (already modeled in 00181); this
-- migration adds the supporting columns the handoff needs:
--
--   * escalation_summary — an AI-written (or, for an auto-escalation, a
--     synthesized) summary of what the user needs, shown to the human agent in
--     the admin inbox (US-839) alongside the existing escalation_reason.
--   * escalation_trigger — HOW the escalation fired: the model called the
--     escalate tool ('model'), an unresolved-turn threshold tripped ('auto'),
--     or a human-side action ('user', reserved for US-839).
--   * unresolved_turns — a rolling counter of consecutive turns the assistant
--     could not confidently resolve. The engine increments it on an unresolved
--     turn and resets it on a resolved one; reaching the threshold AUTO-escalates
--     even when the model itself never called the escalate tool.
--
-- SECURITY/RLS unchanged: support_conversations RLS (00181) still applies; these
-- columns are written ONLY by the service-role edge client. Idempotent via
-- IF NOT EXISTS so a re-run on a partial apply is a no-op.

ALTER TABLE public.support_conversations
  ADD COLUMN IF NOT EXISTS escalation_summary text,
  ADD COLUMN IF NOT EXISTS escalation_trigger text
    CHECK (escalation_trigger IN ('model', 'auto', 'user')),
  ADD COLUMN IF NOT EXISTS unresolved_turns integer NOT NULL DEFAULT 0;
