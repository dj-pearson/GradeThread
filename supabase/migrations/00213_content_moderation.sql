-- US-889: Cross-tenant listing & photo moderation.
--
-- Today moderation only covers grading submissions (00023). Listings and the
-- item_photos that ship to public certificates and marketplaces had no operator
-- takedown path. This migration adds:
--   1. Reversible takedown markers on the two content tables:
--        listings.moderation_hidden   — admin unpublished this listing
--        item_photos.is_hidden        — admin hid this photo
--      Both default false; a takedown sets them true and the audited restore
--      endpoint flips them back, so every write path is reversible.
--   2. A reusable flag queue (content_moderation_flags) that the fraud console,
--      user reports, and abuse scans all enqueue into, and the admin moderation
--      page drains. Like abuse_signals (00212) it is an OPERATOR-ONLY surface:
--      service-role only, deny-all RLS, and the owning-tenant column is named
--      `owner_user_id` (NOT `user_id`) on purpose so the tenant-isolation RLS
--      guard does not misclassify this admin table as user-owned tenant data.

-- ── Reversible takedown markers ────────────────────────────────────────────
alter table public.listings
  add column if not exists moderation_hidden boolean not null default false;

alter table public.item_photos
  add column if not exists is_hidden boolean not null default false;

-- Operator queues filter on the takedown markers.
create index if not exists idx_listings_moderation_hidden
  on public.listings (moderation_hidden) where moderation_hidden;
create index if not exists idx_item_photos_is_hidden
  on public.item_photos (is_hidden) where is_hidden;

-- ── Reusable moderation flag queue ─────────────────────────────────────────
create type public.moderation_content_type as enum ('listing', 'photo');
create type public.moderation_flag_status as enum ('open', 'resolved', 'dismissed');

create table if not exists public.content_moderation_flags (
  id            uuid primary key default gen_random_uuid(),
  content_type  public.moderation_content_type not null,
  -- The listings.id / item_photos.id being flagged. Not an FK: the row may be
  -- hard-deleted by its owner before triage, and we keep the flag's audit trail.
  content_id    uuid not null,
  -- Denormalized owning tenant, resolved at enqueue time so the console can list
  -- + link without re-joining. Named owner_user_id (NOT user_id) so the
  -- tenant-isolation guard treats this as the admin-only table it is.
  owner_user_id uuid references public.users(id) on delete set null,
  reason        text not null,
  -- Where the flag came from: 'fraud_console' | 'user_report' | 'abuse_scan' |
  -- 'manual'. Free text so new producers don't need a migration.
  source        text not null default 'manual',
  status        public.moderation_flag_status not null default 'open',
  flagged_by    uuid references public.users(id) on delete set null,
  resolved_by   uuid references public.users(id) on delete set null,
  -- What the operator did on resolve: 'takedown' | 'restore' | 'dismissed' | ...
  resolution_action text,
  resolved_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.content_moderation_flags is
  'US-889: reusable moderation queue for listings + item_photos. Enqueued by the fraud console, user reports, and abuse scans; drained via /api/admin/moderation/*. Service-role only (deny-all RLS). owner_user_id (not user_id) is intentional so the tenant-isolation guard does not treat this operator-only table as user-owned data.';

-- One OPEN flag per content item — re-enqueueing an already-open concern updates
-- it in place rather than piling up duplicates (idempotent producers).
create unique index if not exists uniq_open_content_moderation_flag
  on public.content_moderation_flags (content_type, content_id)
  where status = 'open';

create index if not exists idx_content_moderation_flags_triage
  on public.content_moderation_flags (status, content_type, created_at desc);
create index if not exists idx_content_moderation_flags_owner
  on public.content_moderation_flags (owner_user_id);

drop trigger if exists set_content_moderation_flags_updated_at on public.content_moderation_flags;
create trigger set_content_moderation_flags_updated_at
  before update on public.content_moderation_flags
  for each row execute function public.set_updated_at();

-- Service-role only (no client policies): an operator safety surface. RLS on +
-- revoke writes — anon/authenticated get nothing; the edge service-role client
-- is the only read/write path.
alter table public.content_moderation_flags enable row level security;
revoke insert, update, delete on public.content_moderation_flags from anon, authenticated;
