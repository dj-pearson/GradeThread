-- US-459: record how many cancelled/returned (reversed) sales an eBay sync
-- handled, so the Reconciliation sync history reports returns/cancellations
-- distinctly from new/updated sales (AC3). Counts line items whose order came
-- back CANCELED or FULLY_REFUNDED in the pull.

ALTER TABLE public.flipdesk_sync_runs
  ADD COLUMN IF NOT EXISTS sales_reversed integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.flipdesk_sync_runs.sales_reversed IS
  'Cancelled/refunded sale line items handled this run (US-459).';
