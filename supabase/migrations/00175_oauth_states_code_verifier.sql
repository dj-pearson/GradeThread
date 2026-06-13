-- Depop connector PKCE support (US-713). Depop's Selling API uses OAuth 2.0
-- Authorization Code + PKCE (unlike eBay/Shopify, which don't). PKCE requires
-- the server to remember the random `code_verifier` it generated at /oauth/start
-- and present it at the token exchange in /oauth/callback. The single-use
-- oauth_states row is exactly that round-trip carrier, so we add one nullable
-- column to it rather than a new table.
--
-- Nullable + defaulted-null: every existing eBay/Shopify state row (which doesn't
-- use PKCE) is unaffected; only the Depop flow writes/reads it.

ALTER TABLE public.oauth_states
  ADD COLUMN IF NOT EXISTS code_verifier text;

-- (No RLS change: oauth_states already has RLS enabled with no policies, so the
--  column is reachable only by the service-role edge client — same as the rest
--  of the row, which holds OAuth CSRF state and must never be client-readable.)
