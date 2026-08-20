-- 00638 — remove the Lulufanatics crawl from production
--
-- Migrations 00636 and 00637 created a crawler for lulufanatics.com and were
-- APPLIED to production. Their files were then deleted from this repo, which
-- removed the intent and left the objects: deleting a migration file does not
-- unmake what it already did. This is the migration that actually removes them.
--
-- Why they should not exist: lulufanatics.com's terms prohibit scrapers in as
-- many words, and the site is one person's hand-built database. GradeThread
-- fills its style-code index from marketplace listings it is entitled to read,
-- from sellers correcting us, and from visitors who are holding the garment
-- (00503, 00627, 00628, 00635).
--
-- ── WHAT PRODUCTION ACTUALLY HAD, measured rather than assumed ──────────────
--
-- 00637's file was recovered from the operator. 00636's was not recoverable —
-- untracked, never committed, absent from the reflog — so its footprint was
-- established by asking production instead of guessing: the PostgREST OpenAPI
-- document showed ONE unaccounted table (lulufanatics_catalog_jobs) and two
-- unaccounted RPCs, and confirmed that every style-code table carries exactly
-- the columns this repo's migrations define. So 00636 added no table and no
-- column. What it may have done is widen the style_code_names.source CHECK, or
-- write rows under a source this codebase does not know — and both are handled
-- below without needing to know which.
--
-- ⚠ AND THEIR BOOKKEEPING ROWS GO TOO, at the end of this file.
--
-- Left alone, 00636/00637 would be recorded as applied with no file in this
-- build — phantoms, exactly like 00479, reported forever by /health/ready. The
-- alternative was to add them to KNOWN_PHANTOM_VERSIONS, and the guard on that
-- list refuses: it may only shrink, because a growing list means phantoms are
-- being accepted rather than explained. That guard is right. These are not
-- unexplained rows to be excused; they are rows whose migrations we are
-- deliberately undoing, so the honest end state is an applied set that matches
-- the shipped set.
--
-- Numbering still continues at 00639. Removing the rows makes 00636/00637 SAFE
-- to reuse — the boot guard can no longer read "applied" off a stale row for
-- SQL that never ran, which is the 00479 danger — but reusing them would still
-- be confusing to anyone reading this history, and numbers are cheap.

-- ── The crawl objects ───────────────────────────────────────────────────────
--
-- Functions BEFORE the table: claim_lulufanatics_catalog_jobs is declared
-- RETURNS SETOF public.lulufanatics_catalog_jobs, so it depends on the table's
-- composite type and the DROP TABLE would fail while it exists. Explicit order
-- rather than CASCADE, so this removes exactly what it names and nothing that
-- happens to depend on it.
DROP FUNCTION IF EXISTS public.claim_lulufanatics_catalog_jobs(integer);
DROP FUNCTION IF EXISTS public.enqueue_lulufanatics_catalog_urls(text[]);

-- The index and the updated_at trigger belong to the table and go with it.
DROP TABLE IF EXISTS public.lulufanatics_catalog_jobs;

-- ── Whatever 00636 did to style_code_names.source ───────────────────────────
--
-- Rows first, then the constraint: ADD CONSTRAINT validates existing rows, so
-- re-asserting it while a crawl-sourced row is present would fail the whole
-- migration.
--
-- A row whose source this codebase does not know is already dead weight —
-- nameSourceRank() returns past the end of NAME_SOURCE_ORDER for an unknown
-- source and pickStyleCodeName filters it out — so nothing is lost by removing
-- it, and leaving it would keep evidence we should not be holding.
DELETE FROM public.style_code_names
WHERE source NOT IN ('consensus', 'seller', 'admin', 'official', 'public');

-- Re-asserted to exactly the five sources lib/style-code-names.ts knows, so the
-- constraint is deterministic whatever 00636 set it to.
ALTER TABLE public.style_code_names
  DROP CONSTRAINT IF EXISTS style_code_names_source_check;
ALTER TABLE public.style_code_names
  ADD CONSTRAINT style_code_names_source_check
  CHECK (source IN ('consensus', 'seller', 'admin', 'official', 'public'));

-- ── The bookkeeping rows ────────────────────────────────────────────────────
--
-- Last, deliberately: if anything above fails, this migration aborts with the
-- rows still saying 00636/00637 applied — which is TRUE until their objects are
-- actually gone. Removing them first would claim a cleanup that had not happened.
DELETE FROM public.applied_migrations WHERE version IN ('00636', '00637');

-- US-1108: self-record the applied version so the edge boot guard stays truthful.
insert into public.applied_migrations (version) values ('00638') on conflict do nothing;
