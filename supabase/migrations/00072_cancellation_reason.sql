-- Persist the self-serve cancellation reason on the user row (US-216).
--
-- US-216's acceptance criteria call for the optional cancellation-reason
-- single-select (Too expensive / Not enough features / Found a better tool /
-- Taking a break / Other, plus free-text notes) to write to
-- users.cancellation_reason. The original cancel handler only stashed it in the
-- Stripe subscription metadata, which the customer.subscription.deleted webhook
-- can't conveniently read back when it fires at period end. We store it on the
-- user so the webhook can attach it to the server-side 'subscription.ended'
-- analytics event and so admins can query churn reasons directly.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS cancellation_reason text;

COMMENT ON COLUMN public.users.cancellation_reason IS
  'US-216: most recent self-serve cancellation reason (select value + optional notes), set when cancel-at-period-end is scheduled and read by the subscription.deleted webhook. Cleared on resubscribe.';
