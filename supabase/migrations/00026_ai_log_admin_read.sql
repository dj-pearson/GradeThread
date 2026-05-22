-- Admins need to read all AI enrichment logs for the platform-wide
-- acceptance-rate metric (US-167). Postgres ORs permissive policies, so
-- this sits alongside the existing own-row policy from migration 00024.

CREATE POLICY "Admins can view all AI enrichment logs"
  ON public.ai_enrichment_log FOR SELECT
  USING (public.is_admin());
