-- US-1579: MeasureCard distribution — the mailed-card fulfillment queue and
-- the profile-side card-version record.
--
-- measure_card_requests is an OPERATOR table (registered in SERVICE_ROLE_ONLY
-- in rls-guard_test.ts): shipping addresses are PII, so the SPA never reads
-- the table — deny-all RLS, service-role only, owner column deliberately
-- named owner_user_id per the rls-guard convention. Sellers interact through
-- the edge (POST/GET /api/flipdesk/measure/card-request); operators work the
-- queue via /api/admin/measure-cards (list, CSV export, bulk status).
-- Fulfillment itself stays manual/vendor-side at this scale — the queue is
-- structured data, not automation.

CREATE TABLE IF NOT EXISTS public.measure_card_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'requested'
                 CHECK (status IN ('requested', 'exported', 'shipped')),
  card_version   int  NOT NULL DEFAULT 1,
  plan_key       text,
  ship_name      text NOT NULL,
  address_line1  text NOT NULL,
  address_line2  text,
  city           text NOT NULL,
  state          text NOT NULL,
  postal_code    text NOT NULL,
  country        text NOT NULL DEFAULT 'US',
  requested_at   timestamptz NOT NULL DEFAULT now(),
  exported_at    timestamptz,
  shipped_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Abuse guard: one ACTIVE (not-yet-shipped) request per seller. The edge
-- also checks before insert; this is the backstop under concurrency.
CREATE UNIQUE INDEX IF NOT EXISTS measure_card_requests_one_active
  ON public.measure_card_requests (owner_user_id)
  WHERE status <> 'shipped';

CREATE INDEX IF NOT EXISTS measure_card_requests_queue
  ON public.measure_card_requests (status, requested_at);

ALTER TABLE public.measure_card_requests ENABLE ROW LEVEL SECURITY;
-- Deny-all on purpose: no policies. Service role bypasses RLS.

DROP TRIGGER IF EXISTS set_measure_card_requests_updated_at
  ON public.measure_card_requests;
CREATE TRIGGER set_measure_card_requests_updated_at
  BEFORE UPDATE ON public.measure_card_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Profile-side card-version record (US-1579 AC4): which card version the
-- seller HAS (downloaded the print-at-home PDF, or was mailed one), so a
-- future card revision can target upgrade messaging. Calibrate already
-- detects the per-photo version from the marker ids.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS measure_card_version int,
  ADD COLUMN IF NOT EXISTS measure_card_source text
    CHECK (measure_card_source IN ('download', 'mail') OR measure_card_source IS NULL);

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00351') on conflict do nothing;
