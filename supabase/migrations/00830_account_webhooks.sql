-- Customer webhooks: one endpoint per account, a signing secret the customer can
-- actually hold, and a durable delivery outbox (extensions-api plan, actions 2+3).
--
-- Before this, webhook_url lived on every api_keys row, so a customer with three
-- keys got three copies of each grade.completed, each signed with a different
-- key_hash. In prod key_hash is HMAC(API_KEY_PEPPER, key), which no customer can
-- compute, so no delivery was verifiable. Retries were in-process sleeps and died
-- with every edge restart, and nothing recorded what was sent.
--
--   api_webhook_endpoints      one row per account (PK user_id): url + the
--                              whsec_ secret as an AES-GCM envelope (AAD =
--                              user_id). NULL secret = a legacy URL copied from
--                              api_keys below; the owner mints one by rotating.
--   webhook_deliveries         the outbox. UNIQUE (user_id, event_type,
--                              subject_id) is what makes "one delivery per
--                              grade" a database fact rather than a code habit.
--                              The retry cron claims due rows by compare-and-set.
--   webhook_delivery_attempts  one row per HTTP attempt, for support and the
--                              customer's delivery log.
--
-- All three are deny-all (RLS on, no policy, revoked from anon/authenticated) and
-- registered in SERVICE_ROLE_ONLY in rls-guard_test.ts. Every edge read and write
-- is scoped by user_id (US-268). api_keys.webhook_url is kept and still written,
-- so a rolled-back edge keeps working; nothing new reads it.
--
-- Idempotent: IF NOT EXISTS everywhere, constraints dropped before re-adding,
-- and the backfill is ON CONFLICT DO NOTHING.

CREATE TABLE IF NOT EXISTS public.api_webhook_endpoints (
  user_id           uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  url               text NOT NULL,
  secret_ciphertext text,
  secret_created_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  event_id         uuid NOT NULL DEFAULT gen_random_uuid(),
  event_type       text NOT NULL,
  subject_id       text NOT NULL,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending',
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 6,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_attempt_at  timestamptz,
  last_status_code integer,
  last_error       text,
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.webhook_deliveries
  DROP CONSTRAINT IF EXISTS webhook_deliveries_status_check;
ALTER TABLE public.webhook_deliveries
  ADD CONSTRAINT webhook_deliveries_status_check
  CHECK (status IN ('pending', 'running', 'delivered', 'failed', 'cancelled'));

CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_event_id_key
  ON public.webhook_deliveries (event_id);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_once_per_account
  ON public.webhook_deliveries (user_id, event_type, subject_id);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx
  ON public.webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS webhook_deliveries_running_idx
  ON public.webhook_deliveries (updated_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS webhook_deliveries_owner_recent_idx
  ON public.webhook_deliveries (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.webhook_delivery_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id      uuid NOT NULL REFERENCES public.webhook_deliveries(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  attempt          integer NOT NULL,
  success          boolean NOT NULL,
  status_code      integer,
  error            text,
  response_excerpt text,
  duration_ms      integer,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_delivery_attempts_delivery_idx
  ON public.webhook_delivery_attempts (delivery_id, attempt);

DROP TRIGGER IF EXISTS set_updated_at_api_webhook_endpoints ON public.api_webhook_endpoints;
CREATE TRIGGER set_updated_at_api_webhook_endpoints
  BEFORE UPDATE ON public.api_webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at_webhook_deliveries ON public.webhook_deliveries;
CREATE TRIGGER set_updated_at_webhook_deliveries
  BEFORE UPDATE ON public.webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.api_webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_delivery_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.api_webhook_endpoints FROM anon, authenticated;
REVOKE ALL ON TABLE public.webhook_deliveries FROM anon, authenticated;
REVOKE ALL ON TABLE public.webhook_delivery_attempts FROM anon, authenticated;

-- Carry existing URLs across: the most recently created key that had one wins.
-- No secret yet; deliveries to these keep the legacy X-GradeThread-Signature
-- until the owner rotates and receives a whsec_ secret.
INSERT INTO public.api_webhook_endpoints (user_id, url)
SELECT DISTINCT ON (k.user_id) k.user_id, k.webhook_url
FROM public.api_keys k
WHERE k.webhook_url IS NOT NULL AND length(trim(k.webhook_url)) > 0
ORDER BY k.user_id, k.created_at DESC
ON CONFLICT (user_id) DO NOTHING;

insert into public.applied_migrations (version) values ('00830') on conflict do nothing;
