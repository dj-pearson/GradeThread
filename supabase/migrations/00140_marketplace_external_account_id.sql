-- US-364: store eBay's STABLE account identifier on the connection so the
-- marketplace-account-deletion webhook can match the row by a verified,
-- non-guessable id instead of the free-text `account_handle` (username).
--
-- eBay's account-deletion notification payload carries `notification.data.userId`
-- — eBay's permanent, opaque user id — alongside the human `username`. The same
-- id is returned by /commerce/identity/v1/user (captured at OAuth connect /
-- refresh backfill). Matching deletion on this id (falling back to the handle for
-- legacy rows that pre-date this column) closes the audit gap where a deletion
-- request was matched purely on a handle that a third party could guess.

ALTER TABLE public.marketplace_connections
  ADD COLUMN IF NOT EXISTS external_account_id text;

COMMENT ON COLUMN public.marketplace_connections.external_account_id IS
  'Marketplace-stable account id (eBay /commerce/identity userId). Used to match '
  'account-deletion webhooks on a verified id rather than the guessable handle (US-364).';

-- Deletion handler looks rows up by (marketplace, external_account_id).
CREATE INDEX IF NOT EXISTS idx_marketplace_connections_external_account
  ON public.marketplace_connections(marketplace, external_account_id)
  WHERE external_account_id IS NOT NULL;
