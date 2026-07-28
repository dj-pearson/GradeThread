# PENDING MIGRATIONS — apply BEFORE pushing this branch to origin

## ⏳ HELD: 00496_grade_reports_tag_read.sql (US-2210 label transcription in grading, 2026-07-28)

**Apply AFTER 00495.** Adds one nullable column, `grade_reports.tag_read jsonb`,
holding the verbatim care/brand-label transcription a grade was identified from:
`{fields:[{field,value,confidence}], discrepancies:[{field,read,declared}],
min_confidence, model, read_at}`. No backfill — NULL already means "no
label-derived identity". Run `NOTIFY pgrst, 'reload schema';` after applying.

**No client reads or writes this column.** The SPA is untouched by this commit
and the column is deliberately absent from the public certificate's allowlist
(`content-public.ts` CERT_REPORT_COLUMNS), so a frontend auto-deploy cannot
reach it. Unlike 00495, apply order is not urgent for correctness.

**The edge write is double-gated, so pushing before applying is still safe.**
The pipeline only sets `tag_read` when `GRADING_TAG_OCR` is truthy — the flag
defaults OFF and must be set deliberately in Coolify. Until then the insert
never names the column. Do NOT flip that flag before the SQL is applied: the
grade-report insert would fail on the missing column and take the paid grade
down with it.

**Why:** grading took brand/size/style from whatever the seller typed at submit,
even though `lib/ai-tag-ocr.ts` had read those fields verbatim off the garment's
own label since US-543 — only the AutoLister ever called it. The pipeline now
runs that read and injects it as trusted context, so the read itself has to be
retained to stay auditable.

**Risk: LOW.** One additive nullable jsonb column plus a `comment on column`; no
trigger, no index, no data migration, no view change. Idempotent and re-run safe.
Not exercised against a live DB in this environment (no Docker). After apply and
before flipping the flag, confirm the column exists on `grade_reports`.


## ⏳ HELD: 00495_item_photo_edit_originals.sql (US-2208 non-destructive photo editing, 2026-07-27)

**Apply AFTER 00494.** Adds two nullable columns to `item_photos`:
`original_storage_path text` (the pristine pre-edit original, copied aside once
on first edit) and `edit_recipe jsonb` (the geometry + tone that produced the
current image). No backfill — NULL already means "never edited". Run
`NOTIFY pgrst, 'reload schema';` after applying.

**⚠️ CLIENT READS AND WRITES BOTH NEW COLUMNS — apply-order matters.** The SPA in
this commit selects `item_photos.*` (so PostgREST returns whatever exists — a
missing column is tolerated on READ), but the photo editor's save path
**writes** `original_storage_path` and `edit_recipe`
(`src/lib/photo-mutations.ts` → `persistPhotoEdit`). Cloudflare Pages
auto-deploys the frontend on push, so if this pushes BEFORE the SQL is applied,
**every photo edit and every bulk tone-match fails** with
`column item_photos.original_storage_path does not exist`, and the "Revert to
original" control never appears. Apply the SQL to prod FIRST, then push. Upload,
reorder, retag and delete are unaffected.

**Why:** the editor overwrote `storage_path` in place, so a saved brightness or
crop was permanent and the original upload was destroyed. Preserving the
original also lets a re-edit start from the pristine file instead of compounding
tone and JPEG re-encoding on each pass.

**Risk: LOW.** Two additive nullable columns plus two `comment on column`
statements; no trigger, no index, no data migration. Idempotent and re-run safe.
The storage side is client-driven (a `copy()` into an `originals/` subfolder
under the same `{userId}/…` prefix, so the per-user-folder RLS on
`item-photos` still matches on segment 1). Not exercised against a live DB in
this environment (no Docker) — after apply, spot-check that editing a photo
once sets `original_storage_path`, that editing it twice does NOT change that
value, and that "Revert to original" restores the pre-edit image.


## ⏳ HELD: 00494_submissions_overall_score.sql (US-2196 server-side grade sort, 2026-07-27)

**Apply AFTER 00493.** Adds `submissions.overall_score numeric(3,1)`, a
`sync_submission_overall_score()` trigger on `grade_reports` (after
insert/delete/update of `overall_score`,`superseded_at`) that copies the ACTIVE
report's score (`superseded_at IS NULL`) onto the submission, a one-time
backfill, and `idx_submissions_overall_score`. Run `NOTIFY pgrst, 'reload
schema';` after applying.

**⚠️ CLIENT READS THE NEW COLUMN — apply-order matters.** The SPA in this commit
sorts the submissions list with `.order("overall_score")` on the `submissions`
table (`src/pages/submissions.tsx`). Cloudflare Pages auto-deploys the frontend
on push, so if this pushes BEFORE the SQL is applied, sorting the submissions
list by grade throws `column submissions.overall_score does not exist` (the page
shows the ErrorState). Apply the SQL to prod FIRST, then push. Default sort
(created_at) and all other views are unaffected.

**Why:** the old grade-sort loaded every matching submission id + score and
sorted/paginated in JS (O(n) per sort) because the key lived in `grade_reports`;
this denormalization lets Postgres `ORDER BY ... LIMIT`. It COPIES the already
1-decimal-rounded value — no re-computation, so the weighted-overall rounding
lockstep is untouched (grading-engine contract).

**Risk: LOW–MEDIUM.** One additive column + one trigger + a backfill; idempotent
and re-run safe. The trigger correctness (active-report selection) was NOT
exercised against a live DB in this environment (no Docker) — spot-check after
apply: `select overall_score from submissions where id = <a graded submission>`
should match its active grade_report, and a retake should update it.


## ⏳ HELD: 00493_dispute_one_grade_per_report.sql (US-2153 one grade dispute per report, 2026-07-23)

**Apply AFTER 00492.** Deletes any pre-existing duplicate GRADE disputes
(keeps the earliest row per `(user_id, grade_report_id)`), then creates a
PARTIAL unique index `disputes_one_grade_dispute_per_report` on
`(user_id, grade_report_id) WHERE kind = 'grade'`.

**Why it matters:** the advertised "one complaint per grade" + 7-day filing
window were enforced only in client UI. The `POST /api/grade/dispute` route
inserted unconditionally, so a double-tap on a slow connection, a two-device
race, or a direct API call created duplicate rows in the human review queue,
and a report older than 7 days could still be disputed. The edge now enforces
both server-side (typed `DISPUTE_WINDOW_EXPIRED` / `DISPUTE_ALREADY_EXISTS`
errors); this index is the race-proof backstop behind the duplicate SELECT.

**Scope note:** the index is PARTIAL on `kind='grade'`, NOT the blanket
`UNIQUE (user_id, grade_report_id)` named in the story's AC3 — that AC predates
the `kind` column (00489). A blanket constraint would wrongly stop a grade
dispute and an authenticity appeal from coexisting on one report; the
authenticity path is deliberately re-fileable and is left untouched.

**Risk: LOW.** One DELETE of duplicates + one partial index; no schema of an
existing column changes. Idempotent (both statements `IF NOT EXISTS` / re-run
safe). The edge in this commit does NOT depend on the index to function — the
window check and the duplicate SELECT work without it; the index only upgrades
a raced duplicate from a 500 to a clean 409. So an edge-first roll is safe.
The SPA carries no schema dependency (it reads no new column).

**After applying:** `NOTIFY pgrst, 'reload schema';` (new index; keeps the boot
guard's schema version truthful at 00493).
