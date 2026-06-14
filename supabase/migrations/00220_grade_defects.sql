-- US-1037: normalized, queryable genuine-defect rows.
--
-- Today a grade's genuine defects live only in grade_reports.defects_found jsonb,
-- so you can't query "all grades with a major seam failure" or compute per-type
-- accuracy without scanning JSON. This table mirrors each genuine defect as a
-- structured, indexable row (type / severity / size / area / location /
-- repairability / factor impact / bbox), keyed to its grade report.
--
-- DUAL-WRITE, not a cutover: the pipeline keeps writing defects_found jsonb (the
-- Auto-Disclosure Engine + certificate still read that, so there is NO public-cert
-- regression). This table is the analytics/calibration surface (US-1036) and a
-- future disclosure source. Rows cascade-delete with the grade report.
--
-- Internal surface: queried by the edge service (admin/calibration) on the
-- service-role client. There is no user_id column (defects are reached via the
-- owned grade_reports row), so the tenant-isolation RLS guard won't misclassify
-- it as user-owned tenant data. RLS on + no client policies = deny-all for
-- anon/authenticated; service-role bypasses RLS.

create table if not exists public.grade_defects (
  id               uuid primary key default gen_random_uuid(),
  grade_report_id  uuid not null references public.grade_reports(id) on delete cascade,
  -- Free-text description (defects_found.defect).
  defect           text not null,
  -- Normalized taxonomy (defect-weighting.ts). text (not enum) so the taxonomy
  -- can grow without a migration; the app coerces unknowns to 'other'/'unknown'.
  defect_type      text not null default 'other',
  severity         text not null,            -- minor | moderate | major
  repairability    text,                     -- reversible | repairable | permanent
  size_bucket      text not null default 'unknown', -- pinhole|small|medium|large|extensive|unknown
  area_pct         numeric(5,2),             -- estimated % of panel/garment area
  location         text,
  impact_on_grade  text,
  -- Routed factor deductions (defect-weighting.ts), e.g. {"fabric_condition":2.4}.
  factor_impact    jsonb,
  -- Normalized [x,y,w,h] (0..1) when the defect was localized.
  bbox             jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists idx_grade_defects_report
  on public.grade_defects(grade_report_id);
create index if not exists idx_grade_defects_type
  on public.grade_defects(defect_type);
create index if not exists idx_grade_defects_size
  on public.grade_defects(size_bucket);

-- Service-role only (no client policies) — internal analytics. RLS on +
-- revoke writes (deny-all for non-service-role; service-role bypasses RLS).
alter table public.grade_defects enable row level security;
revoke insert, update, delete on public.grade_defects from anon, authenticated;

comment on table public.grade_defects is
  'US-1037: normalized genuine-defect rows mirrored from grade_reports.defects_found '
  '(dual-write; jsonb remains the disclosure source). Service-role only.';
