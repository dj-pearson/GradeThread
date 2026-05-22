-- FlipDesk saved views: named, pinnable filter queries per user.

CREATE TABLE public.flipdesk_saved_views (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  emoji       text,
  query_json  jsonb NOT NULL DEFAULT '{}'::jsonb,
  pinned      boolean NOT NULL DEFAULT false,
  scope       text NOT NULL DEFAULT 'items',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_flipdesk_saved_views_user_id
  ON public.flipdesk_saved_views(user_id);
CREATE INDEX idx_flipdesk_saved_views_pinned
  ON public.flipdesk_saved_views(user_id, pinned) WHERE pinned = true;

ALTER TABLE public.flipdesk_saved_views ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own saved views"
  ON public.flipdesk_saved_views FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "Users can create saved views"
  ON public.flipdesk_saved_views FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own saved views"
  ON public.flipdesk_saved_views FOR UPDATE
  USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own saved views"
  ON public.flipdesk_saved_views FOR DELETE
  USING (auth.uid() = user_id);
