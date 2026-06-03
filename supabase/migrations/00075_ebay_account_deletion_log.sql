-- eBay Marketplace Account Deletion compliance log (US-349).
--
-- eBay REQUIRES every production keyset to receive, authenticate, and act on
-- "marketplace account deletion" notifications, and to retain evidence that the
-- request was honored. This is DISTINCT from public.account_deletion_log, which
-- records erasure of a *GradeThread* account (NOT NULL deleted_user_id, fired
-- immediately before a full auth.users cascade). An eBay deletion event only
-- DEACTIVATES the seller's marketplace_connections row — the GradeThread
-- account is untouched and the eBay username may not even match a connection we
-- hold. So it gets its own, purpose-shaped table.
--
-- The row is written ONLY after the inbound signature is verified (the POST
-- handler rejects unsigned/forged requests with 401 before any DB write), so an
-- attacker can no longer mass-disconnect sellers or flood this table.

CREATE TABLE IF NOT EXISTS public.ebay_account_deletion_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- eBay's notificationId for the deletion event. Unique so a re-delivery
  -- can't write a second row (belt-and-braces alongside claimWebhookEvent).
  notification_id   text UNIQUE,
  -- eBay-side identifiers from the payload. username is what we match against
  -- marketplace_connections.account_handle. No GradeThread PII is stored.
  ebay_username     text,
  ebay_user_id      text,
  -- How many of OUR connections we deactivated in response (0 when the eBay
  -- account was never linked here — still logged as proof we processed it).
  connections_deactivated integer NOT NULL DEFAULT 0,
  received_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ebay_account_deletion_log_received_at
  ON public.ebay_account_deletion_log(received_at);

-- Append-only compliance record written by the edge service-role client
-- (bypasses RLS). Admins may read it; nobody may write/update/delete via the
-- API (no INSERT/UPDATE/DELETE policy ⇒ denied for anon/auth).
ALTER TABLE public.ebay_account_deletion_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ebay_account_deletion_log_admin_select"
  ON public.ebay_account_deletion_log
  FOR SELECT
  USING (public.is_admin());
