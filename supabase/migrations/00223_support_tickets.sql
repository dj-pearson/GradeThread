-- US-900: lightweight in-app support ticket inbox.
--
-- A user opens a request ("Contact support"); admins triage, reply, add private
-- internal notes, and resolve. Support now lives in the platform, tied to the
-- user record, instead of a separate email tool. This is DISTINCT from the AI
-- Support Assistant transcript store (support_conversations / support_messages,
-- 00181) — that captures bot chats with human-handoff; this is a classic
-- user-opened ticket queue. Because support_messages is already taken by the
-- assistant transcript, the ticket replies live in support_ticket_messages.
--
-- SECURITY MODEL (mirrors support_conversations 00181):
--   * RLS is enabled on both tables. A user SELECTs only their OWN tickets
--     (auth.uid() = user_id) and only the NON-internal messages within them.
--   * Internal notes (is_internal_note = true) are NEVER returned to a user:
--     the user-side message SELECT policy carries `is_internal_note = false`, so
--     an operator's private notes are non-selectable by the ticket owner even
--     though they live in the same table.
--   * There is NO client INSERT/UPDATE/DELETE policy on either table. Every
--     write is performed by the service-role edge client (which bypasses RLS):
--     users create/reply via /api/support-tickets, admins manage the queue via
--     /api/admin/support-tickets. Clients never write these tables directly.
--   * Admins may read everything for the triage queue (still service-role on the
--     server; the admin SELECT policy is belt-and-suspenders).
--
-- Enums are modeled as text + CHECK (the dominant recent pattern) so the value
-- set can evolve without ALTER TYPE gymnastics. Idempotent via IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The end user who opened the ticket. CASCADE so deleting the auth user takes
  -- their tickets (and, via the messages FK, their thread) with them.
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subject           text NOT NULL,
  status            text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
  priority          text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  -- The admin who owns the ticket; null until assigned. SET NULL so removing an
  -- admin account doesn't delete the user's ticket.
  assigned_admin_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  last_message_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.support_ticket_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id        uuid NOT NULL
    REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  -- Who wrote the message — the ticket owner or a support admin. SET NULL keeps
  -- the transcript intact if that account is later deleted (an admin-authored
  -- reply must survive the admin's removal). The owner's own messages cascade
  -- away with the ticket when the user is deleted.
  author_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  body             text NOT NULL,
  -- An operator-only private note: visible to admins, NEVER to the ticket owner
  -- (enforced by the user-side SELECT policy below).
  is_internal_note boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- The owner's ticket list (most-recent first) and the admin queue scans.
CREATE INDEX IF NOT EXISTS idx_support_tickets_user
  ON public.support_tickets(user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status
  ON public.support_tickets(status, last_message_at DESC)
  WHERE status IN ('open', 'pending');
CREATE INDEX IF NOT EXISTS idx_support_tickets_assignee
  ON public.support_tickets(assigned_admin_id, last_message_at DESC)
  WHERE assigned_admin_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_ticket
  ON public.support_ticket_messages(ticket_id, created_at);

-- updated_at maintained by the standard trigger (00001).
DROP TRIGGER IF EXISTS set_support_tickets_updated_at
  ON public.support_tickets;
CREATE TRIGGER set_support_tickets_updated_at
  BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_ticket_messages ENABLE ROW LEVEL SECURITY;

-- Users read only their own tickets. No INSERT/UPDATE/DELETE policy: every
-- write is service-role only (the edge owns ticket state + transcript integrity).
CREATE POLICY "Users read own support tickets"
  ON public.support_tickets FOR SELECT
  USING (auth.uid() = user_id);

-- Admins read all tickets for the triage queue (US-900).
CREATE POLICY "Admins read all support tickets"
  ON public.support_tickets FOR SELECT
  USING (public.is_admin());

-- Users read messages only within a ticket they own, and NEVER an internal
-- note (the operator's private notes are non-selectable by the ticket owner).
CREATE POLICY "Users read own ticket messages"
  ON public.support_ticket_messages FOR SELECT
  USING (
    is_internal_note = false
    AND EXISTS (
      SELECT 1 FROM public.support_tickets t
      WHERE t.id = support_ticket_messages.ticket_id
        AND t.user_id = auth.uid()
    )
  );

-- Admins read every message, including internal notes, for the queue.
CREATE POLICY "Admins read all ticket messages"
  ON public.support_ticket_messages FOR SELECT
  USING (public.is_admin());
