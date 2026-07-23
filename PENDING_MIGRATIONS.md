# PENDING MIGRATIONS — apply BEFORE pushing this branch to origin

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
