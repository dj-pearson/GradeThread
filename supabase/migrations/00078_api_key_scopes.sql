-- US-356: per-key scopes + rotation metadata for public API keys.
--
-- Until now every key was all-powerful. Scopes let an integration mint a
-- least-privilege key (e.g. submit-only, or read-only). The default is the full
-- set so existing keys and clients that don't specify scopes keep working.
--
-- last_rotated_at records the last in-place rotation (new secret, same row) for
-- audit; rotation itself is an edge endpoint that overwrites key_hash/key_prefix.

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS scopes text[] NOT NULL
    DEFAULT ARRAY['read', 'submit', 'webhook_manage'],
  ADD COLUMN IF NOT EXISTS last_rotated_at timestamptz;

-- Guard against an unknown scope sneaking in (the edge validates too, but the
-- DB is the last line). Every element must be one of the known scopes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_scopes_valid'
  ) THEN
    ALTER TABLE public.api_keys
      ADD CONSTRAINT api_keys_scopes_valid
      CHECK (scopes <@ ARRAY['read', 'submit', 'webhook_manage']::text[]);
  END IF;
END $$;
