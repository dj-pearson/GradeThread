-- US-920: AI-generated, email-safe newsletter imagery.
--
-- Two things this migration adds for the autonomous newsletter's imagery step
-- (lib/newsletter-imagery.ts):
--   1. newsletter_issue_assets — a registry of every generated/selected image,
--      linked to the issue id so assets can be reused on a rebuild and cleaned
--      up when an issue is deleted (AC6). Cascade-deletes with the issue.
--   2. Prices the gpt-image-1 model in system_settings.ai_model_prices so the
--      AI-spend dashboard (ai_spend, 00218) and budget guardrails (ai_budget_status,
--      00219) re-price newsletter image generation from its logged image-output
--      tokens — making image cost visible + cappable (AC5). The imagery module
--      logs each photo to ai_usage_events under feature 'newsletter_image'.

BEGIN;

-- ── (1) newsletter_issue_assets ────────────────────────────────────────────
-- Operator program data (a child of the operator-only newsletter_issues): RLS
-- enabled, NO policy (deny-all), writes revoked from anon/authenticated. Read +
-- written ONLY by the edge service-role client; the SPA never reads raw rows.
-- No tenant owner column — the parent issue is itself an operator surface.
create table if not exists public.newsletter_issue_assets (
  id          uuid primary key default gen_random_uuid(),
  issue_id    uuid not null references public.newsletter_issues(id) on delete cascade,
  -- 'hero' (gpt-image-1 photo, in storage) | 'branded_card' (deterministic Satori URL).
  kind        text not null default 'hero',
  -- Absolute, email-safe public URL referenced by the rendered issue.
  url         text not null,
  -- content-images storage path (null for branded-card URLs, which aren't stored).
  path        text,
  alt         text,
  prompt      text,
  width       integer check (width  is null or width  >= 0),
  height      integer check (height is null or height >= 0),
  bytes       integer check (bytes  is null or bytes  >= 0),
  model       text,
  cost_usd    numeric(12,6),
  created_at  timestamptz not null default now()
);

create index if not exists idx_newsletter_issue_assets_issue
  on public.newsletter_issue_assets (issue_id, created_at desc);

comment on table public.newsletter_issue_assets is
  'US-920: registry of generated/selected newsletter imagery (hero photo or '
  'branded card), linked to newsletter_issues for reuse + cleanup. Operator-only '
  '(deny-all RLS, service-role writes); cascades with the issue.';

alter table public.newsletter_issue_assets enable row level security;
revoke all on public.newsletter_issue_assets from anon, authenticated;

-- ── (2) Price gpt-image-1 in the AI cost basis ──────────────────────────────
-- USD per MILLION image-output tokens. gpt-image-1 bills image tokens; the
-- imagery module logs an estimated image-token count per render so this re-prices
-- to a realistic per-image cost in the spend dashboard + budget guardrails. Merged
-- into the existing jsonb (00218) idempotently so a re-apply is a no-op.
update public.system_settings
set value = value || jsonb_build_object(
      'gpt-image-1', jsonb_build_object('input', 10, 'output', 40, 'cache_write', 0, 'cache_read', 0)
    ),
    default_value = default_value || jsonb_build_object(
      'gpt-image-1', jsonb_build_object('input', 10, 'output', 40, 'cache_write', 0, 'cache_read', 0)
    )
where key = 'ai_model_prices';

COMMIT;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00288')
ON CONFLICT (version) DO NOTHING;
