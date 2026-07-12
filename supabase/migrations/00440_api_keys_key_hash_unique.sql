-- US-1942: make api_keys.key_hash UNIQUE.
--
-- 00001 created idx_api_keys_key_hash as a plain (non-unique) index. Nothing at
-- the DB level prevented two rows sharing a key_hash, and the per-request auth
-- lookup by key_hash could in principle match multiple rows (relying on app code
-- to pick one). A UNIQUE index both enforces the one-hash-one-key invariant and
-- makes the hot lookup a guaranteed single-row probe.
--
-- Safety: de-dupe any existing collisions FIRST (keep the earliest-created row
-- per hash; tie-break by id) so the unique index can be created without error.
-- key_hash is a SHA of a random secret, so a genuine collision means a duplicate
-- issuance, not two distinct valid keys.

delete from public.api_keys a
using public.api_keys b
where a.key_hash = b.key_hash
  and (a.created_at > b.created_at
       or (a.created_at = b.created_at and a.id > b.id));

drop index if exists public.idx_api_keys_key_hash;
create unique index if not exists idx_api_keys_key_hash on public.api_keys(key_hash);

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00440') ON CONFLICT DO NOTHING;
