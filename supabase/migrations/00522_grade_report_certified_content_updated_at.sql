-- US-2392: a certificate records when its certified content last changed.
--
-- See vault/20-domain/certificate-revision-provenance.md for the contract.
--
-- WHAT WAS MISSING. `grade_reports` has no `updated_at` at all — only
-- `created_at` (00001) and `superseded_at` (00150). A human-review adjustment
-- rewrites `overall_score`, `grade_tier`, all five factor scores, `content_hash`,
-- `content_signature` and `integrity_version` on a LIVE, publicly-served row and
-- records no timestamp on it. The information exists (`human_reviews.reviewed_at`)
-- but it is not on the report, so nothing reading a certificate can tell that its
-- scores changed after publication, or when.
--
-- The integrity hash makes this sharper than a missing-metadata bug. That hash
-- exists so a buyer can verify a certificate has not been tampered with — and a
-- legitimate adjustment RECOMPUTES it, so the certificate verifies clean both
-- before and after a score change, with nothing on the row marking that one
-- happened. It is not a tamper hole (the change is authorised and audited), but
-- the certificate carries no evidence of its own revision.
--
-- A COLUMN, NOT A DERIVATION, which is AC1's explicit decision. The alternative
-- was max(human_reviews.reviewed_at) per report, needing no migration. Three
-- reasons the column wins:
--
--   1. It survives a human_reviews purge. `human_reviews` is operator data with
--      a retention story; the certificate is a public durable artefact. Deriving
--      a public fact from a table that may be pruned means the certificate
--      silently loses its revision date one day.
--   2. It does not couple the public certificate read to an operator table. That
--      read is unauthenticated and runs on the service-role client, where the
--      whole defence is a narrow column allowlist — adding a join to an operator
--      table is exactly the direction that surface must not move in.
--   3. It is honest about what it means. `reviewed_at` is when a human reviewed;
--      this is when the CERTIFIED CONTENT changed. Usually the same moment, but
--      a review that changes nothing must not move the date, and a future
--      non-review reseal path would move it correctly.
--
-- NULL MEANS NEVER REVISED, deliberately — not "unknown". Every existing row is
-- backfilled to NULL and that is the truthful answer: a certificate that has not
-- been adjusted has no modification date distinct from its publication date, and
-- AC2/AC4 depend on being able to tell those apart. A REGRADE must never set it:
-- 00150 creates a NEW row with a NEW certificate_id and nulls the old one's, so
-- the new certificate's modification date IS its publication date, and emitting
-- one would tell a crawler that a fresh certificate had been edited.

alter table public.grade_reports
  add column if not exists certified_content_updated_at timestamptz;

comment on column public.grade_reports.certified_content_updated_at is
  'US-2392: when this certificate''s CERTIFIED CONTENT (scores, tier, integrity '
  'hash) was last rewritten in place by a human-review adjustment. NULL means '
  'never revised — which is the truthful answer, not a missing value. A REGRADE '
  'must not set it: that mints a new certificate_id whose modification date is '
  'its publication date.';

-- Partial: the overwhelming majority of rows are NULL forever, and the only
-- queries that care are "which certificates have been revised".
create index if not exists idx_grade_reports_certified_content_updated_at
  on public.grade_reports (certified_content_updated_at desc)
  where certified_content_updated_at is not null;

insert into public.applied_migrations (version) values ('00522') on conflict do nothing;
