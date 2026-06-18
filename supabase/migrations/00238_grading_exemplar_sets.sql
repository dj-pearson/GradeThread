-- US-1067: few-shot exemplar cache from human-corrected grades.
--
-- AI self-improvement epic. accuracy-tracking.ts already captures the AI-vs-human
-- corrected grades (incl. the intentional-design-misread flag), but those
-- corrections were never fed back to the model as few-shot precedents. This table
-- stores a CURATED, VERSIONED, PII-FREE set of such corrections, rendered into a
-- compact text block the composite grading prompt can lean on so it gets the
-- distressed-denim / misread cases right WITHOUT a larger reasoning budget.
--
--   * version_name      — stable label (e.g. "exemplars_v1") used to attribute
--                         the set; unique.
--   * garment_category  — scope of the set; NULL = global (all categories).
--   * exemplars         — the curated, PII-free exemplar objects (no reviewer
--                         notes, no owner identity, no images): garment_category/
--                         type, the AI score, the human-corrected score, the
--                         misread flag, and a short non-identifying rationale.
--   * block_text        — the rendered few-shot block appended to the composite
--                         system prompt (prompt-cached for token savings).
--   * approx_tokens     — rough recurring per-grade token cost of the block.
--   * status / is_active— a set goes live ONLY after passing the grading-eval
--                         gate (eval_passed) and being explicitly activated; one
--                         active set per scope.
--   * eval_*            — the gate outcome recorded for the impact report
--                         (MAE + agreement + the run id) before activation.
--
-- Operator-curated, NOT tenant-owned: deny-all RLS, service-role only. The SPA
-- reads/writes it ONLY via the role-gated /api/admin/grading endpoints.
-- (Classified in rls-guard_test.ts SERVICE_ROLE_ONLY.)

create table if not exists public.grading_exemplar_sets (
  id                  uuid primary key default gen_random_uuid(),
  version_name        text not null unique,
  -- NULL = global set (applies to every category); else scoped to one category.
  garment_category    text,
  -- Curated PII-free exemplar objects (see lib/few-shot-exemplars.ts).
  exemplars           jsonb not null default '[]'::jsonb,
  -- Rendered few-shot block appended to the composite grading prompt.
  block_text          text not null default '',
  exemplar_count      integer not null default 0,
  approx_tokens       integer not null default 0,
  -- How many corrected reviews were scanned to assemble this set.
  source_review_count integer not null default 0,
  -- candidate (default) -> active (eval-passed + promoted) -> retired.
  status              text not null default 'candidate'
                        check (status in ('candidate', 'active', 'retired')),
  eval_passed         boolean,
  eval_run_id         uuid,
  eval_mae            numeric,
  eval_agreement_rate numeric,
  is_active           boolean not null default false,
  notes               text,
  created_by          uuid references public.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_grading_exemplar_sets_active
  on public.grading_exemplar_sets(is_active, garment_category);
create index if not exists idx_grading_exemplar_sets_created
  on public.grading_exemplar_sets(created_at desc);

-- At most one ACTIVE set per scope (NULL category folded to '' so the global
-- slot is single-active too). Activation in code also deactivates the prior set,
-- but this is the hard guard.
create unique index if not exists uq_grading_exemplar_sets_active_scope
  on public.grading_exemplar_sets(coalesce(garment_category, ''))
  where is_active;

create trigger set_grading_exemplar_sets_updated_at
  before update on public.grading_exemplar_sets
  for each row execute function public.set_updated_at();

-- RLS enabled with ZERO policies by design: anon/authenticated get nothing; only
-- the service-role edge client (the role-gated /api/admin/grading endpoints)
-- reads or writes it. Operator-curated, not user-owned.
alter table public.grading_exemplar_sets enable row level security;
revoke all on public.grading_exemplar_sets from anon, authenticated;

comment on table public.grading_exemplar_sets is
  'US-1067: curated, versioned, PII-free few-shot exemplar sets mined from '
  'human-corrected grades. The active set''s block_text is appended to the '
  'composite grading prompt (prompt-cached) after passing the grading-eval gate. '
  'Service-role only; classified in rls-guard_test.ts SERVICE_ROLE_ONLY.';
