-- US-829: persistent store for the AI Support Assistant (EPIC: AI Support
-- Assistant). Every tier-1 chat is auditable, resumable, and hand-offable to a
-- human. Two tables:
--
--   support_conversations — one row per chat thread, with the escalation
--   lifecycle (open → awaiting_user → escalated → resolved → closed).
--   support_messages       — the transcript: user / assistant / human_agent /
--   system turns, plus token accounting and abuse flags.
--
-- SECURITY MODEL (mirrors notifications 00007 + feedback_messages 000385):
--   * RLS is enabled on both tables. A user may SELECT only their own
--     conversations (own row OR they are the workspace owner) and only the
--     messages within those conversations.
--   * There is NO client INSERT/UPDATE/DELETE policy on either table. Every
--     write is performed by the service-role edge client (which bypasses RLS)
--     so transcript integrity can never be tampered with from the SPA — clients
--     never insert messages directly.
--   * system-role messages are NEVER returned to a client: both SELECT policies
--     carry `role <> 'system'`, so the system prompt / out-of-band context is
--     non-selectable even though the column can store it for audit. (The engine
--     keeps the live system prompt out of band; this is belt-and-suspenders.)
--   * Admins may read everything for the support inbox (US-839), still subject
--     to the system-row exclusion.
--
-- Enums are modeled as text + CHECK (the dominant recent pattern, e.g.
-- feedback_messages.status) so the value set can evolve without ALTER TYPE
-- gymnastics. Idempotent via IF NOT EXISTS so a re-run on a partial apply is a
-- no-op.

CREATE TABLE IF NOT EXISTS public.support_conversations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The end user who owns the chat. CASCADE so deleting the auth user takes
  -- their transcripts with them.
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The workspace this conversation is keyed to. For a solo seller this equals
  -- user_id; for a workspace member it is the owner's id, so the owner can see
  -- (and a handed-off human can route) chats opened by their members. Nullable
  -- only to tolerate legacy rows; the edge always populates it.
  workspace_owner_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  status             text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'awaiting_user', 'escalated', 'resolved', 'closed')),
  subject            text,
  -- Why the bot (or a threshold) escalated to a human; null until escalated.
  escalation_reason  text,
  -- The admin who picked up the escalation; null until assigned.
  assigned_admin_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  last_message_at    timestamptz NOT NULL DEFAULT now(),
  escalated_at       timestamptz,
  resolved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.support_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL
    REFERENCES public.support_conversations(id) ON DELETE CASCADE,
  role            text NOT NULL
    CHECK (role IN ('user', 'assistant', 'human_agent', 'system')),
  content         text NOT NULL,
  -- Anthropic tool-use blocks for an assistant turn (the streaming tool-use
  -- loop, US-834); null for plain text turns.
  tool_calls      jsonb,
  -- The model id that produced an assistant turn; null for user/human/system.
  model           text,
  input_tokens    integer NOT NULL DEFAULT 0,
  output_tokens   integer NOT NULL DEFAULT 0,
  -- Abuse detection (US-836) marks a turn and records why.
  flagged         boolean NOT NULL DEFAULT false,
  flag_reason     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Indexed by user_id / conversation_id per the story.
CREATE INDEX IF NOT EXISTS idx_support_conversations_user
  ON public.support_conversations(user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_conversations_owner
  ON public.support_conversations(workspace_owner_id, last_message_at DESC);
-- Open + escalated threads are what the admin inbox scans most.
CREATE INDEX IF NOT EXISTS idx_support_conversations_status
  ON public.support_conversations(status)
  WHERE status IN ('open', 'awaiting_user', 'escalated');
CREATE INDEX IF NOT EXISTS idx_support_messages_conversation
  ON public.support_messages(conversation_id, created_at);

-- updated_at maintained by the standard trigger (00001).
DROP TRIGGER IF EXISTS set_support_conversations_updated_at
  ON public.support_conversations;
CREATE TRIGGER set_support_conversations_updated_at
  BEFORE UPDATE ON public.support_conversations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE public.support_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

-- Users read only their own conversations (own row or as the workspace owner).
-- No INSERT/UPDATE/DELETE policy: writes are service-role only.
CREATE POLICY "Users read own support conversations"
  ON public.support_conversations FOR SELECT
  USING (auth.uid() = user_id OR auth.uid() = workspace_owner_id);

-- Admins read all conversations for the escalation inbox (US-839).
CREATE POLICY "Admins read all support conversations"
  ON public.support_conversations FOR SELECT
  USING (public.is_admin());

-- Users read messages only within a conversation they own, and NEVER a
-- system-role row (the system prompt is non-selectable).
CREATE POLICY "Users read own support messages"
  ON public.support_messages FOR SELECT
  USING (
    role <> 'system'
    AND EXISTS (
      SELECT 1 FROM public.support_conversations c
      WHERE c.id = support_messages.conversation_id
        AND (c.user_id = auth.uid() OR c.workspace_owner_id = auth.uid())
    )
  );

-- Admins read transcript messages for the inbox, still excluding system rows.
CREATE POLICY "Admins read support messages"
  ON public.support_messages FOR SELECT
  USING (role <> 'system' AND public.is_admin());
