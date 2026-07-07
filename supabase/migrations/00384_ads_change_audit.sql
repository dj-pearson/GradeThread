-- US-1703: guarded-apply audit + rollback ledger.
--
-- Every attempt to push an approved recommendation to Google Ads — dry-run and
-- real — writes a row here with the BEFORE value (captured from the live account
-- pre-mutate) and the AFTER value, so any applied change is fully audited and
-- reversible (one-click rollback re-applies before_value through the same guarded
-- path). Operator table: written by the apply flow (service role), read by the
-- Command Center. Deny-all RLS, rls-guard registered. owner_user_id (operator
-- naming) is the admin who acted — not a tenant key.

CREATE TABLE IF NOT EXISTS public.ads_change_audit (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform           text NOT NULL,
  -- the recommendation this apply came from (null for a raw rollback)
  recommendation_id  uuid,
  change_type        text NOT NULL,
  target_type        text,
  target_resource    text,
  before_value       jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_value        jsonb NOT NULL DEFAULT '{}'::jsonb,
  dry_run            boolean NOT NULL DEFAULT true,
  success            boolean NOT NULL DEFAULT false,
  -- 'apply' | 'rollback'
  action             text NOT NULL DEFAULT 'apply',
  result             jsonb NOT NULL DEFAULT '{}'::jsonb,
  error              text,
  owner_user_id      uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ads_change_audit_rec_idx
  ON public.ads_change_audit (recommendation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ads_change_audit_recent_idx
  ON public.ads_change_audit (platform, created_at DESC);

ALTER TABLE public.ads_change_audit ENABLE ROW LEVEL SECURITY;

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00384') on conflict do nothing;
