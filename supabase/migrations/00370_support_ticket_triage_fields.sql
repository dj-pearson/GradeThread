-- US-1595 / AGENTIC-OS Phase 1 (Module S): triage fields on support_tickets.
--
-- The Support Triage agent classifies each new/unassigned ticket (category +
-- severity + a suggested KB article). Those results live ON the ticket row so the
-- existing admin support UI renders them — NO parallel store (AGENTIC_OS.md §3.S).
-- Persisted only via the approval-gated triage_tickets write tool (an operator
-- signs off on the batch); nothing auto-writes these from the run loop.
--
-- Additive + idempotent. text + CHECK mirrors the existing status/priority
-- columns (00223) so the value set can evolve without ALTER TYPE. No RLS change:
-- support_tickets already restricts SELECT to the owner / admins and allows NO
-- client writes (service-role only), which is exactly what triage needs.

ALTER TABLE public.support_tickets
  -- Agent-assigned support category (distinct from `priority`, which stays the
  -- human-owned queue priority; severity is the agent's impact read).
  ADD COLUMN IF NOT EXISTS triage_category text
    CHECK (triage_category IS NULL OR triage_category IN
      ('billing', 'grading', 'technical', 'account', 'shipping', 'other')),
  ADD COLUMN IF NOT EXISTS triage_severity text
    CHECK (triage_severity IS NULL OR triage_severity IN
      ('low', 'normal', 'high', 'urgent')),
  -- Suggested KB article slug (references support_kb_articles.slug by value; not a
  -- FK so retiring an article never blocks triage). NULL when none fits.
  ADD COLUMN IF NOT EXISTS triage_kb_slug text,
  ADD COLUMN IF NOT EXISTS triaged_at timestamptz;

COMMENT ON COLUMN public.support_tickets.triage_category IS
  'US-1595: Support Triage agent classification; persisted via the approval-gated triage_tickets write tool. Distinct from priority (human-owned).';
COMMENT ON COLUMN public.support_tickets.triage_severity IS
  'US-1595: agent-read customer-impact severity (low/normal/high/urgent).';
COMMENT ON COLUMN public.support_tickets.triage_kb_slug IS
  'US-1595: suggested support_kb_articles.slug (by value, no FK); NULL when none fits.';

-- Surface freshly-triaged, still-open tickets in the queue quickly.
CREATE INDEX IF NOT EXISTS idx_support_tickets_triage
  ON public.support_tickets (triage_severity, last_message_at DESC)
  WHERE triage_severity IS NOT NULL AND status IN ('open', 'pending');

-- self-record (US-1108): keeps the edge schema-version guard (US-778) in sync
-- regardless of how this migration is applied.
INSERT INTO public.applied_migrations (version) VALUES ('00370') ON CONFLICT DO NOTHING;
