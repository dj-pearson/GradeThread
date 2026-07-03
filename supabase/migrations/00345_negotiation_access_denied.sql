-- US-1421 (code slice): per-connection negotiation-scope denial flag.
--
-- Mirrors analytics_access_denied (00136): when a /sell/negotiation call 403s
-- at runtime even though the deployment requests the sell.negotiation scope,
-- THIS connection's token predates the scope grant (consented before eBay
-- approved it on the prod keyset) — the fix is a re-consent, so the UI must
-- say "reconnect required", not "feature unavailable". The edge sets the flag
-- on such a 403 and clears it on any successful negotiation call.
--
-- Idempotent; safe to re-run.

ALTER TABLE public.marketplace_connections
  ADD COLUMN IF NOT EXISTS negotiation_access_denied boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.marketplace_connections.negotiation_access_denied IS
  'US-1421: a /sell/negotiation call 403d although the deployment requests the scope — this token predates the grant; seller must reconnect (re-consent).';

-- US-1108 self-record footer.
INSERT INTO public.applied_migrations (version) VALUES ('00345')
ON CONFLICT (version) DO NOTHING;
