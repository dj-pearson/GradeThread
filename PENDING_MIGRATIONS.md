# PENDING MIGRATIONS — apply BEFORE pushing this branch to origin

## 🔴 HELD: 00572_tag_eras_provenance.sql (US-2212 AC5 — an era we cannot cite is invention)

**Risk: LOW.** One IMMUTABLE function, one CHECK constraint added `NOT VALID`,
two comments. No table rewritten, nothing backfilled, no existing row touched.

**Apply order: AFTER 00571.** No dependency, just NNNNN order.

**NOT push-blocking.** The constraint only bites on INSERT/UPDATE of
`brand_knowledge`, which no client writes — brand knowledge arrives through
migrations and the admin curation surface. The edge code that reads the new
per-entry provenance treats its absence as "uncited", which is what all ~220
existing entries are, so an old database under new code behaves correctly.

**`NOT VALID` IS THE DESIGN, NOT A SHORTCUT — do not "clean it up".** Every
seeded entry predates this and carries no provenance. A plain CHECK would refuse
to apply, so the only ways to ship it would be to fabricate sources (the thing
the rule exists to prevent) or delete curated knowledge that is still useful as
prompt reference. NOT VALID enforces on all new writes and leaves the legacy
rows readable. **The backfill is finished when this succeeds:**

```sql
ALTER TABLE public.brand_knowledge VALIDATE CONSTRAINT brand_knowledge_tag_eras_sourced;
```

Do NOT run that now — it will fail, and correctly.

**Why the predicate is in a function.** Postgres rejects a subquery in a CHECK
(`0A000`), and walking a jsonb array needs one. The first draft did it inline
and `node scripts/verify.mjs --db` caught it on a from-zero re-apply.

**Verified from zero on a throwaway stack**, not eyeballed.

**Run `NOTIFY pgrst, 'reload schema';`** after applying — a new function.

**Rollback** is dropping the constraint and the function. Nothing depends on
either; the edge code degrades to treating every era as uncited, which is the
state it is in today.

## 🔴 HELD: 00571_grade_confidence_label_fn.sql (US-2303 AC2 — one home for the confidence buckets)

**Risk: LOW to apply, HIGH if the wrong revision had been edited — read the
second paragraph.** Adds an IMMUTABLE `public.grade_confidence_label(numeric)`
and re-issues `public.public_grade_reports` to call it instead of re-deriving
the four boundaries inline.

**⚠️ THE STORY POINTED AT THE WRONG VIEW REVISION.** US-2303's note named 00356
as the live one. Three revisions have landed since — 00530 (rubric factors),
00532 (video grading), 00534 (live capture). Replacing 00356's body would have
SILENTLY REMOVED `rubric_key`, `factor_scores`, `video_capture_verified` and
`video_live_capture_verified` from the public certificate. `CREATE OR REPLACE
VIEW` would not have complained: it refuses to DROP or reorder columns, and
those four are at the END, so dropping them is exactly the shape it permits.
This file is GENERATED from 00534's own text with one expression substituted, so
the column list cannot drift from what is deployed.

**Apply order: AFTER 00570.** No dependency, just NNNNN order.

**NOT push-blocking.** No client reads the function; the view's output shape is
unchanged, so an old frontend against the new view is byte-identical.

**ONE DELIBERATE BEHAVIOUR CHANGE, and it is a fix.** The function is `STRICT`,
so a NULL `confidence_score` now yields NULL. The old inline CASE returned
`'reviewed'` for it — `NULL >= 0.9` is NULL, so every branch failed and it fell
to `ELSE`. A grade with no confidence recorded is not the same as one that
scored badly, and claiming "reviewed" on a public certificate for a row we never
scored is a statement we cannot support. The client already treats a missing
label as no badge.

**Verified from zero on a throwaway stack**: `node scripts/verify.mjs --db`
re-applied every migration. `src/test/confidence-label-view-parity.test.ts`
fails the build if a seventeenth revision pastes the CASE back, and also asserts
the historical revisions were left alone — applied migrations are immutable and
rewriting them is the other way this could have gone wrong.

**Run `NOTIFY pgrst, 'reload schema';`** after applying — the view was replaced.

**Rollback** is re-running 00534, which restores the inline CASE. The function
can stay; nothing else calls it.

## 🔴 HELD: 00570_headwear_neckwear_gloves_categories.sql (US-2223 + US-2224 — three taxonomy values)

**Risk: LOW.** Three `ALTER TYPE … ADD VALUE IF NOT EXISTS` and one type
comment. No table touched, no backfill, nothing rewritten. `item_category`
gains `headwear`; `garment_category` gains `neckwear` and `gloves`.

**Apply order: AFTER 00569.** No dependency, just NNNNN order.

**⚠️ PUSH-BLOCKING, and this is the classic case the held-migration rule exists
for.** The FRONTEND reads these enums directly: `GARMENT_CATEGORIES` and
`ITEM_CATEGORIES` in `src/lib/constants.ts` now list the new values, and both
drive pickers that write straight to the database under RLS. If Cloudflare
Pages deploys before the SQL applies, a seller who picks "Hats & caps" or
"Neckwear" gets `invalid input value for enum` and the save fails. Apply first,
then push.

**No transaction wrapper, deliberately, and do not add one.** Postgres refuses
to USE a new enum value in the same transaction that adds it. Nothing in this
file uses one — but wrapping it would make the file unsafe to extend, and the
next person appending an UPDATE would get an error that reads as a Postgres
quirk rather than as their own edit.

**Why headwear is its own item_category rather than living under
`accessories`.** `item_category` is the dimension that selects the grading
rubric, the photo profile AND the measurement template. A cap's condition lives
in the crown, the brim and the sweatband; an accessory's lives in its material,
its edges and its hardware. Filing headwear under accessories would have left
the headwear rubric permanently unreachable while looking correct — the same
class of silent deadness `rubric-parity_test.ts` was written to catch.

**`neckwear`, not `tie`.** One rubric grades a bow tie, an ascot and a cravat;
a value named for one of them invites a seller to pick "other" for the rest,
which routes them straight back into the clothing rubric this work exists to get
them out of.

**Verified on a throwaway stack**, not eyeballed: `node scripts/verify.mjs --db`
re-applied every migration from zero, so the SQL parses and the values land.

**Run `NOTIFY pgrst, 'reload schema';`** after applying — PostgREST caches enum
definitions and will reject the new values until it reloads.

**Rollback is NOT clean, and that is worth knowing before applying.** Postgres
cannot drop an enum value. Reverting means recreating the type without it, which
requires rewriting every column that uses it. In practice the rollback is to
leave the values in place (they are inert until something writes them) and roll
the frontend back.

## 🔴 HELD: 00569_community_benchmarks_filters.sql (US-2235 — filters on Community Insights)

**Risk: MEDIUM, and it is the DROP that carries it.** No table changes at all.
It drops `community_benchmarks(date)` and recreates it with five extra filter
parameters, all defaulting to null.

**⚠️ PUSH-BLOCKING, and in the unusual direction: the SQL must go FIRST.** The
new frontend calls the RPC with six named parameters. Against the old
one-argument function that is a hard PostgREST error, so Community Insights
would be blank for every seller between the push and the apply. The reverse
(new function, old frontend) is completely fine — the extra params default to
null and return exactly today's unfiltered snapshot.

**Why it drops instead of overloading, since a DROP always reads alarming.**
`CREATE OR REPLACE` cannot add parameters; it would create a SECOND function at
a different arity. Both would then accept a single named `p_period_start` (the
new one via its defaults), and PostgREST resolves by NAME — so every existing
one-argument call would become ambiguous and fail at runtime, in production, on
a path no local test covers. One function is the only safe end state.

**There is a gap of milliseconds where the function does not exist** (between
the DROP and the CREATE, inside the same transaction — the file is wrapped in
`BEGIN;`/`COMMIT;`, so concurrent callers block rather than error). Apply it
during a quiet moment anyway.

**The privacy property, because this is the one to review.** Filtering is the
classic way to break a k-anonymity guarantee: narrow until one seller is left,
then read their numbers off the "aggregate". The filters apply to the BASE row
set, so all fifteen existing `sellers >= min_sellers` guards re-evaluate against
the filtered cohort and return nulls. The floor is unchanged — read from
`system_settings.community_min_cohort_sellers`, hard-clamped to at least 5 in
SQL. A guard test (`src/test/community-benchmarks-k-anonymity.test.ts`) fails
the build if a filter ever moves downstream of the base CTE.

**Verified on a throwaway stack**, not just eyeballed: `node scripts/verify.mjs
--db` re-applied every migration from zero, so the SQL parses and the function
creates.

**Run `NOTIFY pgrst, 'reload schema';`** after applying — PostgREST caches
function signatures, and it will keep rejecting the new parameters until it
reloads. **This one is not optional.**

**Rollback** is re-running 00241, which restores the one-argument function. The
old frontend works against it; the new one does not, so roll the frontend back
too.

## 🔴 HELD: 00568_submission_image_quality_score.sql (US-2136 AC4 — keep the measured photo quality)

**Risk: LOW.** One nullable column on `submission_images` plus a range CHECK. No
backfill, no rewrite, no behaviour change until a client starts sending the
value.

**Apply order: AFTER 00567.** No dependency, just the NNNNN order.

**NOT push-blocking, but it IS write-blocking in one direction, so apply it
first anyway.** The frontend sends a new `quality_scores` FormData field and the
edge writes `quality_score` on every submission image. If the edge deploys
before the column exists, EVERY photo submission fails on the insert — the whole
grade, not just the metadata. Applying the SQL first makes that window
impossible. The reverse (column exists, old edge) is completely inert.

**NULL is a real value here, not a gap to backfill.** The score is measured in a
browser canvas that can legitimately fail, and older clients do not send one at
all. Every reader treats NULL as "not measured" and applies NO confidence cap.
Backfilling zeros would be actively wrong: zero means "we looked and it is
unreadable", which caps authenticity confidence on items nobody ever measured.

**What it turns on.** `applyVerdictCap` now slides the authenticity confidence
ceiling between `AUTHENTICITY_NO_MACRO_CONFIDENCE_CAP` (0.7) at quality 0 and no
cap at quality 0.5, using the best macro frame's measured sharpness. Before
this, a macro too soft to read a serial earned exactly the same confidence as a
crisp one. Pre-migration rows carry NULL and are unaffected.

**Run `NOTIFY pgrst, 'reload schema';`** after applying — a new column written
and selected by name through PostgREST.

**Rollback** is dropping the column. The only loss is the measurements
themselves, and every reader already handles their absence.

## 🔴 HELD: 00567_users_shipping_pii_edge_only.sql (US-2417 — the seller's address stops being plaintext)

**Risk: MEDIUM, and the ORDER matters more than the SQL does.** There is no DDL
at all: one `CREATE OR REPLACE FUNCTION` narrowing the users self-update
allowlist, plus two column comments. `business_phone` is already text and
`ship_from_address` is already jsonb — a jsonb column holds a JSON *string*
scalar, so the AES-GCM envelope fits the existing column and no table is
rewritten under a lock.

**Apply order: AFTER 00566. THEN redeploy the edge. THEN push.** That order is
not the usual boilerplate here, it is load-bearing:

1. **Apply the SQL.** The moment it lands, a browser can no longer write those
   two columns. The CURRENTLY DEPLOYED frontend still tries, so a seller saving
   Business & shipping details in that window gets an error naming the column.
   The window is minutes and nothing is corrupted; it is the cost of closing the
   write path before the new frontend exists.
2. **`NOTIFY pgrst, 'reload schema';`** — the function changed, not a table, but
   the guard runs on every self-update and a stale plan is not worth the risk.
3. **Redeploy the edge**, which brings up `PUT/GET /api/account/shipping-profile`.
4. **Then push**, which auto-deploys the frontend onto that route.

Pushing FIRST would deploy a frontend calling a route that does not exist yet —
every Settings save 404s.

**Run the backfill after the edge is up**, not before — it needs the same
`EDGE_ENCRYPTION_KEY` the edge runs with:

```
deno run --allow-net --allow-env scripts/backfill-user-shipping-pii.ts          # dry run
deno run --allow-net --allow-env scripts/backfill-user-shipping-pii.ts --apply
```

It is DRY-RUN BY DEFAULT, refuses to start without the key, and is safe to
re-run: an already-encrypted value passes through rather than being double
wrapped, which would be unrecoverable. **The read path tolerates both formats
(AC4)**, so there is no deadline on running it — an un-backfilled row renders,
it just is not protected yet.

**Rollback** is restating the guard function with the two column names put back
(00550's body) and leaving the ciphertext alone. Do NOT try to decrypt back to
plaintext: the read path already tolerates a mixed table, so the only thing a
rollback needs to restore is the write permission.

## 🔴 HELD: 00566_per_image_shadow.sql (US-2443 — per-image prompt changes get a live-traffic comparison)

**Risk: LOW, and it is INERT on arrival.** Six additive columns on
`grading_shadow_results` and three on `ai_prompt_block_versions`, one index, two
CHECK constraints. No backfill and no behaviour change: the new per-image shadow
path is OFF unless `PER_IMAGE_SHADOW_DAILY_VISION_CAP` is set to a positive
number, which it is not. Applying this migration alone changes nothing that runs.

**Apply order: AFTER 00564 and 00565.** No dependency between them, just the
NNNNN order the apply script uses.

**NOT push-blocking, and that is the difference from 00565.** Nothing in the
FRONTEND reads or writes any of these columns. The only readers are edge code
(`grading-shadow-per-image.ts`, and the admin `/shadow/comparison` +
`/shadow/results` endpoints, which now select `stage`, `tier_agreement`,
`per_factor_deltas`, `images_analyzed`, `vision_calls`). Those endpoints are
super-admin only, so the worst case if the edge deploys before the SQL applies
is an admin panel error on the Shadow tab, not a seller unable to work.

**`stage` defaults to `'composite'`, which is the correct backfill, not a
convenience.** Every row that exists today was written by the composite-only
path. A `NULL` default would have made "old row" and "unknown stage" the same
value.

**The cost columns are the point.** A composite shadow row is one cheap text
call, so nobody ever counted them. A per-image row is one paid VISION call per
photo plus one composite — six to eight for a normal submission. The daily
ceiling is enforced as a SUM over `vision_calls`, so the number has to be on
the row or the guardrail has nothing to read.

**`shadow_sample_rate` and `shadow_daily_cap` on `ai_prompt_block_versions`
default to 0 deliberately.** `ai_prompt_versions.shadow_daily_cap` defaults to
200; this one defaults to 0, because inheriting a sampling default is how a
vision bill arrives before anyone has read a comparison.

**Run `NOTIFY pgrst, 'reload schema';`** after applying — nine new columns
selected by name through PostgREST.

**To actually turn it on afterwards** (three switches, all off today): set
`PER_IMAGE_SHADOW_DAILY_VISION_CAP` on Coolify, then set a non-zero
`shadow_sample_rate` AND `shadow_daily_cap` on the candidate row, and mark it
`is_shadow = true` with `stage = 'per_image'`. Any one of those left at its
default means nothing is spent.

**Rollback** is dropping the nine columns. No data loss beyond shadow
comparison rows, which are advisory analytics and never reach a seller.

## 🔴 HELD: 00565_expense_recurrence.sql (US-2228 AC3 — an expense that repeats monthly)

**Risk: LOW.** Two columns on `flipdesk_expenses` (one boolean with a `false`
default, one nullable uuid), two partial indexes, one CHECK constraint. No
backfill. Every existing row reads as "does not recur", which is what it was.

**Apply AFTER 00564 and BEFORE the push.** `src/pages/flipdesk/expenses.tsx`
writes `recurs_monthly` on every save — including the plain add-an-expense path
— so once Cloudflare Pages auto-deploys, an insert against a database without
the column fails with 42703 and the seller cannot log ANY expense. This one is
push-blocking in a way 00564 is not.

**The CHECK constraint is the runaway guard.** `NOT (recurs_monthly AND
recurrence_source_id IS NOT NULL)` — a generated copy may never itself become a
template. Without it, one bad write gives the next run a second series to
extend, then four, and the table grows on its own.

**The unique index is the idempotency guard**, and it is why the cron carries no
"next occurrence" bookkeeping column. One entry per template per month, enforced
by the database, so the job can re-run, catch up after an outage, or race a
second instance and still converge.

**`ON DELETE SET NULL`, not CASCADE, and this is the decision worth reading.**
Deleting the template means "stop repeating this", NOT "erase the months it
already covered". Those months were really paid. A cascade would silently
rewrite a year of books from one Delete click.

**A new cron ships with this: `expense-recurrence`, `20 5 * * *`,
`POST /api/jobs/expense-recurrence`.** Add the Coolify scheduled task after the
edge deploy — `CRON_SETUP.md` has the generated block. Until it is added the
feature is inert: sellers can tick the box, and nothing copies forward.

**Run `NOTIFY pgrst, 'reload schema';`** after applying — two new columns
selected and written by name through PostgREST.

**Rollback** is dropping the two columns (the indexes and constraint go with
them) and removing the Coolify task. Generated entries stay as ordinary
expenses, which is correct: they were real.

**Verified:** `EXPECTED_SCHEMA_VERSION` bumped to `00565` in the same commit,
manifest regenerated (310 footer-era migrations), self-record footer present,
cron-registry drift guard green with COOLIFY.md / CRON_SETUP.md /
launch-checklist.md / deploy.md all regenerated.

---

## 🔴 HELD: 00564_expense_receipts.sql (US-2228 AC2 — the receipt behind the number)

**Risk: LOW.** Three nullable columns on `flipdesk_expenses` and one new PRIVATE
storage bucket. No backfill, no constraint, no index, no default. Nothing
existing is rewritten and no row changes. Old code that never mentions the
columns keeps working.

**Apply BEFORE the push, and the frontend is the reason.** `src/pages/flipdesk/
expenses.tsx` reads `e.receipt_path` off every row it lists, and Cloudflare
Pages auto-deploys on push. `select("*")` does not 42703 on a missing column —
it just returns rows without it — so the clip icon would silently never appear
and nobody would know why. The edge is the harder failure: `flipdesk-expenses.ts`
SELECTs `receipt_path, receipt_mime` by name, which PostgREST answers with 42703
until the columns exist.

**The bucket is the part that matters.** `expense-receipts` is created with
`public = false` and NO storage policies, i.e. deny-all to `anon` and
`authenticated`. Both directions go through the edge service-role client, which
does the ownership check itself. A receipt carries a card tail, a billing
address, sometimes a full name — this is deliberately not `item-photos`, the one
public bucket, whose contract is seller listing imagery only.

**If you apply the columns but not the bucket, uploads fail closed** with a
storage error and the row is left untouched (the route removes the orphan object
on a failed link and never writes a path it did not upload). Nothing corrupts;
the feature is simply unavailable.

**Run `NOTIFY pgrst, 'reload schema';`** after applying — three new columns
selected by name through PostgREST.

**Rollback** is `DROP COLUMN receipt_path, receipt_mime, receipt_uploaded_at`
plus `DELETE FROM storage.buckets WHERE id = 'expense-receipts'` (empty the
objects first). The screen degrades to what it was: an expense list with no
attachment.

**PDFs are stored byte-for-byte and are NOT metadata-stripped.** There is no PDF
parser in the edge, and `stripImageMetadata` only knows JPEG/PNG/WebP. That is
acceptable only because the bucket is private, signed-URL-only (TTL 900s), never
published, and never sent to a model — the same file the seller uploaded comes
back to the seller and to nobody else. Image receipts ARE stripped, on the normal
`validateImageUpload` → `stripImageMetadata` path.

**Apply order.** Last, after 00563. It depends on nothing but the
`flipdesk_expenses` table (00019) and `storage.buckets`.

**Verified:** `EXPECTED_SCHEMA_VERSION` bumped to `00564` in the same commit,
manifest regenerated, self-record footer present, full edge suite green.

---

## ✅ APPLIED: 00563_prompt_block_versions.sql (US-2438 — a versioned seam for the grading user message, applied 2026-08-08 — MEASURED)

**Applied and confirmed by measurement, not by report.** `GET https://functions.gradethread.com/health/ready` returns `schema: {expected: "00563", applied: "00563", status: "match"}` — the DB's own answer, read through the service-role client (US-1566), and the edge has already been redeployed on the matching build. Nothing below is outstanding; it is kept for the next reader.

**Risk: LOW.** One new table, ONE RLS policy, three indexes. Nothing existing is
altered, nothing is dropped, no row is rewritten, and no backfill runs. The table
ships EMPTY and stays empty until somebody inserts a row.

**Admins can SELECT; nobody can write except the service role.** An earlier draft
of this file said "four RLS policies" — that draft copied `ai_prompt_versions`'
original 00003 grants, including admin INSERT/UPDATE/DELETE, which migration
00510 had deliberately REVOKED (US-2348: those grants let the admin SPA write the
table directly and so reach around the scope guard, the MFA step-up, the audit
row and the eval gate). On a table holding live grading prompt text that would
have let an admin with a revoked scope move every grade the platform issues. The
file now creates the SELECT policy only, plus three `DROP POLICY IF EXISTS` lines
so re-running the directory converges on that posture even if an intermediate
draft was ever applied by hand.

**An empty table is the no-op state, and that is measured.** The edge reads
`ai_prompt_block_versions` once per grading stage — per-image and composite —
and zero live rows resolves every prompt block to the code constant it has always
used. `unversionedPromptSurfaceHash()` is `baf5d4cb` both before and after every
commit in this batch, so applying this migration cannot move a single grading
prompt.

**Apply order.** Last, after 00562. It depends on nothing but `is_admin()`,
which has existed since 00003.

**It is safe in BOTH orders, so it is not push-blocking on its own.** If the edge
deploys before the SQL runs, the table is missing, the query errors, and
`loadBlockRows` catches it and returns an empty set — i.e. exactly the code
defaults. That path is deliberate (it also covers a DB blip), so a grading call
against a missing table degrades to the prompt that shipped rather than failing.
The reverse order is the normal one and is fine.

**No frontend caller.** Nothing in `src/` reads the table, so a Cloudflare Pages
auto-deploy landing ahead of the SQL cannot 404 a page.

**Run `NOTIFY pgrst, 'reload schema';` after applying** — a new table means
PostgREST needs to see it, and until it does the edge takes the degraded path
above (correct, but it would look like overrides silently not working).

**Rollback** is `DROP TABLE public.ai_prompt_block_versions;`. Nothing else
references it and the edge falls back to code defaults the moment it is gone.

---

**00564 through 00572 are held** — see the top of this file. Everything below it is applied:
00542 through 00563 went to prod on 2026-08-08 and were
confirmed by the owner, and the measurement agrees: `/health/ready` on
`functions.gradethread.com` reports `applied: 00563`. See the note under 00528
for how that is measured and why the measurement, not this file, is the
authority whenever the two disagree.

The running edge container has since caught up: as of 2026-08-09 01:00 UTC it
reports `expected: 00563` against `applied: 00563`, `status: "match"`. An earlier
version of this paragraph recorded a `status: "ahead"` while the image lagged at
00561; that is history now. DB-ahead-of-code remains the safe direction — the
boot guard refuses the reverse — so a lag here is never an incident, only a
pending deploy.

## ✅ APPLIED: 00562_grade_prompt_surface_hash.sql (US-2432 — say which prompt surface graded a row, applied 2026-08-08 — owner-confirmed)

**Risk: LOW, and it is the safest shape in this file.** One nullable `text`
column added to `grade_reports`, plus a column comment. That is the whole
migration. No existing column changes type, no row is rewritten, no constraint is
added, and nothing is dropped. `ADD COLUMN` of a nullable column with no default
does not rewrite the table, so it takes a brief lock and returns.

**It builds no index, and that is the point.** The draft carried a partial btree
on the non-null rows. A non-`CONCURRENT` `CREATE INDEX` takes a `SHARE` lock and
scans the whole table — and a partial `WHERE` limits what gets STORED, not what
gets SCANNED — so it would block new grade inserts, meaning paid work, for the
length of a full scan of `grade_reports`. What that buys is a rarely-run operator
analysis query that already has a `created_at` filter to ride. Removed. If one of
those queries ever proves slow, add it `CONCURRENTLY`, outside a transaction.

**Apply order.** Last, after 00561. It depends on nothing but `grade_reports`.

**Rollback** is `DROP COLUMN prompt_surface_hash` (the index goes with it).
Nothing reads it yet outside the write itself.

**No frontend caller — this one is NOT push-order-sensitive.** Unlike 00560,
nothing in `src/` selects the column, so a push landing ahead of the SQL cannot
404 a page. Apply it whenever is convenient before the next edge deploy.

**The edge code is deliberately safe in BOTH orders.** `grading-pipeline.ts`
adds the value by conditional SPREAD, not as a plain key — a null-valued key
still NAMES the column in the PostgREST payload, which 42703s the whole insert
and takes a *paid grade* down with it on any environment where the SQL has not
landed. So the edge can deploy first without risk; it just records nothing until
the column exists. Pinned by a test in `unversioned-prompt-surface_test.ts`.

**`NOTIFY pgrst, 'reload schema';` IS required** — PostgREST caches the column
list, and the edge writes through PostgREST. Without the notify the insert keeps
42703-ing on the new column even after the SQL applies, which is the same
paid-grade failure the spread is there to avoid.

**What it does.** Stores an 8-hex digest of the assembled grading USER message on
every new grade. `prompt_version` names the composite system prompt and which
dynamic blocks were switched on; it says nothing about the CONTENT those blocks
held, so editing the text inside `FABRIC_CRITERIA` left before and after
reporting the same era. This column splits them.

**NULL on every historical row, and there is no backfill.** The surface those
grades ran under is not recoverable from the row, and stamping today's hash on
them would assert an era they never had. Absent means unknown.

## ✅ APPLIED: 00560_listing_performance_rpcs.sql (US-2233 — server-side KPIs + paged search, applied 2026-08-08 — owner-confirmed)

**APPLY BEFORE THE PUSH, and this is the strict direction.** The frontend
change in the same commit calls both functions through `supabase.rpc()`, and
Cloudflare Pages auto-deploys the frontend the moment the branch is pushed.
If the SQL is not in yet, Listing Performance calls an RPC PostgREST has not
published and gets a 404 that reads as a bug in the page.

(An earlier draft of this entry said DO NOT APPLY YET, on the grounds that the
caller did not exist. It does now — the page was wired in the same session.
Left visible rather than rewritten silently, because the two instructions are
opposites and a reader who saw the first one needs to know it changed.)

**Risk: LOW, and lower than most.** It adds two functions and touches no table,
no column, no index and no row. Both are `LANGUAGE sql STABLE` and, critically,
**SECURITY INVOKER** (the default) — they run as the CALLING role, so the
existing RLS on `listings` and `inventory_items` is what scopes them. There is
no tenant filter inside them to get wrong.

**Apply order.** Last, after 00559. No dependency on it beyond both being later
than the tables they read.

**Rollback** is `DROP FUNCTION` on both signatures. Nothing else changes.

**What it does.** `flipdesk_listing_performance_summary()` returns the four
header/KPI figures (count, total views, average CTR, stale count, last synced)
across every active eBay listing the caller can see.
`flipdesk_listing_performance_page(...)` returns ONE searched, sorted, paged
page, with `total_count` riding on each row so the caller gets the page and the
page count in a single round trip. Today the page loads every active listing
into the browser and does all three client-side.

**Why the seller-visible behaviour improves, not just the performance:** the
title fallback (blank `listing_title` → the inventory item's title) moves into
the query, so SEARCH now covers it. Client-side search matched `listing_title`
only, and silently missed every listing whose displayed title came from the
item. The `ILIKE` pattern is escaped, so searching for a title containing `%`
or `_` matches literally instead of wildcarding.

**Contains a `DROP FUNCTION IF EXISTS` on the summary, deliberately.**
`CREATE OR REPLACE` cannot change a function's return type, and this one gained
`last_synced_at` while it was being written. Dropping by full signature first is
what keeps the file re-runnable against a database holding either shape — which
is what rule 1 has to mean here. Verified by applying it twice in a row.

**`NOTIFY pgrst, 'reload schema';` is REQUIRED.** PostgREST will not expose a
new RPC until it reloads, and the frontend calls both through `supabase.rpc()`.
Without the notify the page gets a 404 from PostgREST that looks like a bug in
the page.

**Verified on a throwaway local stack**, not by reading: applied from a clean
state and then re-applied (idempotent); `prosecdef = false` on both; `anon` has
no EXECUTE and `authenticated`/`service_role` do; and behaviourally, with two
seeded sellers, seller A's results never included seller B's listing, the title
fallback resolved, a search for `50%` matched the literal percent sign,
the no-view window filtered, `total_count` was right under `limit 1 offset 1`,
an unknown sort key fell back instead of erroring, and a title sort ordered by
title rather than by views.

**00542–00557 used to be numbered 00539–00554.** The ADE hub loop ran against
the same backlog and landed its own 00539, 00540 and 00541, and those went to
prod first. An applied number is immutable, so the three the hub burned stayed
with the hub and the sixteen here moved up by three. Nothing in them changed
except the number — same SQL, same order, same risk.

## ✅ APPLIED: 00559_billing_environment_marker.sql (US-2286 — mark which store environment paid, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, after 00558. It depends on 00558 only in the loose sense
that both touch `public.users`; there is no ordering hazard between them.

**Risk: LOW.** Three nullable columns with no default and no backfill, two
CHECK constraints, two partial indexes on the sandbox side only. Nothing is
rewritten and no existing row changes. The columns are additive, so old edge
code that never mentions them keeps working unchanged.

**Apply BEFORE the edge deploy.** This is the strict direction. The new edge
writes `billing_environment` / `buyer_billing_environment` on every Apple and
Play entitlement grant, and `environment` on the Play consumable ledger. If the
edge deploys first, every in-app-purchase grant fails with PGRST204 ("column
does not exist") and paying customers get nothing. The frontend does not read
these columns, so a Cloudflare Pages auto-deploy is harmless on its own.

**What it does.** Apple's verifier falls back Production → Sandbox, and that
fallback is correct and stays: App Review always exercises IAP in the sandbox,
so refusing Sandbox JWS fails review. The defect was that the resulting grant
carried no marker — a sandbox-granted Business Yearly was byte-identical on the
users row to one somebody paid for, so it was indistinguishable in revenue
reporting, plan-distribution metrics, the expiry sweeps and any manual "why is
this account on Pro" check. Google has the same gap through licence-tester
purchases, whose signal both Play response parsers were dropping at parse time.

Nullable with three states on purpose: `production`, `sandbox`, and NULL
meaning "granted before the marker existed". `countsAsRevenue()` treats NULL as
revenue, because defaulting the past to sandbox would zero out historical MRR
the first time a revenue query used the column.

**Deliberately NOT included.** `appstore_processed_transactions` is written
only through the SECURITY DEFINER RPC `grant_appstore_credits`, so stamping it
needs a signature change and is its own migration. The revenue-query exclusion
(`revenue_dashboard`, `admin_revenue_metrics`) is also separate — you cannot
exclude what you have not marked, so the marker ships first.

**Operator follow-up (AC5, not shippable from here):** audit prod for existing
entitlements granted from a sandbox purchase. They are NULL after this
migration, so they need the store-side purchase history to identify.

**After applying:** `NOTIFY pgrst, 'reload schema';` — new columns, so
PostgREST must re-read or every write to them 404s at the schema cache.

## ✅ APPLIED: 00558_billing_source_googleplay.sql (US-2287 — Play subscriptions are being rejected, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, after 00557. It only touches a CHECK constraint on
`public.users` created by 00104, so it is independent of the rest of the held
tail and could be applied first if Play billing needs unblocking sooner.

**Risk: LOW, and it is a FIX FOR A LIVE OUTAGE rather than a new feature.** One
constraint dropped and re-added with a third allowed value. No column, no data,
no backfill. The re-add can only fail if a row already holds a value outside
the widened set, which is impossible — the old constraint is stricter.

**Apply BEFORE the edge deploy is not the urgent direction here — apply it as
soon as convenient.** The edge already writes `billing_source='googleplay'`
today and that write is *already failing* with 23514. Applying this makes the
existing code start working; it does not create a new dependency. There is no
window in which the old code breaks against the new schema.

**What it does.** 00104 created `users_billing_source_chk` allowing only
`('stripe','appstore')` and nothing ever widened it, while
`lib/google-play/products.ts` stamps `billing_source='googleplay'` on every
Play subscription grant. So every Play grant UPDATE was rejected: **the customer
is charged by Google and receives no entitlement**, and the Play expiry sweep
can never match a row because no row can hold the value it filters on. Three
sibling constraints WERE widened for Play (00354, 00414, 00486), which is why
grepping the corpus for `googleplay` looks reassuring.

The migration uses `DROP CONSTRAINT IF EXISTS` then `ADD CONSTRAINT` rather
than 00104's `IF NOT EXISTS` probe on purpose — the probe is what let the stale
definition survive every subsequent apply.

**Operator follow-up (AC1/AC4, not shippable from here):** check prod for
customers who paid Google and were never entitled, and grant retroactively.
Play purchase tokens are recorded even though the users-row grant failed, so
the affected set is recoverable rather than lost.

**After applying:** `NOTIFY pgrst, 'reload schema';` — a constraint change, so
PostgREST should re-read.

## ✅ APPLIED: 00557_loyalty_tenure.sql (US-1914 — tenure tiers & anniversary grants, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, after 00556. It rewrites CHECK constraints owned by
00544 (`reward_milestones.trigger_type`) and 00549
(`reward_nudge_sends.nudge_type`), so both must already be applied — which
numeric order gives you, as long as the whole held tail goes in sequence.

**Risk: LOW.** Two new tables, one trigger function, two re-stated CHECKs that
only ADD an allowed value, and two seed rows behind `ON CONFLICT DO NOTHING`.
Nothing is dropped and nothing is backfilled — tenure derives from
`users.created_at`, which every row already has.

**Apply BEFORE the edge deploy.** `rewards-loyalty.ts` reads and writes
`user_loyalty_state` on the rewards read path, and the anniversary grant writes
`trigger_type = 'anniversary'` and the comeback nudge writes its new
`nudge_type`. Until this applies, those inserts are rejected by the old CHECKs
and the Rewards screen falls back to its error state.

**What it does.**
- `reward_tenure_tiers` — the operator-editable ladder, seeded. `rank` is stored
  rather than re-derived from `min_months`, so an operator editing a threshold
  cannot move anyone down.
- `user_loyalty_state` — one row per user: `member_since`, the `tier_rank_peak`
  high-water mark, and the anniversary bookkeeping. Read-own RLS, plus a
  `seed_user_loyalty_state()` trigger so the row exists before it is needed.
- Adds `'anniversary'` to `reward_milestones.trigger_type` and seeds the
  `anniversary_gift` milestone, so anniversary payouts ride the existing
  US-1853 grant rail (claim-before-pay, USD ceilings, velocity limit) instead of
  a second one.
- Adds the comeback nudge type to `reward_nudge_sends`.

There is deliberately no decay, lapse or reset column anywhere in the file —
that promise is kept in the schema or not at all.

**After applying:** `NOTIFY pgrst, 'reload schema';` — two new tables and two
changed constraints, so PostgREST has to re-read the schema.

## ✅ APPLIED: 00556_badge_click_variant.sql (US-1913 — plain vs status badge clicks, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00404, which creates `badge_click_events`. Long applied,
so in practice: anywhere in the held tail, and it is independent of 00555.

**Risk: LOW.** One additive text column with a default and a CHECK, on an
append-only analytics table. Nothing is dropped, modified or backfilled beyond
the column default.

**Apply BEFORE the edge deploy.** `recordBadgeClick` now writes
`badge_variant` on every insert. Until the column exists that insert fails, and
badge-click attribution stops recording entirely — silently, because the whole
path is best-effort and swallows its errors. The seller funnel would just go
flat.

**What it does.** Adds `badge_click_events.badge_variant` (NOT NULL DEFAULT
`'plain'`, CHECK over `plain | status`). Every existing row reads `plain`, which
is accurate: before US-1913 there was no other badge format.

## ✅ APPLIED: 00555_seller_integrity_tier.sql (US-1912 — seller Grade Integrity tier, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00443 (which owns the `reputation_events` event-type
allow-list this re-states) and after 00421 (which creates
`seller_grade_integrity`). Both are long applied, so in practice: anywhere in the
held tail.

**Risk: LOW.** Additive columns with defaults on a table that is small by
construction (one row per seller who has a buyer outcome), plus one enum value
and one re-stated CHECK constraint. Nothing is dropped or backfilled.

**Apply BEFORE the edge deploy AND before the frontend push.** Three reasons, and
the first is the one that bites:

- The recompute (`recomputeSellerGradeIntegrity`) now writes `tier`,
  `tier_displayable`, `avg_coverage_pct`, `graded_volume`, `tenure_days`. Until
  the columns exist that upsert fails, so a buyer confirming an arrival stops
  refreshing the seller's standing entirely.
- The edge writes `notification_type = 'integrity_tier_change'` on a demotion
  and `reputation_events.event_type = 'integrity_tier_up'` on a promotion. Both
  are rejected by the CHECK/enum until this applies.
- `GET /api/rewards/state`, the public seller profile and the public certificate
  all SELECT the new columns. They degrade to no badge rather than erroring, but
  the seller's own Rewards screen would show "building history" to everyone.

**What it does.**
- Adds `seller_grade_integrity.tier` (NOT NULL DEFAULT `'building'`, CHECK over
  the five tiers), `tier_displayable` (NOT NULL DEFAULT false),
  `avg_coverage_pct` (nullable, 0–100 CHECK), `graded_volume` (NOT NULL DEFAULT
  0), `tenure_days` (nullable), `previous_tier` (nullable, same CHECK) and
  `tier_changed_at`.
- Adds a partial index on the displayable rows (the only ones a public read
  wants).
- Re-states `reputation_events_event_type_check` in full, adding
  `'integrity_tier_up'`. There is deliberately no `'integrity_tier_down'`.
- `ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS
  'integrity_tier_change'`.

**Existing rows read as unranked, which is correct.** Every current
`seller_grade_integrity` row gets `tier='building'`, `tier_displayable=false`, so
nobody is granted a public rank by the migration itself. The first recompute
after a buyer outcome computes their real tier — and because `previous_tier`
starts effectively at `building`, crossing the floor registers as a promotion and
pays once.

## ✅ APPLIED: 00554_radar_activity_by_day.sql (US-1865 — Thrift Radar weekly activity pattern, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00552 — it adds a column to `radar_venue_aggregates`,
which that migration creates.

**Risk: LOW.** One additive column with a default and a cardinality CHECK on an
empty-in-prod table. Nothing is dropped, modified or backfilled.

**Apply BEFORE the edge deploy, not after.** The aggregation job's upsert now
includes `dow_counts` in its payload, so until the column exists every
`/api/jobs/radar-aggregate` run fails on the write and publishes no aggregates
at all — the map goes empty rather than degrading. The read path
(`GET /api/flipdesk/radar/venues*`) also selects the column, so it 500s the same
way. Both are Radar-only; nothing outside Radar touches this table.

**What it does.**
- Adds `radar_venue_aggregates.dow_counts integer[] NOT NULL DEFAULT
  ARRAY[0,0,0,0,0,0,0]` — scans per day of the week at the venue's approximate
  local day, array position 1 = Sunday.
- Adds `radar_venue_aggregates_dow_counts_len CHECK (cardinality(dow_counts) = 7)`.

**Why it rides the existing row.** The weekly pattern inherits the k-anonymity
floor, the hourly recompute and the sweep from the aggregate it is a column of.
A separate table would have meant a second copy of each guard, and a copied
privacy guard is one that goes stale on one side —
`vault/20-domain/thrift-radar.md` rule 6.

**No backfill, deliberately.** The job rewrites every servable row each run and
deletes what it did not rewrite, so the all-zero default is replaced within the
hour. A row still holding zeros renders as "no pattern yet" rather than as a
claim that the store is quiet every day.

## ✅ APPLIED: 00553_radar_personal_stores.sql (US-1864 — Thrift Radar personal store history, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00551 — both new objects reference `radar_venues`
(`sources.radar_venue_id` and `radar_personal_scans.venue_id` are foreign keys to
it), so applying this first fails on a missing relation.

**Risk: LOW.** One nullable column on an existing table, one new table, two
indexes, two RLS policies. Nothing existing is modified or dropped, no data is
backfilled, and the new table starts empty.

**⚠️ THE SPA READS THE NEW COLUMN — apply BEFORE the frontend deploy.** Unlike
00550–00552 this story is NOT server-only. `useSources()` selects `*` from
`sources`, so the column arrives for free once applied; but the new "My stores"
tab reads `sources.radar_venue_id` to decide which venues are still unlinked, and
`POST /api/flipdesk/radar/my-stores/link` writes it. Deploying the SPA first
leaves that tab erroring on every link attempt.

**What breaks if it stays unapplied.**
- `GET /api/flipdesk/radar/my-stores` returns 500 ("Failed to load your store
  history") on the `sources` read, because the selected column does not exist.
  The whole Sourcing → My stores tab shows its error card.
- `POST /api/flipdesk/radar/my-stores/link` returns 500 on the update.
- Every Prospect scan carrying a coordinate logs one warning
  (`radar.personal.insert`) and continues. The scan result itself is unaffected —
  the personal write is fire-and-forget (rule 8), like the contribution beside it.
- Radar contributions are otherwise unchanged: `radar_scan_events` still fills
  normally, so nothing already shipped regresses.

**What it does.**
- Adds `sources.radar_venue_id` (nullable, `REFERENCES radar_venues(id) ON DELETE
  SET NULL`) — the join that lets a named source's money meet a shared venue's
  visits. SET NULL rather than CASCADE on purpose: a merged-away venue must never
  take a reseller's own source row with it.
- Adds `radar_personal_scans` — the reseller's OWN visit log. It cannot be derived
  from `radar_scan_events`, which deliberately has no account column, so the
  personal layer needs its own store. Carries a plain `user_id`, a `venue_id`
  and/or a coarse `geohash`, the brand/category, grade band and verdict.
- **No coordinate column, and the same CHECKs as 00550** (`geohash` 4–7 chars of
  base32; at least one of venue/cell present). "Their own data" is the reason to
  be more careful, not less — these rows are not pseudonymised the way a
  contribution is, so a coordinate column here would be a movement trail of a
  named person.
- RLS: owner SELECT + owner DELETE (`(select auth.uid()) = user_id`), and NO
  insert/update policy — writes are service-role only.

**`NOTIFY pgrst, 'reload schema';`** — required. One new table AND a new column
on an existing table the SPA selects.

**Exercised** against a throwaway local stack via `npm run verify:db` (Docker),
not against prod.

## ✅ APPLIED: 00552_radar_aggregates.sql (US-1863 — Thrift Radar aggregates + retention archive, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00551 — `radar_venue_aggregates.venue_id` is a foreign key
to `radar_venues`, so applying this first fails on a missing relation.

**Risk: LOW.** Two new tables, one new config row. Nothing existing is modified
or dropped, and both new tables start empty.

**No client reads or writes anything new.** Both tables are service-role only
(deny-all RLS, `REVOKE ALL` from anon/authenticated) and are reached solely
through the new `/api/flipdesk/radar/*` endpoints. The web SPA and iOS are
untouched by this story, so pushing before the apply is safe from the
frontend's point of view.

**What breaks if it stays unapplied.**
- `/api/jobs/radar-aggregate` (new hourly cron) returns 500 on every run and
  records an error in `cron_runs`. Nothing else depends on it, and there is
  nothing to lose: the aggregates are recomputed from scratch on the first run
  after the apply. If the noise is unwanted, leave the Coolify scheduled task
  switched off until the SQL is applied.
- `GET /api/flipdesk/radar/venues*` returns 500 ("Failed to load Radar
  aggregates"). Nothing in the SPA calls it yet — the map surface is a later
  story — so no user-facing screen breaks.
- `radar_scan_events` simply keeps accumulating; retention pruning is what this
  migration enables, not something it interrupts.

**What it does.**
- Adds `radar_venue_aggregates` — venue × window (`7d`/`30d`/`90d`) × brand
  (`'*'` = the venue total). Scan count, DISTINCT contributor count, band-derived
  `avg_grade` plus the band mix, buy-verdict rate, `last_activity_at`, and a
  `computed_at` stamp the job sweeps stale rows by. Unique on
  `(venue_id, window_key, brand_key)`.
- **`contributor_count` carries a CHECK of `>= 2`** — the schema-level half of
  the k-anonymity floor. The table cannot hold a single-contributor aggregate.
  `radar_privacy.k_anonymity_floor` (default 3) may raise the effective floor
  above it, never below.
- Adds `radar_scan_history` — month-resolution archive of pruned scan events,
  keyed by a generated `place_key` (the venue id, or `cell:<geohash>` when the
  event never resolved to a venue) plus `month_start`. Deliberately has NO
  foreign key to `radar_venues`, so the archive outlives a venue row.
- Seeds `system_settings.radar_aggregation` (job tuning only — the floor and the
  retention window stay in `radar_privacy`, because lowering either is a policy
  change rather than tuning).

**`NOTIFY pgrst, 'reload schema';`** — required. Two new tables.

**Exercised** against a throwaway local stack via `npm run verify:db` (Docker),
not against prod.

## ✅ APPLIED: 00551_radar_venues.sql (US-1862 — Thrift Radar venue registry, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00550, which created `radar_scan_events` — this migration
adds the foreign key from that table's `venue_id` column to the new
`radar_venues`, so applying it first fails on a missing relation.

**Risk: LOW.** One new table, one new FK on a column that already exists and is
empty in prod, one config row. Nothing existing is modified or dropped.

**No client reads or writes anything new.** `radar_venues` is service-role only
(deny-all RLS, `REVOKE ALL` from anon/authenticated). The web SPA and iOS are
untouched by this story, so pushing before the apply is safe from the frontend's
point of view.

**What breaks if it stays unapplied.** Nothing user-facing. `resolveScanVenue`
selects from `radar_venues`, gets a PostgREST "relation does not exist" error,
logs it at warn and returns null — the contribution still lands with its geohash
cell, which is the state `radar_scan_events_located` was written to allow. That
is the pre-US-1862 behaviour, so the scan the user is waiting on is unaffected
(rule 8, fire-and-forget).

**What it does.**
- Adds `radar_venues` — display name, chain tag (goodwill / savers /
  salvation_army / value_village / other), centroid `lat`/`lng` plus a
  `centroid_source` saying whether that centroid came from a geohash cell centre
  (the only thing scan data may produce), a person, or a future Places
  enrichment. Status candidate / confirmed / merged, with `merged_into_id`
  naming the survivor so a merged id never dangles.
- Partial unique index on `(geohash, chain) WHERE status <> 'merged'` — this is
  what makes later scans converge onto one candidate instead of each minting
  their own, and what makes two concurrent scans safe.
- Adds the FK `radar_scan_events.venue_id → radar_venues(id) ON DELETE SET NULL`
  (guarded by a `pg_constraint` existence check, so re-running is safe).
- Adds the `radar_venues` config row (resolution kill-switch, match radius, merge
  radius, confirm threshold). Separate from `radar_privacy` on purpose: those are
  privacy parameters, these are tuning, and the k-anonymity floor must not sit in
  a row people feel free to edit.

**`NOTIFY pgrst, 'reload schema';`** — a new table and a new constraint.

**Rollback.** Safe to leave in place. Nothing reads the table except the edge's
resolver, which degrades to "unresolved" without it.

## ✅ APPLIED: 00550_radar_scan_events.sql (US-1861 — Thrift Radar consent + events, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It touches `public.users`,
`public.system_settings` and `public.applied_migrations` — all long applied — so
it has no dependency on 00530–00549 beyond the numeric sequence.

**Risk: LOW.** One new column with a `false` default, one new table, one config
row. Nothing existing is modified or dropped, and no behaviour changes on apply:
contribution is off for every user until they turn it on.

**⚠️ APPLY BEFORE PUSH — the frontend reads the new column from the client.**
The Settings → FlipDesk tab renders a "Contribute to Thrift Radar" card that
selects and updates `users.radar_contribute` through PostgREST. Cloudflare Pages
auto-deploys the frontend on push, so if the SQL has not been applied the card
errors on save for every user who touches it. Run the SQL, then
`NOTIFY pgrst, 'reload schema';` (a new column on `users` — PostgREST caches the
schema), then push.

**What it does.**
- Adds `users.radar_contribute boolean NOT NULL DEFAULT false` — the contribution
  consent. A NEW toggle on purpose: it is never folded into
  `share_sale_outcomes` or the analytics switch.
- Adds `radar_scan_events` — anonymized contributions. No coordinate column and
  no account column: a salted, weekly-rotating `contributor_key` plus a geohash
  cell capped at 7 characters by a CHECK. Deny-all RLS, service-role writes only;
  registered in both `SERVICE_ROLE_ONLY` and `SERVICE_ONLY_FORCED` in
  `rls-guard_test.ts` because a table with no owner column is never discovered.
- Adds the `radar_privacy` config row (kill-switch, cell precision, key rotation,
  k-anonymity floor, raw-event retention).

**Rollback.** Safe to leave in place; the edge only writes to the new table when
`radar_privacy.contribution_enabled` is true AND a user has opted in. To stop all
contribution without a deploy, set that key's `value` to
`{"contribution_enabled": false, ...}`.

## ✅ APPLIED: 00549_reward_nudges.sql (US-1859 — re-engagement nudges, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It references `public.users`,
`public.system_settings` and the `notification_type` enum (00007) — all long
applied — so it has no dependency on 00530–00548 beyond the numeric sequence.

**Risk: LOW.** One new table, one new enum VALUE, one config row, and a new
DEFAULT on an existing column. No existing column, row, view or policy is
modified or dropped, and no notification is sent on apply: the cron has to be
registered in Coolify separately.

**What it does.**
- Adds `reward_nudge_sends` — one row per nudge DECISION, including the
  deterministic holdout slice that is deliberately not sent. Service-role only,
  deny-all RLS. `UNIQUE (user_id, nudge_type, subject_key, period_key)` is both
  the idempotency guarantee and the per-subject frequency cap.
- Adds `'reward_nudge'` to `notification_type`. `ALTER TYPE ... ADD VALUE` is
  transactional in PG 12+ and the value is not USED in this migration, so it is
  safe either way. **The edge must not be rolled back past this migration while
  a `reward_nudge` notification row exists** — an older build's `NotificationType`
  union does not know the value, and the frontend catalog would render it as a
  bare slug.
- Moves `users.notification_preferences`'s DEFAULT onto the set that includes
  `reward_nudges`. EXISTING rows are untouched, which is correct: the engine
  reads the category with an opt-OUT default (absence ⇒ enabled), the same model
  every other category uses, so a pre-existing user needs no backfill.
- Seeds `system_settings.reward_nudges_config` (kill-switch, per-type switches,
  frequency cap, holdout share, attribution window).

**After applying,** register the `reward-nudges` cron in Coolify
(`0 15 * * *` → `POST /api/jobs/reward-nudges`) — see CRON_SETUP.md. Until it is
registered nothing sends, which is a safe state, not a broken one.

## ✅ APPLIED: 00548_reward_economics_guardrails.sql (US-1858 — reward budget guardrails, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It references `public.users`,
`public.system_settings` and the `abuse_signal_type` enum (00212) — all long
applied — so it has no dependency on 00530–00547 beyond the numeric sequence.

**Risk: LOW.** One new table, one new enum VALUE, one config row. No existing
column, row, view or policy is modified or dropped, and nothing is granted on
apply: the guardrails only narrow a budget that is already gated by the
`rewards_tangible` kill-switch, which stays off.

**What it does.**
- Adds `reward_budget_breaches` — one row per reward ceiling that refused a
  grant, suppressed while OPEN (two partial UNIQUE indexes: one platform-wide
  per scope, one per scope+account). Service-role only, deny-all RLS.
- Adds `'reward_farming'` to `abuse_signal_type`. `ALTER TYPE ... ADD VALUE` is
  transactional in PG 12+ and the value is not USED in this migration, so it is
  safe either way. **The edge must not be rolled back past this migration while
  a `reward_farming` row exists** — an older build's `SIGNAL_TYPES` set does not
  know the value and would filter those signals out of the safety console
  (silently; nothing errors).
- Seeds `system_settings.rewards_economics_guardrails` (margin floor, free-tier
  allowance, daily velocity limits, auto-pause and fraud-hold switches).

## ✅ APPLIED: 00547_reward_leaderboards.sql (US-1856 — public reward leaderboards, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It touches `users` and `referral_events`
(both long applied) and adds an index on `showcase_reactions`, which arrives in
**00546** — so 00546 MUST be applied first, or the second `CREATE INDEX` fails on
a missing table.

**Risk: LOW.** Two nullable-or-defaulted columns on `users` and three indexes. No
existing column, row, view, policy or enum is modified or dropped, and nothing
becomes public on apply (the opt-in defaults to false).

**What it does.**
- Adds `users.leaderboard_opt_in` (NOT NULL DEFAULT false) and
  `users.leaderboard_alias` — the opt-in and public alias for the reward
  leaderboards. A THIRD toggle beside the referral board's (00195) and the buyer
  board's (00423) on purpose: those boards' copy names a referral count and a
  confirmation count, and these publish XP, graded volume and reactions. The
  default is false, so nobody appears until they choose to.
- Adds `idx_users_leaderboard_opt_in` (partial, the small public cohort),
  `idx_showcase_reactions_report_user` (the finds board excludes a seller's
  reaction to their own find, so it reads reactions by report AND reactor) and
  `idx_referral_events_granted_at` (partial, the weekly share-driven-signups
  board filters on when a referral was granted).

**Deploy order.** Apply BEFORE the edge rolls (the normal order). The edge build
that ships with it serves `/api/content/public/leaderboards.json` and
`/api/rewards/leaderboard`, both of which read the new columns; against a DB
without this migration those routes 500 (and the leaderboards page renders
empty). Nothing EXISTING breaks either way — the columns are additive and no
current query reads them.

**Client-side reads?** No. The SPA reads the boards from the edge
(`/api/content/public/leaderboards.json`) and its own standing from
`/api/rewards/leaderboard`; it never queries `users.leaderboard_*` directly. The
new columns are added to the frontend `Database` type for completeness only.

## ✅ APPLIED: 00546_showcase_finds.sql (US-1855 — public Showcase / "Finds" feed, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It needs `submissions`, `grade_reports`
and `users` (all long applied), so it depends on none of the other held
migrations and could go first if 00530–00545 slip.

**Risk: LOW.** Three nullable-or-defaulted columns on `submissions`, one new
table, one new view, three indexes and one CHECK constraint. No existing column,
row, view or enum is modified or dropped.

**What it does.**
- Adds `submissions.showcase_opt_in` (NOT NULL DEFAULT false),
  `.showcase_opted_in_at` and `.showcase_value_cents` — the PER-ITEM consent that
  decides whether a graded find appears in the public feed. The default is false,
  so the backfill is implicit and NOTHING becomes public on apply.
- Adds `showcase_reactions` (one upvote per user per find) with owner-scoped RLS:
  a user reads, inserts and deletes only their own rows. Public counts are
  aggregated by the service-role edge, so no "anyone can read" policy exists —
  who reacted to what is not public, only how many did.
- Adds the `public_showcase_finds` VIEW, granted to `anon`. It re-states the
  `public_grade_reports` visibility predicate (certified, review-approved, not
  moderation-withheld) and ANDs consent on top, so a find can never be more
  visible than its own certificate.

**Deploy order.** Apply BEFORE the edge rolls (the normal order). The edge build
that ships with it serves `/api/content/public/finds.json` and `/api/showcase/*`,
both of which read the new view/table; against a DB without this migration those
routes 500. Nothing EXISTING breaks either way — the columns are additive and no
current query reads them.

**Client-side reads?** Yes, but only through the edge. The SPA reads the feed
from `/api/content/public/finds.json` and never queries `public_showcase_finds`
or `showcase_reactions` directly, so the RLS posture above is the whole story.

## ✅ APPLIED: 00545_share_to_earn.sql (US-1854 — share-to-earn loop, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It only needs `reputation_events`
(00417), `badge_click_events` (00404) and `users`, all long applied — so it does
not depend on any other held migration and could go first if 00530–00544 slip.

**Risk: LOW.** One new table, two new columns on `badge_click_events` (both
nullable-or-defaulted), three indexes, and one CHECK constraint widened by a
single value. No existing column, row or enum is modified or dropped.

**What it does.**
- Widens the `reputation_events` event_type CHECK by one value,
  `share_milestone`. Restated in full, so the whole allow-list is authoritative.
  Widening only — no existing event type is removed, so already-stored rows stay
  valid.
- Adds `share_events` — the TRACKED SHARE log (who shared which certificate,
  through which channel). **Deny-all RLS** plus an explicit REVOKE: it holds
  `sharer_hash`, which is the self-click defence, so a client that could write it
  could bank a fingerprint against someone else's find and have that seller's
  genuine clicks discarded.
- Adds `badge_click_events.visitor_hash` (nullable) and `.self_click` (NOT NULL
  DEFAULT false). `self_click` is defaulted, so the backfill is implicit and
  existing rows read as "not a self-click", which is the honest reading for
  clicks recorded before any fingerprint existed.

**Deploy order.** Apply BEFORE the edge rolls (the normal order). An edge build
running against a DB without this migration would fail the `share_milestone`
CHECK on every milestone grant and fail every `badge_click_events` insert on the
unknown `visitor_hash`/`self_click` columns — i.e. it would break the EXISTING
badge-click recording, not just the new feature. That is the one thing here worth
watching: this migration must land before the edge image that expects it.

**Client-side reads?** None. The SPA never queries `share_events` or the new
columns — both go through the edge (`/api/rewards/share`,
`/api/content/public/badge-click`). So a frontend auto-deploy ahead of the SQL is
harmless; the edge is the one that must not run ahead.

## ✅ APPLIED: 00544_reward_milestone_catalog.sql (US-1853 — milestone rewards, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It depends on `reward_tangible_grants`
(00538, also held), `users` and `set_updated_at()`, so it MUST go after 00538.

**Risk: LOW.** One new table, two new nullable columns on a table nothing has
written to in prod yet, two indexes, seven seeded catalog rows (five of which
restate the ladder already compiled into the edge). No existing column, enum or
row is modified.

**What it does.**
- Adds `reward_milestones` — the operator-editable tangible catalog: reward type,
  trigger (XP threshold | badge | season goal), value, marginal cost, and its own
  monthly + lifetime issue caps. **Deny-all RLS** (RLS on, zero policies) plus an
  explicit REVOKE: a client-writable reward catalog is a client-writable money
  faucet. Read through `/api/admin/rewards/milestones` and by the service-role
  engine only.
- Adds `reward_tangible_grants.expires_at` and `.consumed_at`. A per-grade
  discount is live until `expires_at` and then simply stops applying (no
  revocation job); a subscription coupon is redeemable once and the
  `customer.subscription.created` webhook stamps `consumed_at`.
- Seeds the five XP credit milestones US-1848 shipped in code, with the same
  keys/values/costs, so grants already in the ledger still map to a milestone.
- Seeds two DISABLED discount milestones (a badge-triggered subscription discount
  and a season-goal-triggered grading discount) so the shapes are visible in the
  admin screen. Turning one on is deliberate: both mint a real Stripe coupon, and
  the honest `cost_usd` of a discount depends on a plan mix this file can't see.

**Deploy order.** Apply BEFORE the edge rolls (the normal order). An edge build
that reads `reward_milestones` against a DB without it logs the failure and falls
back to the compiled ladder, so it degrades rather than breaking — but the
discount grants need `expires_at`/`consumed_at` to exist before they can be paid.
The `rewards_tangible` kill-switch (00538) is still seeded OFF, so nothing here
pays anybody until an operator turns it on.

**After applying:** `NOTIFY pgrst, 'reload schema';` — one new table and two new
columns need PostgREST to re-read the schema cache.

## ✅ APPLIED: 00543_reward_quests.sql (US-1852 — quests & challenges, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It depends on `reputation_events`
(00417/00443), `users`, `feature_flags` and `set_updated_at()` — all long
applied — and on nothing newer.

**Risk: LOW.** Two new tables, one widened CHECK constraint, one new
`feature_flags` row, four seeded quest rows. No existing table, column or row is
modified.

**What it does.**
- Widens `reputation_events_event_type_check` to admit `quest_completed`. The
  whole allow-list is re-stated (the 00443 precedent), so the statement is
  authoritative and re-runnable. Every existing type is unchanged.
- Adds `reward_quests` — the admin-authored definitions (criteria, window,
  reward) with a per-quest `enabled` kill-switch. **Deny-all RLS** (RLS on, zero
  policies): a client-writable quest definition would be a client-writable XP
  faucet. `xp_reward` is CHECKed at 0–200; the edge clamps it again.
- Adds `user_quest_progress` — the per-user snapshot and completion claim.
  `UNIQUE (user_id, quest_id, period_key)` is what makes a repeating quest pay
  once per window. RLS lets a user read their own rows; only the service role
  writes. Quest PROGRESS itself is still derived from `reputation_events` — this
  table can be dropped and rebuilt.
- Seeds `feature_flags.rewards_quests` = **true**, read fail-OPEN. Deliberately
  the opposite of `rewards_tangible`: quests pay XP, which is free status, so an
  outage that froze everyone's progress would do more damage than one that kept
  paying it. The money rail keeps its own fail-closed switch.
- Seeds four starter personal quests (three weekly, one monthly).

**Deploy order matters.** Apply BEFORE the edge rolls (the normal order): an edge
build that emits `quest_completed` against a DB with the old CHECK gets a 23514
on every quest completion. The frontend is safe either way — the quests panel
renders nothing when the read fails.

**After applying:** `NOTIFY pgrst, 'reload schema';` — two new tables need
PostgREST to re-read the schema cache.

## ✅ APPLIED: 00542_reward_levels_seasons.sql (US-1851 — levels & seasons, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It alters `user_reward_state` (added by
00443, long applied) and depends on nothing newer.

**Risk: LOW.** One new nullable-with-default column, one idempotent backfill of
that same column, one new table, one new `system_settings` row. No existing
column, enum or row is modified.

**What it does.**
- Adds `user_reward_state.xp_peak` (bigint, default 0) and backfills it to
  `GREATEST(xp_peak, xp_total)`. Reward LEVELS now derive from this high-water
  mark, so a level can never decrease — even if the underlying
  `reputation_events` log shrinks (erasure request, fraud reversal, cascade).
- Adds `user_season_recaps` — the frozen record of a completed quarterly season.
  `UNIQUE (user_id, season_key)` is the idempotency guarantee for the lazy
  rollover (the edge writes the row the next time the user opens their rewards
  screen; there is no quarterly cron). RLS lets a user read their own recaps;
  only the service role writes.
- Seeds `system_settings.rewards_season_timezone` = `America/Chicago`, the ONE
  shared zone the quarterly boundary is resolved in, so every seller's season is
  the same window.

**Deploy order matters here, mildly.** The edge writes `xp_peak` on every reward
grant, so applying this BEFORE the edge rolls (the normal order) is required —
an edge build that expects the column against a DB without it fails the upsert
and the reward state stops refreshing. The frontend is safe either way: the new
`/api/rewards/state` route degrades to level 0 / empty season on any read error.

**After applying:** `NOTIFY pgrst, 'reload schema';` — a new table and a new
column both need PostgREST to re-read the schema cache.

## ✅ APPLIED: 00541_listing_aspect_coverage.sql (US-2425 — draft coverage metric, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, after 00540. No dependency beyond `public.listings`
existing.

**Risk: LOW.** One nullable `jsonb` column on `listings` plus one partial index
on `updated_at` where the column is not null. No backfill, no constraint change,
no default — every existing row keeps `NULL` and reads as "not scored yet".

**Client-side read — this one matters for push order.** `src/types/database.ts`
declares `listings.aspect_coverage`, and the new admin page
`/admin/listing-coverage` reads it through the edge route
`/api/admin/listing-coverage`. Cloudflare Pages auto-deploys the frontend on
push, so if the SQL has not been applied the route's `select` fails and the page
shows its error card. Apply first.

**What it does.** Records how complete each generated draft's eBay item
specifics were at the moment AutoLister produced it. Required and recommended
tiers are stored separately on purpose — a required gap blocks the publish, a
recommended gap only costs search placement.

## ✅ APPLIED: 00540_listing_category_candidates.sql (US-2424 — category choice, applied 2026-08-08 — owner-confirmed)

**Apply order.** Before 00541, after 00539. No dependency beyond
`public.listings` existing.

**Risk: LOW.** One nullable `jsonb` column on `listings`. No backfill, no index,
no constraint change.

**Client-side read.** `src/types/database.ts` declares
`listings.category_candidates`. Nothing renders it yet, but the type is shipped,
so apply before the push for the same reason as 00541.

**What it does.** Stores the ranked eBay leaf candidates AutoLister weighed when
choosing a draft's category, with the required-aspect score behind each. Element
0 is the chosen leaf. Lets the composer offer a one-click switch to the runner-up
without a fresh AI run.

## ✅ APPLIED: 00539_quest_definitions.sql (US-1852 — quests & challenges, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It must go AFTER 00443 (which owns the
current `reputation_events` CHECK it rewrites) — long applied — and has no other
dependency.

**Risk: LOW, with one thing to read twice.** It creates one new table and
**re-writes the `reputation_events_event_type_check` constraint**: drop, then
re-add with the eleven existing values plus `quest_completed`. The re-added list
is a strict superset, so no existing row can violate it and no backfill runs.

`apply-prod-migrations.sh` runs each file with `-v ON_ERROR_STOP=1` and **no
`--single-transaction`**, so the two `ALTER`s autocommit separately and there is
a sub-second window where the column carries no CHECK. That window is safe here
(only the service role writes the table, and a superset re-add cannot fail on
existing data) — but if the `ADD` ever did fail, the script halts and the column
stays unconstrained until the file is re-run. Re-running is safe and idempotent.
00443 has exactly this shape; the same caveat applies to it.

**What it does.** Adds `quest_definitions` — the operator's list of which quests
and time-boxed challenges are running, how hard they are, when, and what they
pay. Deliberately NOT added: any per-user progress table. Progress is derived
from `reputation_events` over the quest's window, the same way season progress is
(US-1851), so there is one log and no rollover job.

**The safety rails:**
- `quest_definitions.enabled` defaults **false**, so a half-configured row cannot
  start paying.
- `feature_flags.rewards_quests` is read with `defaultEnabled: false` — the whole
  surface is off until an operator turns it on, and an outage suspends it rather
  than opening it. **No flag row is seeded**, so nothing needs to be un-set.
- The payout is clamped to 200 XP in code, both when written and every time it is
  re-scored — a row written past the ceiling still cannot pay past it.

**Nothing breaks if the frontend deploys first.** The only client surface is the
admin page at `/admin/growth/quests`, which reads the table through the edge
(`/api/admin/growth/quests`). Before the migration applies that call returns a
500 and the page shows its error state; no seller-facing route touches quests at
all. The edge boot guard will expect `00539`, so apply this before the next
Coolify deploy as usual.

**After applying:** `NOTIFY pgrst, 'reload schema';` — a new table AND a changed
constraint, so PostgREST needs to learn about both.

## ✅ APPLIED: 00538_reward_tangible_grants.sql (US-1848 — tangible reward rail, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It depends on nothing newer than
`users`, `feature_flags` and `system_settings`, all of which are long applied.

**Risk: LOW.** One new table, one new `feature_flags` row, one new
`system_settings` row. No existing table, column, enum or row is touched, and
nothing backfills.

**What it does.** Adds `reward_tangible_grants` — the ledger for the half of
GradeThread Rewards that moves real value (free grade credits today;
subscription and per-grade discounts once US-1853 registers their fulfillers).
`UNIQUE (user_id, milestone_key)` is the idempotency guarantee: the engine
claims a row before moving any value, so no retry or concurrent pass can pay a
milestone twice. RLS lets a user read their own grants; only the service role
writes.

**The two config rows are the safety rails:**
- `feature_flags.rewards_tangible` is seeded **`false`**, and the engine reads it
  with `defaultEnabled: false`. So payouts stay off until an operator turns them
  on, and an outage suspends them rather than opening them.
- `system_settings.rewards_tangible_budget` seeds the three USD ceilings
  (global monthly 500, per-user monthly 15, per-user lifetime 60).

**Nothing breaks if the frontend deploys first.** No client surface reads either
the table or the setting — the whole rail lives in the edge service, and with the
flag off it is inert. The edge boot guard will expect `00538`, so apply this
before the next Coolify deploy as usual.

**After applying:** `NOTIFY pgrst, 'reload schema';` — a new table means
PostgREST needs to learn about it.

## ✅ APPLIED: 00537_buyer_growth_metrics.sql (US-1845 — buyer analytics surface, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It reads `submissions.buyer_video_grade`
and `ingested_listings`, so it needs 00535 and 00536 applied first — which the
numeric order already gives you.

**Risk: LOW.** One `CREATE OR REPLACE FUNCTION`. No table, no column, no enum, no
data touched. `buyer_growth_metrics(integer)` is SECURITY DEFINER, revoked from
public and granted to `service_role` only, and it returns counts — no user id, no
email, no UTM value tied to a person.

**What it does.** Aggregates the buyer funnel (accounts / activated / paying /
recently active), the plan × interval × status mix, per-feature adoption, a daily
buyer-demand vs seller-grading series, and a first-touch acquisition rollup, all
as one jsonb.

**⚠️ ONE ADMIN PAGE 404s UNTIL THIS APPLIES.** `/admin/growth/buyer` is the only
caller (via `GET /api/admin/growth/buyer`). If the frontend auto-deploys first,
that page shows its error card until the SQL lands. Nothing else reads the
function, no buyer- or seller-facing surface is affected, and no write path
depends on it — so this one is safe to apply after the push if it comes to that,
unlike 00536.

**After applying:** `NOTIFY pgrst, 'reload schema';` — PostgREST caches the RPC
list, so the endpoint 404s at the API layer until it reloads.

## ✅ APPLIED: 00536_buyer_video_grading.sql (US-1841 — buyer-funded walk-around grades, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00532 (it builds on the clip path) and last in numeric
order, like the rest.

**⚠️ THIS ONE IS NOT "LOW". Risk: MEDIUM**, for one specific reason: it adds an
enum value with `ALTER TYPE public.submission_payment_status ADD VALUE IF NOT
EXISTS 'buyer_credits'`. PG12+ permits that inside a transaction, but **the new
value cannot be USED in the same transaction that added it**. This file therefore
never writes or compares the literal against the enum — the `refund_grade`
comparison is deliberately `v_payment_status::text = 'buyer_credits'`. Do not
"tidy" that cast, and do not run any statement that inserts the new value in the
same session before the migration's transaction commits.

**What it does.**
- `submission_payment_status` gains `'buyer_credits'` — a grade paid with a buyer
  video-grade credit rather than the seller precedence.
- `submissions` gains `buyer_video_grade` (bool, default false),
  `buyer_credit_source` (`allowance` | `reward`, CHECKed, nullable) and
  `closet_item_id` (FK → `closet_items`, `ON DELETE SET NULL`), plus a partial
  index on the last one. Every existing row keeps its defaults; nothing is
  rewritten.
- `refund_grade()` is replaced with the 00093 body **plus** a `buyer_credits`
  branch that returns the unit to the pocket that paid
  (`refund_buyer_meter` / `refund_buyer_reward_credit`). Behaviour for
  `included` / `credits` / `paid_stripe` / `unpaid` is byte-identical.

**⚠️ THE EDGE NEEDS THIS BEFORE A BUYER CLIP GRADE CAN BE PAID FOR.**
`POST /api/grade/submit` writes `payment_status = 'buyer_credits'` and the three
new columns on the buyer path. If the edge rolls first, that write fails and the
grade is left reading `unpaid` after the credit was already spent. The frontend
does **not** read the new columns on any existing page — the new portfolio button
queries `submissions.closet_item_id`, which returns nothing until the column
exists (an empty result, not an error) — so a Cloudflare Pages auto-deploy on push
degrades quietly. Still: apply first.

**Apply, then `NOTIFY pgrst, 'reload schema';`, then redeploy the edge** (the
same commit bumps `EXPECTED_SCHEMA_VERSION` to `00536`, so the boot guard needs
the row recorded), then push.

## ✅ APPLIED: 00535_ingested_listings.sql (US-1808 — extension-fed marketplace listing ingestion, applied 2026-08-08 — owner-confirmed)

**Apply order.** Independent of 00530–00534; apply it last, in numeric order,
like the rest.

**Risk: LOW.** One new table with two indexes, a trigger and two RLS policies,
plus a CHECK swap on `watchlist_items.target_type`. No existing row is rewritten
and no existing column changes type.

**What it does.**
- `ingested_listings` — a marketplace listing the buyer was browsing, handed to
  GradeThread by the extension, graded, and matched against their saved
  searches. Owner READ + DELETE under RLS; **all writes are the edge's**
  (service role, scoped by `user_id`). Unique on `(user_id, listing_url)` so
  re-checking an item refreshes one row.
- `watchlist_items.target_type` gains `'ingested_listing'`. The constraint is
  dropped and re-added, so it is idempotent, but note it is a **drop + add, not
  a widening in place** — between the two statements the column is briefly
  unconstrained. That window is inside one migration and no writer runs in it.

**⚠️ THE EDGE NEEDS THIS BEFORE THE NEW ROUTE ANSWERS.**
`POST /api/grading/public/ingest-listing` writes `ingested_listings` on its
first call, so the edge must not roll before the SQL lands. The frontend does
**not** read the new table (the types are declared, nothing queries them yet), so
a Cloudflare Pages auto-deploy on push is harmless on its own.

**Apply, then `NOTIFY pgrst, 'reload schema';`, then redeploy the edge** (the
same commit bumps `EXPECTED_SCHEMA_VERSION` to `00535`, so the boot guard needs
the row recorded), then push.

## ✅ APPLIED: 00534_video_live_capture.sql (US-1766 — live-capture provenance for a clip, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00532 — it recreates the view 00532 last defined, so
applying it first would drop the `video_capture_verified` column 00532 adds.

**Risk: LOW.** One nullable `ADD COLUMN IF NOT EXISTS` on `submissions` and a
`CREATE OR REPLACE VIEW` that reproduces 00532's column list verbatim and
appends one boolean. No data is rewritten, no policy or index changes.

**What it does.**
- `submissions.video_capture_source` — how the walk-around clip entered the app
  (`in_app_recorder` / `library`), normalized server-side.
- `public_grade_reports.video_live_capture_verified` — the public boolean: the
  Video-Verified badge was earned AND the clip was recorded in the in-app
  recorder.

**⚠️ THE FRONTEND READS THE NEW VIEW COLUMN.** `certificate.tsx` fetches the
view with `.select("*")` and reads `video_live_capture_verified`. Cloudflare
Pages auto-deploys on push, so pushing before applying leaves the certificate
reading `undefined` — which renders the plain Video-Verified copy, i.e. it
degrades quietly rather than breaking. Still: apply first.

**Apply, then `NOTIFY pgrst, 'reload schema';`, then redeploy the edge** (the
same commit bumps `EXPECTED_SCHEMA_VERSION` to `00534`, so the boot guard needs
the row recorded), then push.

## ✅ APPLIED: 00533_video_grading_scenarios.sql (US-1765 — model video grading in the AI scenarios, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00532 — it patches a setting 00532 also patches, and its
guard assumes 00532 ran first.

**Risk: LOW.** Two `UPDATE`s against `system_settings` rows. No table, column,
view, index, policy or function is touched. Both are guarded so they are no-ops
on re-run, and both no-op entirely if the target row is missing or the wrong
jsonb shape. Nothing outside the two admin AI dashboards reads either row.

**What it does.**
- `ai_usage_scenarios`: gives every modeled scenario a `video_grading` volume of
  15% of its grading volume, **subtracted from** the grading volume rather than
  added on top. Same grade count, same modeled revenue, different cost mix.
- `ai_feature_economics`: ensures the `video_grading` entry exists. 00532 already
  adds it; this repeats the insert only when the key is absent, so a
  hand-edited row between the two migrations can't leave the scenarios pointing
  at a feature priced at zero.

**Why.** 00532 broke video_grading out in the OBSERVED per-feature table. The
projection half of the profitability report reads `ai_usage_scenarios` instead,
and video_grading was in none of them — so every modeled scenario projected
platform spend as if no seller ever graded from a clip.

**Apply order vs the push is not tight.** No frontend or edge code reads either
row directly; `ai_profitability()` reads them at query time, so applying late
just means the projection keeps ignoring video grading until it lands. The same
commit bumps `EXPECTED_SCHEMA_VERSION` to `00533`, so the edge still needs the
row recorded before it boots — apply the SQL, `NOTIFY pgrst, 'reload schema';`,
redeploy the edge, then push, exactly as for 00532.

## ✅ APPLIED: 00532_video_grading.sql (US-1762 — grade from a walk-around clip, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00531. Nothing else is queued behind it.

**Risk: MEDIUM — because of the VIEW, not the columns.** Four nullable/defaulted
columns on `submissions`, one nullable column on `grade_reports`, three seed rows
and one `system_settings` patch are all inert. The `CREATE OR REPLACE VIEW
public.public_grade_reports` is the part that can fail: a replace may only APPEND
trailing columns, so the 00530 column set is reproduced VERBATIM with
`video_capture_verified` added last. If prod's live view has drifted from 00530
this raises 42P16 and the whole migration rolls back — which is the safe
direction, but check that 00530 is applied FIRST.

**What it does.**
- `submissions`: `video_grading_opt_in` (bool, default false), `video_graded`
  (bool, default false), `video_slot_marks` (jsonb), `video_frames` (jsonb).
- `grade_reports`: `video_capture` (jsonb) — the server-side provenance result.
- `public_grade_reports`: appends `video_capture_verified` (the positive-only
  Video-Verified badge). Nothing else in the view changes.
- Seeds the `video_grading` feature flag (enabled), two `ai_budgets` rows
  (day $25 throttle / month $400 kill), and the `video_grading_max_frames` (6)
  and `video_grading_plans` settings. Patches `ai_feature_economics` so the admin
  AI-spend and profitability pages break the feature out on its own.

**Apply BEFORE the frontend deploys — this one genuinely matters.** Unlike 00531,
`src/` DOES read the new view column: `certificate.tsx` renders the
Video-Verified badge off `video_capture_verified`, and the SPA reads the view with
`.select("*")`. Cloudflare Pages deploys on push, so a frontend that ships first
just reads `undefined` and hides the badge — degraded, not broken. The edge is the
hard gate: the same commit bumps `EXPECTED_SCHEMA_VERSION` to `00532`, so apply
the SQL, `NOTIFY pgrst, 'reload schema';`, redeploy the edge, then push. Edge
first burns the ~40s grace window and then refuses to boot.

**The edge image changes too, and it is bigger.** The Dockerfile now installs
`ffmpeg` (the clip decoder) and the runtime gains `--allow-write=/tmp` +
`--allow-run=ffmpeg`. Verified locally: the image builds and the CI Trivy gate
(`--severity HIGH,CRITICAL --ignore-unfixed`) reports 0 vulnerabilities. If the
redeploy somehow lands without ffmpeg, video grading does NOT error — the
extractor probes once, reports unavailable, and every video submission falls back
to `needs_photos` uncharged.

## ✅ APPLIED: 00531_extension_usage_pings.sql (US-1757 AC2 — anonymous opt-in extension usage counters, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00530. Nothing else is queued behind it.

**Risk: LOW.** One new table. No existing table, column, view, index, policy or
function is touched, and there is no backfill and no row change anywhere else.
Nothing in the app reads it yet, so applying it late costs only lost counters,
never an error.

**What it does.** `CREATE TABLE IF NOT EXISTS public.extension_usage_pings`
(`event`, `surface`, `event_count`, `ext_version`, `created_at`), one index on
`(event, created_at DESC)`, RLS enabled with **no policies** (deny-all), and a
`REVOKE ALL … FROM anon, authenticated` in an exception-guarded `DO` block for
bare local stacks. Registered in `SERVICE_ROLE_ONLY` in `rls-guard_test.ts`.

**Why.** The extension funnel was measured only at its two ends — a store
dashboard reports installs, and US-1753's utm tags attribute the signup. Nothing
measured the middle, so "do installs convert to accounts" had no answer. This is
the tally the new opt-in popup toggle feeds.

**Deny-all is load-bearing in both directions.** An *anonymous, unauthenticated*
endpoint writes here (`POST /api/grading/public/usage`), so a readable table would
be a free public firehose; and there is no owner column to scope a read policy to
in the first place. Same posture as `selector_health_pings` (00475).

**No client-side read, so the frontend auto-deploy is safe.** Nothing in `src/`
queries this table — the SPA does not know it exists. The only writer is the edge
service. So the usual "the frontend deploys the moment you push" hazard does not
apply to this migration.

**Apply-order hazard is the ordinary one.** The same commit bumps
`EXPECTED_SCHEMA_VERSION` to `00531`, so the edge container boot-guards on it:
apply the SQL, `NOTIFY pgrst, 'reload schema';`, redeploy the edge, then push. If
the edge deploys first it burns the ~40s grace window and then refuses to boot.

**Verification after applying.**

```sql
select count(*) from public.extension_usage_pings;               -- 0, and no error
select relrowsecurity from pg_class where relname = 'extension_usage_pings';  -- t
select count(*) from pg_policies where tablename = 'extension_usage_pings';   -- 0
```

Then, with the extension's new "share anonymous usage counts" toggle ON, do a
condition read and click a link back to gradethread.com; a row appears after the
batch window closes (up to 6 hours, or immediately at 50 events).

## ✅ APPLIED: 00530_public_cert_rubric_factors.sql (US-1997 — public cert view exposes rubric_key + factor_scores, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00529. Nothing else is queued behind it.

**What it does.** One `CREATE OR REPLACE VIEW public.public_grade_reports`. It
reproduces 00356's SELECT list and WHERE clause verbatim and appends three output
columns: `rubric_key`, a sanitized `factor_scores`, and
`certified_content_updated_at`. No table, column, index, policy or function
changes. No backfill, no row changes, and the view's ROW SET is byte-identical —
only the projection widens.

**The third column is a US-2392 bug this migration's new guard caught.**
`certified_content_updated_at` shipped in 00522, is declared on
`PublicGradeReportRow`, and is read by `certificate.tsx:588`, which publishes it
as schema.org `dateModified`. The view never projected it, so the SPA
certificate's `dateModified` has always been null — while the SSR certificate
(`functions/cert/[id].ts`) prints the real value, because that path goes through
the edge endpoint's `CERT_REPORT_EXTRA_COLUMNS`, which US-2392 DID extend. Same
two-read-paths split as the rubric columns. Not a new disclosure: the edge has
served this value publicly since 00522. Applying this migration makes the SPA
certificate's structured data agree with the SSR one.

**Why.** Migration 00231 shipped `grade_reports.rubric_key` + `factor_scores` to
prod and deferred exposing them to "the activation phase". The owner settled
that on 2026-07-23: ACTIVATE. There are two public read paths for a certificate
and only the edge one (`content-public.ts` CERT_REPORT_COLUMNS) had been
extended. The SPA reads THIS VIEW — `certificate.tsx` and `embed-grade.tsx` both
`.select("*")` on it — and branches on `factor_scores && rubric_key` to render a
non-clothing factor breakdown. With the view not projecting either column that
branch was unreachable no matter what the pipeline wrote, so fixing the writer
alone would never have made it fire.

**Sanitization, deliberately in the view rather than trusted to the writer.**
`factor_scores` is free-form jsonb, so the view rebuilds it keeping only
NUMBER-valued entries, and collapses an empty result to NULL rather than `{}`.
The NULL matters: the client guard is `factor_scores && rubric_key` and `{}` is
truthy in JS, so an empty object would take the non-clothing branch and render a
breakdown in which every factor resolves to 0. NULL keeps the typed-column
fallback. The writer does not exist yet, which is exactly why the guard is on
the read side.

**Risk: LOW.** The two rubric columns are NULL on every row in prod today
(nothing writes them — that is Phase 2, gated on a non-clothing golden set), so
they come back NULL for every existing certificate and every current cert renders
from the five typed columns exactly as before. `certified_content_updated_at` is
already populated on adjusted reports and already public via the edge; surfacing
it here can only add a `dateModified` where the SPA previously emitted null.
`CREATE OR REPLACE VIEW` is safe to re-run.

**CLIENT reads.** The SPA already declares both fields on `PublicGradeReportRow`
and already handles their absence — that is the fallback path every certificate
takes today and will keep taking until Phase 2. So a frontend deploy AHEAD of
this SQL is safe: `select("*")` simply returns the old column set, both fields
come back `undefined`, and the guard falls through. There is no ordering hazard
in either direction.

**The edge does not read either column from this view** (it uses the base table
via CERT_REPORT_COLUMNS), so no edge behaviour depends on this migration beyond
the boot guard's version match.

**iOS / Android are unchanged and need no release.** Neither client reads the
public certificate view.

**Apply:** run the SQL, then `NOTIFY pgrst, 'reload schema';` — PostgREST caches
the view's column list, so without the reload `select("*")` keeps returning the
old projection. Then redeploy the edge (boot guard now expects `00530`), then
push.

## ✅ APPLIED: 00529_subscription_status_comp.sql (US-2398 AC4 admin comp grant, applied 2026-08-06 00:57 UTC — measured)

**Applied.** Confirmed 2026-08-05 by reading `public.applied_migrations`
directly on prod: `00529` recorded at `2026-08-06 00:57:56Z`. Prod
`/health/ready` reports `expected 00529 / applied 00529 / match`.

⚠️ `/health/ready` alone could NOT have established this. Its `applied` value is
`max(version)` (`compareSchemaVersion` in `lib/schema-version.ts`), so a
00529 present with 00528 missing would still read "match" — the same shape as
the 00479 phantom this repo already got caught by. Both rows were listed
explicitly before either heading was changed.

**Apply order (historical).** After 00528. The two were stacked and ran in
order: 00528 at `2026-08-05 13:01Z`, 00529 at `2026-08-06 00:57Z`.

**What it does.** One `ALTER TYPE public.subscription_status ADD VALUE IF NOT
EXISTS 'comp'` and one `COMMENT ON COLUMN`. No table, column, index, policy or
function changes. Nothing is backfilled and no existing row changes.

**Why.** `POST /api/admin/users/:id/plan` — the admin "Change Plan" control,
billing:write + MFA step-up + audit row — wrote the frozen `users.plan` column,
which nothing reads for entitlement. Every comp an operator issued reported
success and moved nothing. Rewiring it to `flipdesk_plan` alone would NOT have
fixed it: `effectivePlanFor()` demotes a paid plan to Free whenever
`subscription_status` is `none` or `canceled`, which is exactly what a cardless
account carries. `comp` is the status that entitles without inventing revenue —
MRR counts only `active` and `past_due`, so a comp grants caps and bills nobody.

**⚠️ THE EDGE WRITES THE NEW ENUM VALUE, so order matters more than usual.** A
new enum value cannot be USED in the same transaction that adds it, and an edge
container running ahead of this migration will fail the grant with a 22P02
(`invalid input value for enum subscription_status: "comp"`). The boot guard
already blocks that ordering; do not bypass it. Nothing else reads or writes
`comp`, so an unapplied database simply keeps the grant broken exactly as it is
today — the failure direction is safe.

**Risk: LOW.** An enum value nothing has yet written cannot affect an existing
row. `ADD VALUE IF NOT EXISTS` is safe to re-run.

**CLIENT reads/writes.** The SPA reads `subscription_status` and now renders
"Comped — granted, not billed" when it sees `comp`; it never writes the value
(only the edge route does). A frontend deploy ahead of the SQL is safe: no
account can be carrying `comp` yet, so the branch is unreachable. **The admin
user-detail page now sends `flipdesk_plan` tier names** (`pro`/`business`) to
that route instead of the legacy `professional`/`enterprise` — that half needs
the edge deploy, not this migration.

**iOS is unchanged and does not need a release.** `entitlingStatuses`
(`PlanStore`, `PaywallStore`) is used only to answer "who owns this
subscription" for the manage-billing routing — never to gate a feature — so a
comped account shows its granted tier from `flipdesk_plan` as usual.

**Apply:**

1. Run `supabase/migrations/00529_subscription_status_comp.sql`.
2. `NOTIFY pgrst, 'reload schema';` — the enum changed.
3. Redeploy the edge (boot guard expects 00529).
4. Then push.

**Verify after applying:** issue a comp from the admin user detail page, then
`select flipdesk_plan, subscription_status from users where id = '<id>';` —
expect the granted tier and `comp`. The user's caps should move immediately; MRR
should not.

**NOT exercised against a live database** (the `verify:db` lane needs Docker).

## ✅ APPLIED: 00528_best_offer_thresholds_manual_only.sql (US-2405 manual Best Offer thresholds, applied 2026-08-05 13:01 UTC — measured)

**Applied.** `public.applied_migrations` on prod records `00528` at
`2026-08-05 13:01:10Z`. The sequence around it is intact: 00524, 00525, 00526,
00528, 00529 — with 00527 correctly absent (see the apply-order note below).

**HOW THIS FILE WENT STALE, because it is the second time the same class of
mistake has cost a session here.** Both 00528 and 00529 were applied by the
owner and this file still said HELD, so the session-start hook announced "2
migrations HELD (not yet applied to prod)" and an agent planned around a frozen
branch that was not frozen. The previous instance of this ran the other way —
US-1897's notes claimed 00475/00476 were "genuinely pending" when prod had them.
Both times the file was trusted and prod was not asked.

The rule that falls out: **this file records intent; only the database records
state.** Before acting on a HELD heading, read `applied_migrations` — one query,
and it is the answer:

```sql
SELECT version, applied_at FROM public.applied_migrations
WHERE version >= '00520' ORDER BY version;
```

**Apply order (historical).** After 00526. **00527 does not exist as a `.sql` file** — it is
`00527_revoke_public_function_execute.sql.BLOCKED` (US-2403), invisible to the
`*.sql` glob, and its number stays reserved. `EXPECTED_SCHEMA_VERSION` therefore
jumps 00526 → 00528, the same deliberate skip already recorded for 00479.

**What it does.** One `UPDATE` over `public.listings` setting
`best_offer_auto_accept_cents` and `best_offer_auto_decline_cents` to NULL
wherever either is set, plus two `COMMENT ON COLUMN` statements. No table,
column, index, policy or function changes. Idempotent — the second run matches
zero rows.

**Why.** Blank Best Offer boxes used to fall back to the listing's comp band
(p75 → accept, p25 → decline), and the composer wrote that resolved default
into the columns on save. So sellers who never touched the fields still had
fixed numbers stored, and nothing refreshed them when the price moved. A shirt
repriced from $24 to $298 kept a $27.50 auto-accept and a $16 auto-decline: a
$28 offer on a ~$300 item would have auto-accepted. The code in this commit
removes the comp fallback on both sides (edge `best-offer.ts` and the web
mirror), so NULL now means "no threshold, the offer waits for you". This
backfill makes the stored data match that meaning.

**It clears hand-typed values too.** Nothing recorded which numbers were typed
and which were auto-filled, so they cannot be told apart. Re-entering a real one
is a single field; leaving an auto-filled one is a sale at the wrong price.

**Risk: LOW to apply, and the direction of failure is safe.** With the columns
NULL, no auto-accept or auto-decline is sent to eBay and every offer waits for
the seller. Nothing errors if it stays unapplied either: the new code simply
reads whatever is in the columns, so an unapplied database keeps honouring the
stale numbers — which is the bug, not a break.

**CLIENT reads/writes.** No NEW column is read or written. The SPA already reads
and writes both columns (composer, AutoLister bulk edit) and iOS reads them in
`ListingDraftService`. A frontend deploy ahead of the SQL is safe: the new
composer stops back-filling blanks immediately, so no fresh comp defaults are
created; the old stored values simply survive until this runs.

**⚠️ eBay still holds the old terms on LIVE listings.** This clears
GradeThread's copy only. A published listing keeps its old auto-accept on eBay
until FlipDesk revises it, and the revise sends the cleared (absent) terms. So
after applying: re-save / update any live Best Offer listing whose price has
changed. Verify with
`select count(*) from listings where best_offer_auto_accept_cents is not null or best_offer_auto_decline_cents is not null;`
— it should be 0 right after the apply.

**Apply:**

1. Run `supabase/migrations/00528_best_offer_thresholds_manual_only.sql`.
2. `NOTIFY pgrst, 'reload schema';` — column comments changed; harmless to run.
3. Redeploy the edge (boot guard expects 00528).
4. Then push.

**NOT exercised against a live database** (the `verify:db` lane needs Docker).
It is one guarded UPDATE and two comments, and the `raise notice` reports how
many rows it cleared.

---

**Previously:** 00524, 00525 and 00526 were applied to prod on
2026-08-04 (owner-confirmed, all three together). 00515 through 00523 were
applied on 2026-08-03.

After applying 00526, watch Sentry for one day for `users: column(s) … cannot
be modified` — that string means a client write path targets a column the new
deny-by-default guard refuses, and the fix is to move that write to the edge or
add the column to the allowlist in a follow-up migration. Nothing has been seen
as of the apply.

> [!warning] 00522 reached origin/main BEFORE it was applied — the second time
> A concurrent agent pushed the branch while 00522 was still marked held, the
> same ordering the hold rule exists to prevent and the same way it happened
> last time. It was safe again, for the same reason recorded below: the column
> sits in the EXTRA allowlist so an unapplied database degrades rather than
> breaks. Twice is a pattern, not a coincidence — the hold rule cannot be
> enforced by an agent that does not own the push.

`EXPECTED_SCHEMA_VERSION` is **00526**, matching the highest migration in the
tree. The edge needs a redeploy to pick that up: until it does, the database
is AHEAD of the running image, which the boot guard treats as a warning and
serves through. The reverse — an edge that expects a version the database does
not have — is the one that crash-loops.

> [!note] These went to origin ahead of being applied, and it worked out
> A concurrent agent pushed the branch while the migrations were still marked
> held. That is the ordering the hold rule exists to prevent, and the outcome was
> only safe because the frontend deploy did not race the SQL and the edge had not
> yet redeployed. It is recorded here rather than quietly fixed, because "it was
> fine last time" is how the rule gets dropped.

**All of them applied cleanly to a throwaway local stack on 2026-08-03**
(`supabase db reset` over the whole corpus on a fresh schema), so the ordering
and the SQL itself are verified rather than assumed.

> [!warning] 00517 went to prod ahead of 00515/00516, and it carried a bug
> The numbers are out of order in prod. That is harmless here — 00517 touches
> only two function bodies and depends on nothing 00515 or 00516 create — but it
> means `applied_migrations` has a gap, so do not read a missing 00515 as "not
> applied yet" without checking the others. What DOES matter is that 00517
> polluted its own results (see the 00518 entry below); until 00518 is applied,
> the audit-log list repeats a row on every page turn and its page count climbs
> as you browse.

00515 is **not** inert: the FlipDesk inventory table calls
`flipdesk_listing_page` on every render, so it must be applied before the
frontend deploys. (That sentence is about 00515 specifically — it predates the
later entries and used to read as if it described whichever migration was newest.)

> [!note] Why that read said `expected: "00513"` and it was still correct
> The running edge image was built from the commit that carried
> `EXPECTED_SCHEMA_VERSION = "00513"`. `status: "ahead"` means the DATABASE is
> newer than the image expects, which the boot guard treats as a warning and
> serves through — a newer DB still serves an older edge. The next Coolify
> deploy picks up the 00514 bump and the two line up at `match`.
>
> The reverse of that ordering is the dangerous one, and it nearly happened:
> a concurrent agent pushed 00513 with its version bump on 2026-08-02, ahead of
> the hold. Had the edge redeployed before the SQL was applied, the guard would
> have seen a CONFIRMED BEHIND in production, exhausted its ~40s grace window,
> exited non-zero, and Coolify's restart loop would have crash-looped the whole
> service (Traefik "no available server" on every route — see
> `vault/10-ops/edge-hang-vs-crash-loop.md`). Applying the SQL closed that
> window. Keeping migrations held until they are applied is what prevents it.

Why entries have gone stale here before: this file is edited by hand and nothing
flips the marker when the SQL runs. The session-start hook reads these ⏳
markers, so a stale one tells every future session the branch is frozen when it
is not — which has happened twice (see the US-2017 note in prd.json). **When you
apply a migration, flip its marker in the same sitting.**

---

## ✅ APPLIED: 00526_users_self_update_allowlist.sql (US-2283 [P0] self-update deny-by-default, applied 2026-08-04 — owner-confirmed)

**Risk: MEDIUM — the only one of the three that could break a client.** One
`CREATE OR REPLACE FUNCTION` plus a re-created trigger. No table, column or data
change. Safe to re-run.

**What it closes, demonstrated rather than argued.** `guard_users_protected_columns`
froze a HAND-LISTED set of columns on `public.users`. The table has ~100 and six
were missed. On a throwaway stack, as `role=authenticated` with a JWT matching the
row, the OLD function ACCEPTED
`update({ included_grades_this_period: 100000, ai_actions_used_this_month: 0 })`
and the row kept both values — unlimited Claude Vision grading billed to us. With
00526 the same statement raises, naming the column.

The guard now enumerates the 21 columns a user MAY change and refuses everything
else, so a column added next month is closed the day it is added.

**WATCH FOR ONE DAY:** `users: column(s) … cannot be modified` in Sentry. That
string means a client write path targets a column the new guard refuses. The fix
is to move that write to the edge (service-role) or add the column to the
allowlist in a follow-up migration — not to widen the guard blindly.
`src/test/users-self-update-allowlist.test.ts` fails the build if any `src/` or
`ios/` write path targets a refused column, so a regression should be caught in
CI rather than by a user.

**Still open on the same attack path:** US-2282 — SECURITY DEFINER functions that
PUBLIC can still EXECUTE. Either one alone gives free credits.

## ✅ APPLIED: 00525_admin_metrics_flipdesk_plan.sql (US-2398 admin metrics read flipdesk_plan, applied 2026-08-04 — owner-confirmed)

**Risk: LOW. Read-path only, and it CORRECTS numbers rather than changing
behaviour.** Two `CREATE OR REPLACE FUNCTION` statements (`admin_system_metrics`,
`admin_platform_analytics`) and nothing else. Safe to re-run.

**What it fixes.** `users.plan` has not been written since the 00039 backfill. It
is `NOT NULL DEFAULT 'free'`, so every account created since carries the default.
SIX metrics read it, two of which an operator acts on — the paid-user count and
the churn numerator. Both errors run the same direction, so the dashboard has
been telling a consistent story about a business doing worse than it is. MRR was
never affected; it already priced off `flipdesk_plan`, which is why nobody noticed.

**Expect the numbers to have MOVED on apply.** Paid users up, churn down, and the
plan mix relabelled: `professional`/`enterprise` disappear because those were the
frozen vocabulary — the live tiers are `pro`/`business`. Nothing was recalculated
retroactively; the dashboard simply started reading the column the rest of the
system uses.

## ✅ APPLIED: 00524_marketplace_sync_quarantine.sql (US-2324 AC3 sync quarantine, applied 2026-08-04 — owner-confirmed)

**Risk: VERY LOW.** One NEW table, nothing existing is touched. Both connectors
that use it are behind env kill-switches defaulting to FALSE, so on prod today
the table is created and never written.

**What it closes.** The Etsy and Depop syncs keep no cursor: each run re-reads
the provider window from the start. A permanently-bad record was therefore
re-attempted on every run forever, and its failure was one more line in a log
that becomes unreadable when something new breaks. After three failures a record
is set aside, with its attempt count and last error kept as the evidence.

**Deny-all by design:** RLS on, ZERO policies, grant revoked from anon and
authenticated. Readable, it would show a seller raw provider error text for their
own orders; writable, they could clear their own quarantine.

**Owner column is `owner_user_id`, not `user_id`** — rls-guard discovers TENANT
tables by that literal string in the CREATE TABLE block, and this is an operator
table. Registered in SERVICE_ROLE_ONLY in the same commit; the guard failed
first and passed after, which is how I know the registration is real.

**Verified on a throwaway stack:** full corpus applies on a fresh schema, all
nine columns present, RLS on with 0 policies, self-record row lands.

**Apply:**

1. Run `supabase/migrations/00524_marketplace_sync_quarantine.sql`.
2. `NOTIFY pgrst, 'reload schema';` — new table.
3. Redeploy the edge (boot guard expects 00524).

**Verify:** `select count(*) from marketplace_sync_failures;` returns 0, and stays
0 until an Etsy or Depop sync actually fails on a record.

## ✅ APPLIED: 00523_users_trial_notice_sent_at.sql (US-2319 trial-notice idempotency, applied 2026-08-03 — owner-confirmed)

**Risk: LOW.** One nullable column on `users`, plus a CREATE OR REPLACE of
`guard_users_protected_columns` that only ADDS the new column to its denylist.
No data is rewritten and no existing column changes meaning.

**What it closes.** The trial-ending notice had no marker: the exact-day window
(`daysLeft === 3`) was the only dedupe, so a missed cron day meant the customer
was NEVER warned — silently, because a notice nobody received leaves no trace —
and a same-day re-run double-sent. With the marker the window widens to
due-or-overdue and still sends exactly once.

**Why the guard changes too.** `guard_users_protected_columns` is a DENYLIST: a
new column is writable by the account owner unless it is named. A trialist
setting this themselves would suppress their own warning.

**Verified on a throwaway stack:** full corpus applies on a fresh schema, the
column is `timestamptz` and nullable, the replaced guard function names it, and
the self-record row lands.

**Ships with edge code that READS the column** (`jobs-trial-expiry.ts` selects
`trial_notice_sent_at`). On a database without it PostgREST answers 42703 and the
notice scan throws — the job catches and logs, so the downgrade half still runs,
but no notices go out until this is applied. Apply BEFORE the edge redeploys.

**Apply:**

1. Run `supabase/migrations/00523_users_trial_notice_sent_at.sql`.
2. `NOTIFY pgrst, 'reload schema';` — new column.
3. Redeploy the edge (boot guard expects 00523).

**Verify:** `select count(*) from users where trial_notice_sent_at is not null;`
returns 0 immediately after applying, and becomes non-zero the first time the
trial-expiry cron sends a notice.

## ✅ APPLIED: 00522_grade_report_certified_content_updated_at.sql (US-2392 certificate revision date, applied 2026-08-03 — owner-confirmed)

**Risk: LOW.** One nullable column and one partial index on `grade_reports`. No
data is rewritten — the backfill is "leave everything NULL", which is the
truthful state for a certificate that has never been revised.

**What it closes.** `grade_reports` had no `updated_at` at all. A human-review
adjustment rewrites the scores, the tier and the integrity hash on a LIVE,
publicly-served row and recorded no timestamp on it. The integrity hash is what
makes that sharper than missing metadata: the hash exists so a buyer can verify
the certificate was not tampered with, and a legitimate adjustment RECOMPUTES it
— so the certificate verified clean both before and after a score change, with
nothing marking that one happened.

**Verified on a throwaway stack:** the corpus applies on a fresh schema, the
column is `timestamptz` and nullable, every row reads NULL, and the index is
genuinely partial (`WHERE certified_content_updated_at IS NOT NULL`).

**Ships with edge + web:** the adjustment path stamps it (inside the certificate
branch only), the public certificate allowlist exposes it in the EXTRA set so the
42703 genesis fallback still serves certificates if this is unapplied, and both
the SPA and the cert SSR emit schema.org `dateModified` only when it is set.

**Safe to deploy ahead of the SQL, unusually.** The column sits in the EXTRA
allowlist, so on a database without it PostgREST answers 42703 and the existing
US-1945 fallback serves the genesis columns — certificates render, and
`dateModified` is simply absent. Apply it anyway; that is a degradation path, not
a plan.

**Apply:**

1. Run `supabase/migrations/00522_grade_report_certified_content_updated_at.sql`.
2. `NOTIFY pgrst, 'reload schema';` — new column.
3. Redeploy the edge (boot guard expects 00522).

**Verify:** `select count(*) from grade_reports where
certified_content_updated_at is not null;` returns 0 immediately after applying,
and becomes non-zero the first time a human-review adjustment resaves a
certificate.

---

## ✅ APPLIED: 00521_impersonation_sessions.sql (US-2351 [P0] impersonation bounds, applied 2026-08-03)

**Risk: LOW. One new table, nothing existing is touched.** But the EDGE change
that ships with it is behavioural, so migration and deploy have to travel
together: after this, starting an impersonation REQUIRES writing a row here. If
the table is missing, `/start` returns 500 and refuses — deliberately, because a
session with no record is exactly the unbounded one this removes.

**What was wrong.** The entry to impersonation was always well guarded —
super_admin, `users:role`, a fresh step-up, privileged targets refused, start
audited. Everything after the token was minted was open: no time limit, no
revocation on stop, no server-visible marker, and a stop audit row whose
`target_id` came straight from the request body. A super_admin could impersonate
a disputing customer, cancel their subscription and delete their account, and
every downstream record — Stripe, the deletion log, the marketplace disconnect —
would show the CUSTOMER doing it.

**What the table is.** The marker, the clock and the revocation handle in one.
Server-side rather than a token claim on purpose: a claim is equally invisible to
any route that does not parse it, and cannot be revoked once minted.

**Column naming, for the next person.** `actor_id` / `target_id`, NOT
`actor_user_id` / `target_user_id`. rls-guard discovers tenant tables by the
literal string `user_id`, and this is an operator table that must have no policy
at all. Registered in `SERVICE_ROLE_ONLY`.

**PROVEN ON A REAL DATABASE** — corpus applied to a throwaway stack, then: the
target cannot SELECT the row, cannot UPDATE it to end their own impersonation
record, and the row survives deleting BOTH parties with the emails intact.

**Ships with (edge + web):** a 30-minute hard cap enforced on read; `/stop` now
revokes the target's sessions through GoTrue's admin logout with `scope: global`
and reports whether it landed; the stop record comes from the START row rather
than the request body; account delete, subscription cancel, billing portal and
all five marketplace disconnects refuse while an impersonation is live;
`reviewer` joins the non-impersonable roles; and the account-delete password
re-authentication moves from the browser into the edge.

**Apply:**

1. Run `supabase/migrations/00521_impersonation_sessions.sql`.
2. `NOTIFY pgrst, 'reload schema';` — new table.
3. Redeploy the edge (boot guard expects 00521).

**Verify:** start an impersonation and check
`select expires_at from admin_impersonation_sessions order by started_at desc
limit 1;` is ~30 minutes out. Exit, and check `ended_at` and
`end_reason = 'stopped'` are set. While impersonating, the account-delete
endpoint should return 403 `impersonation_blocked`.

**Still open (AC7):** confirm the GoTrue OTP TTL in prod. It sets the real
lifetime of the minted impersonation and resume tokens — a second clock alongside
the 30-minute cap.

---

## ✅ APPLIED: 00520_audit_log_not_forgeable.sql (US-2349 [P0] audit integrity, applied 2026-08-03)

**Risk: LOW to apply, and it is the last of the three audit-log fixes.** No
destructive statement — two policies are dropped and a browser grant is revoked.

**Two holes, one migration.**

1. **Forgery.** 00003 defined the INSERT policy as `WITH CHECK (is_admin())`
   with nothing tying `admin_user_id` to `auth.uid()`. Any admin could write
   rows naming a *different* admin: grant yourself credits, then stamp a dozen
   `admin.change_role` rows with the super_admin's id. Non-repudiation gone for
   the whole table, and the 00227 anomaly detectors firing on the forged actor.
2. **The read, which 00517 did NOT close.** 00517 put the search RPC behind
   super_admin and gave it a self-audit. The table's own SELECT policy was still
   `is_admin()`, so `.from("admin_audit_log").select()` in the browser returned
   everything, to any admin, unrecorded. Hardening the front door while the wall
   stays open is worse than leaving both — it reads as fixed.

**The table ends with ZERO policies, by design.** Not a narrower INSERT policy:
`WITH CHECK (admin_user_id = auth.uid())` stops an admin framing someone else
and stops nothing else — they could still write any action and any details under
their own name, so the log would record fictions that are merely correctly
attributed. An audit log its own subjects can append to is not evidence.

**Nothing legitimate loses access,** and this was verified rather than reasoned:
`lib/audit-log.ts` writes as service_role; the 00065 dispute trigger, the 00518
self-audit and the 00519 stamping trigger are all SECURITY DEFINER; reads go
through `admin_audit_log_search`, also SECURITY DEFINER. `service_role` is
deliberately NOT revoked.

**PROVEN ON A REAL DATABASE, both directions** —
`scripts/verify-audit-log-not-forgeable.sql` against the full corpus on a
throwaway stack: forgery refused with 42501, a direct read returns 0 while the
row demonstrably exists, and both the service-role write and the RPC read still
work. Restoring the old policies made the same forgery succeed.

> [!note] The trap that would have produced a confident false pass
> A local `supabase db reset` grants `authenticated` no SELECT/INSERT on ANY
> public table — `human_reviews`, untouched by this work, is in the same state.
> So a run without an explicit grant "blocks" the forgery for a reason unrelated
> to the fix. The script grants first, reproducing prod, so the policy is the
> only thing under test.

**Ships with a web change.** `ai-models.tsx` no longer writes audit rows from the
browser. That call logged an admin having VIEWED a weekly accuracy summary, with
numbers the browser itself computed — a self-report of a read, unverifiable by
construction, consumed by nothing. It also passed `target_id: "weekly"` into a
`uuid` column, so it had been failing on every call; the error was discarded
until US-2357 made that write report itself. Deleted rather than relocated: an
endpoint whose only job is "write me an audit row" reintroduces this forgery.

**Apply:**

1. Run `supabase/migrations/00520_audit_log_not_forgeable.sql`.
2. `NOTIFY pgrst, 'reload schema';`
3. Redeploy the edge (boot guard expects 00520).

**Verify:** `select count(*) from pg_policies where tablename =
'admin_audit_log';` returns 0, and `select relrowsecurity from pg_class where oid
= 'public.admin_audit_log'::regclass;` returns `t`. Then open /admin/audit-log as
a super_admin — the list still loads, because it reads through the RPC.

---

## ✅ APPLIED: 00519_audit_log_survives_actor_deletion.sql (US-2350 [P0] audit trail, applied 2026-08-03)

**Risk: LOW to apply, HIGH to keep postponing.** No destructive statement; one
FK is replaced, one column is added, one trigger is created. The backfill is a
single UPDATE over `admin_audit_log` — check its row count first if that table
is large on your instance.

**The defect it closes.** `admin_audit_log.admin_user_id` was ON DELETE CASCADE
(00003). The append-only guarantee is a pair of RLS policies allowing SELECT and
INSERT and nothing else — and a cascade is not a policy-checked DELETE, it is
referential action, so it goes straight through. `POST /api/account/delete` is
self-serve, so an admin could issue refunds and role changes for a week, delete
their own account, and take every row they had ever authored with them. The
forensic export then returned nothing about any of it.

**What it does.**

1. The FK becomes ON DELETE SET NULL. `admin_user_id` was already nullable
   (00065), so nothing else had to change.
2. New `actor_email`, captured at write time and backfilled where the actor
   still exists. SET NULL alone would leave a row that survives but names
   nobody, which is not much better than no row.
3. A BEFORE INSERT trigger fills `actor_email` / `actor_role` from `users`. In
   the database rather than the edge writer because rows arrive from at least
   three places — `lib/audit-log.ts`, the 00065 dispute trigger and the 00518
   audit-search self-audit — and a rule in one writer is not followed by the
   others.

**PROVEN AGAINST A REAL DATABASE, both directions.** The whole corpus was applied
to a throwaway local stack and `scripts/verify-audit-survives-actor-deletion.sql`
run inside a transaction: two audit rows written, the acting admin deleted
through `auth.users` (the exact path account/delete takes), and both rows
survived with their email and role intact. Then the CASCADE was restored and the
same script showed the rows vanish — so the proof measures what it claims to.
The script is committed; you can re-run it anywhere.

**The privacy question, stated rather than skipped.** This deliberately retains
an email address after a user asks to be deleted. It applies ONLY to rows where
that person acted as an ADMIN, on other people's accounts. An audit trail a
subject can erase by leaving is not an audit trail. Ordinary users author no
`admin_audit_log` rows and are untouched.

**Ships with a behaviour change in the edge (AC3).** An admin or super_admin can
no longer self-serve delete: the endpoint returns 403 `admin_self_delete_blocked`
and tells them to have another admin remove the role first. The step-up it
replaces proved the person at the keyboard was the account holder, which was
never the question.

**Apply:**

1. Run `supabase/migrations/00519_audit_log_survives_actor_deletion.sql`.
2. `NOTIFY pgrst, 'reload schema';` — a column was added.
3. Redeploy the edge (boot guard expects 00519).

**Verify:** `select confdeltype from pg_constraint where conname =
'admin_audit_log_admin_user_id_fkey';` returns `n` (SET NULL). `c` would mean the
CASCADE is still there.

---

## ✅ APPLIED: 00518_audit_search_self_audit_ordering.sql (corrects 00517, applied 2026-08-03)

**Risk: LOW. This is a bug fix for a migration that is already in prod, and the
bug is live right now.**

**What went wrong in 00517 (my mistake).** It wrote the `audit_log.search` row
BEFORE running the search, in the same function and so the same statement. Under
READ COMMITTED the SELECT sees that row:

- `total_count` is a window `count(*) over ()`, so it grows by one on EVERY call
  and the console's page count climbs as you browse;
- the new row sorts first under `created_at desc`, so it displaces everything by
  one. Page 0 returns it plus originals 1-24; turning to page 1 inserts another
  row and `offset 25` then returns originals 24-48 — **one duplicated row per
  page turn**, and one skipped for each earlier insert.

**Nothing is lost or mis-recorded.** The audit rows themselves are correct and
the log is intact. What is wrong is the READING of it, which on a forensic
surface is its own kind of bad: a list that quietly repeats and skips rows is
worse than one that is obviously broken.

**The fix** moves the insert after the `RETURN QUERY`. `RETURN QUERY` executes
its query immediately and appends the rows, then execution continues — so the
search sees the state the caller asked about and the audit row still lands. It
also fills `actor_role`, which 00517 left NULL; every other writer sets it, so a
filter on `actor_role` silently skipped these rows and the CSV export showed a
blank column.

**Known limitation, now written down rather than over-claimed.** A REFUSED call
records nothing. The guard raises, the exception aborts the statement, and any
row written before it rolls back — reordering does not help and an autonomous
transaction is not available in a `SECURITY DEFINER` function. So the devtools
attack is blocked, but blocked SILENTLY. 00517's header claims the RPC path "is
no longer the quiet one" without that caveat, and an applied migration cannot be
corrected — which is why the full story now lives in
`vault/20-domain/audit-log-access-control.md`.

**Apply:**

1. Run `supabase/migrations/00518_audit_search_self_audit_ordering.sql`.
2. `NOTIFY pgrst, 'reload schema';` — the function body changed.
3. Redeploy the edge (boot guard expects 00518).

**Verify:** as a super_admin, open /admin/audit-log and turn to page 2. No row
should appear on both pages, and the total should not increase as you page.

**Cleanup worth doing once:** the `audit_log.search` rows written between 00517
applying and 00518 applying are real records of real reads — keep them. They are
just missing `actor_role`.

---

## ✅ APPLIED: 00517_audit_log_search_super_admin.sql (US-2352 audit-log exfiltration, applied 2026-08-03)

> [!important] Applied ahead of 00515/00516, and PARTLY SUPERSEDED by 00518.
> The gate it introduced is live and correct. Its self-audit ordering was wrong
> and 00518 above fixes it — apply that one promptly. The marker here is ✅ and
> not ⏳ on purpose: the session-start hook reads ⏳ as "the branch is frozen on
> this", and a stale hold marker has already misled two sessions.

**Risk: MEDIUM, and the risk is a LOCKOUT, not a break.** Now that it HAS applied,
`admin_audit_log_search` and `admin_audit_log_filter_options` refuse any caller
who is not `super_admin` or the service-role edge client. A plain admin opening
/admin/audit-log will see the page's own "super admin only" panel (shipped in
US-2357, same branch) rather than an error — but if you have an admin who is
*meant* to read the audit log and is not a super_admin, decide that BEFORE
applying, because the answer is a role grant, not a code change.

**What it does.**

1. The search RPC now requires `super_admin`. It was guarded by `is_admin()`
   only, granted to `authenticated`, and the console calls it from the BROWSER —
   so any plain admin could call it from devtools with `p_limit 50000` and take
   the whole forensic log (every other admin's IPs, user agents and `details`),
   leaving no export row behind. The edge route's super_admin gate and its
   self-audit were both skippable by not using the route.
2. Two ceilings instead of one. 50,000 stays for the service-role export path;
   a browser caller is capped at 500. The console pages at 25.
3. The RPC writes its own `audit_log.search` row for non-service-role callers,
   so the way around the gate is no longer also the way around the record.
   Service-role calls are left alone — the edge route already writes
   `audit_log.export` and recording both would double-count every export.
4. `admin_audit_log_filter_options` gets the same gate (it exposes the admin
   roster and the action vocabulary of the same log).

**Why the grant was not narrowed instead.** Revoking `authenticated` would break
the console's own paginated list, forcing that read through the edge in the same
change — a much bigger diff for the same security outcome.

**The function becomes VOLATILE.** It was STABLE, and Postgres refuses a write
inside a STABLE function, so the self-audit row forces the change. It is called
once per request on a low-QPS admin surface; nothing depended on the old
volatility.

**NOT verified against a live database** — unlike 00516, this was not applied to
a local stack. It is `CREATE OR REPLACE` on two existing functions with no schema
change, and the guard test pins the properties, but the first real execution will
be on prod. If you want a dry run, apply it to a scratch database and call the
RPC as a plain admin (expect `42501`) and as a super_admin (expect rows).

**Apply:**

1. Run `supabase/migrations/00517_audit_log_search_super_admin.sql`.
2. `NOTIFY pgrst, 'reload schema';` — two function bodies changed.
3. Redeploy the edge (boot guard expects 00517).

**Verify:** as a super_admin, open /admin/audit-log — the list loads, and a new
`audit_log.search` row appears in it naming your own user. As a plain admin, the
page shows the super-admin-only panel and a devtools call to
`admin_audit_log_search` returns `42501`.

---

## ✅ APPLIED: 00516_debit_grade_credits_idempotency.sql (US-2289 AC2 double-charge defence, applied 2026-08-03)

**Risk: LOW, and it cannot change existing behaviour.** The new parameter is
TRAILING and defaults to NULL, so every existing 4-arg caller behaves exactly as
before. The old 4-arg overload is dropped in the same file — left in place it
would silently keep winning for those callers and they would stay on the
pre-idempotency body.

**What it does.** `debit_grade_credits` gains `p_idempotency_key`. When a key is
supplied and a ledger row already carries it, the function debits NOTHING and
returns the current balance. The storage was already there and unused: 00216
added `grade_credit_transactions.idempotency_key` and a partial unique index on
it, and the grading path never set it.

**Why.** A reclaimed batch-grading job re-entered the charge path, so one garment
could be debited up to 5 times (MAX_GRADE_JOB_ATTEMPTS). The ROOT fix already
shipped — the job row carries its submission_id, so a reclaim resumes instead of
restarting — and this is the second line for any path that bypasses it. The edge
now passes `grade-batch-job:{jobId}`, keyed on the JOB because that is what a
reclaim re-runs.

**Verified against a real database before being written down** (applied to the
local stack, exercised in a transaction, rolled back): the same key three times
debits ONCE (balance 10 → 7 → 7 → 7, exactly one ledger row); a different key
debits normally; and a call with NO key debits every time, which is what keeps
the existing callers correct.

**Apply:**

1. Run `supabase/migrations/00516_debit_grade_credits_idempotency.sql`.
2. `NOTIFY pgrst, 'reload schema';` — the RPC signature changed.
3. Redeploy the edge (boot guard expects 00516).

**Verify:** grade one item. The balance should drop by exactly the tier cost, and
`grade_credit_transactions` should show one `grade_debit` row carrying an
`idempotency_key` of `grade-batch-job:…` for batch grades.

---

## ✅ APPLIED: 00515_flipdesk_listing_page.sql (US-2168 AC3 server-side row selection, applied 2026-08-03)

**⚠️ THE LISTINGS PAGE NOW DEPENDS ON THIS.** An earlier draft of this entry said
nothing called it yet; that is no longer true. `src/pages/flipdesk/listings.tsx`
calls `flipdesk_listing_page` for every render of the inventory table, so on a
database without this migration the table shows an error instead of rows.

**Order matters.** Cloudflare Pages auto-deploys the frontend on push. Apply
this BEFORE pushing, or the inventory table is broken for the window between
the Pages deploy and the migration.

It adds one collation and four functions; it changes no table, no column and no
existing function, so there is nothing to back out of.

**What it adds:**

- `public.natural_ci` — an ICU collation (`en-u-kn-true-ks-level1`) that matches
  JavaScript's `localeCompare(numeric:true, sensitivity:"base")`, so a
  server-side column sort orders identically to the client sort it replaces.
- `flipdesk_filter_matches(jsonb, jsonb)` — SQL mirror of `evalQuery()`.
- `flipdesk_listability_score(jsonb)` / `flipdesk_max_comp_price(jsonb)` — SQL
  mirrors of the two computed sort keys.
- `flipdesk_listing_page(...)` — one page of the listings table, filtered,
  searched, sorted and counted server-side. It also returns `soldAgg` (over the
  whole FILTERED set) and `buyerCounts` (over the whole ACCOUNT), because both
  are numbers the page used to derive from every row and would otherwise
  silently become per-page numbers. `p_columns` carries the page's own column
  list so the wire is not widened to all 61 columns.

**SECURITY INVOKER on purpose.** `items_full` is `security_invoker = on` (00010),
so RLS scopes these to the calling seller. They are granted to `authenticated`
and are called from the BROWSER, not the edge — the opposite of US-2393's case,
and the reason the guard question does not arise here. Making
`flipdesk_listing_page` `SECURITY DEFINER` would turn it into a cross-tenant
read; do not.

**Verified before being written down:** the parity harness
(`src/test/listing-page-sql-parity.test.ts`) seeds a corpus, reads the rows back
out of `items_full`, and runs BOTH the TypeScript `selectListingRows` and this
SQL over those same rows — 73 cases covering 8 tabs, 4 sort presets, 24 column
sorts, 6 searches, 5 sold-filter windows and 18 advanced filters, the Sold
aggregate strip, the repeat-buyer counts, and a paging check that no row is
dropped or repeated. All 73 match on row ids **and order**. Re-run with:

```
LISTING_PARITY_DB=1 npx vitest run src/test/listing-page-sql-parity.test.ts
```

**Apply:**

1. Run `supabase/migrations/00515_flipdesk_listing_page.sql`.
2. `NOTIFY pgrst, 'reload schema';` — new RPCs; PostgREST 404s them until it
   reloads.
3. Redeploy the edge (boot guard expects 00515).
4. Then push.

**Verify:** open FlipDesk → Inventory. The table should list items, the header
should read "N items", tab switching and search should still work, and paging
should move through the set. If the function is missing the table errors rather
than rendering a wrong subset, which is the intended failure direction.

---

## ✅ APPLIED: 00514_admin_metrics_service_role_guard.sql (US-2393 admin System 500, 2026-08-02 · applied — measured 2026-08-03)

**This one fixed a LIVE outage** — the admin System tab had been returning 500 —
**and it was independent of 00513.** Applied 2026-08-03.

**What it does.** Recreates `admin_system_metrics()` and
`admin_revenue_metrics()` with one line changed each: the guard becomes
`auth.role() = 'service_role' or public.is_admin()` (the 00207/00227 pattern).
Nothing else about either function changes — the bodies are
`pg_get_functiondef()` output, generated rather than retyped, so the diff cannot
carry a behaviour change alongside the fix.

**Why.** Both are called from `GET /api/admin/dashboard/system` through
`supabaseAdmin`, the service-role client. `is_admin()` identifies the caller via
`auth.uid()`, which is NULL for a service-role JWT — it has no `sub`. So the
guard raised 42501 on *every* call and the route has been answering **500** ever
since US-1565 moved that page behind the edge admin boundary. Confirmed against
a real database on 2026-08-02, not inferred: `set local role service_role;
select public.admin_system_metrics();` → `ERROR: admin_system_metrics: admin
role required`.

**Security: nothing is given up.** The route is already gated by the edge admin
middleware (JWT + role + AAL2 + audit) — that is exactly what US-1565 moved it
there for — and an authenticated non-admin is still refused by the `is_admin()`
half. Both directions were verified locally after applying: service-role
succeeds, and an authenticated non-admin still raises 42501.

**Risk: LOW.** `CREATE OR REPLACE FUNCTION` only, re-runnable, no schema change.

**Apply:**

1. Run `supabase/migrations/00514_admin_metrics_service_role_guard.sql`.
2. `NOTIFY pgrst, 'reload schema';` (function bodies changed).
3. Redeploy the edge (boot guard expects 00514).

**Verify:** open the admin **System** tab. It should render queue depth,
processing time, storage and subscription numbers instead of failing to load.

---

## ✅ APPLIED: 00513_admin_dashboard_aggregates.sql (US-2390 exact admin KPIs, 2026-08-02 · applied — measured 2026-08-03)

**What it does.** Adds three read-only aggregate functions and nothing else — no
table, column, index or enum is touched, so there is no data migration and
nothing to back out of:

- `admin_dashboard_aggregates(timestamptz)` — all-time average grade, the graded
  report count, and month-to-date revenue.
- `admin_dashboard_daily_series(timestamptz[])` — per-bucket submission /
  new-user / revenue counts for the dashboard's 30-day charts.
- `admin_platform_analytics(timestamptz[], int)` — funnel, plan mix, top users,
  cohort retention and the 90-day grade-volume trend.

All three are `SECURITY DEFINER` with the 00207/00227 guard
(`auth.role() = 'service_role' or is_admin()`), and both `authenticated` and
`service_role` get EXECUTE.

**Risk: LOW.** `CREATE OR REPLACE FUNCTION` only. Re-running is a no-op. Nothing
existing is altered, so applying it cannot affect any surface other than the
admin dashboard.

**⚠️ ORDER MATTERS, and the frontend is the reason.** The client half of this
commit stops reading `raw` from `GET /api/admin/dashboard/summary` and reads a
new `analytics` object instead. Cloudflare Pages auto-deploys the frontend the
moment this is pushed, but the edge redeploys separately — so between the push
and the Coolify deploy, the new admin dashboard talks to the OLD edge and the
Analytics tab renders zeros (an empty funnel, no cohorts, no top users). The
KPI cards and charts keep working. It is cosmetic and self-healing, but it is
visible, so apply and redeploy the edge promptly after pushing.

**Apply:**

1. Run `supabase/migrations/00513_admin_dashboard_aggregates.sql` against prod.
2. `NOTIFY pgrst, 'reload schema';` — **required**, these are new RPCs and
   PostgREST will 404 `/rpc/admin_dashboard_aggregates` until it reloads.
3. Redeploy the edge on Coolify (its boot guard now expects 00513).
4. Then OK the push.

**Verify after applying** — as the operator, on the admin dashboard: Average
Grade shows a number and reads "Across all grades"; the Analytics tab's funnel,
plan mix, top users and cohort table are populated. If the RPCs are missing the
summary endpoint returns 500 rather than rendering wrong numbers, which is the
intended failure direction.

---

## ✅ APPLIED: 00512_job_lock_holder_release.sql (US-2311 job-lock holder check, 2026-08-02 · applied — measured 2026-08-02)

> [!note] How 00510–00512 were confirmed, and what that evidence does NOT cover
> Flipped on 2026-08-02 from a live measurement, not from someone remembering.
> `GET https://functions.gradethread.com/health/ready` returned
> `schema {expected:"00512", applied:"00512", status:"match"}` — the US-1566
> block reading `applied_migrations` through the service-role client, i.e. the
> database's own answer rather than a config file.
>
> **The limit of that evidence.** `applied` is the recorded MAX. It proves 00512
> landed and that nothing above it is expected. It does **not** individually
> prove 00510 and 00511, because a mid-sequence gap is invisible to a maximum —
> that is US-2009's whole subject, and the blind spot that let 00005 never land
> while the watermark moved on regardless. Section 1 of
> `scripts/prod-diagnostics.sql` answers it properly by listing gaps.
> **If that query reports a gap at 00510 or 00511, flip the heading back and
> apply the file.** Every migration here is idempotent, so re-running one that
> did land costs nothing.
>
> **Why flipping was safe either way.** All three were already on `origin/main`
> before this. The hold was blocking future pushes of unrelated work, not
> holding these back — so the code-ahead-of-schema risk the gate exists to
> prevent had already resolved one way or the other, and the doc was simply
> out of date. Precedent: the same measurement cleared 00475/00476 on
> 2026-07-18 (recorded on US-1880).

- **Apply order.** After 00511. Idempotent: `DROP FUNCTION IF EXISTS` then
  `CREATE OR REPLACE FUNCTION`, the whole file in one transaction. Verified safe
  to re-run — `DROP FUNCTION` matches the declared signature exactly and ignores
  defaults, so a second run does **not** drop the new two-arg function.
- **What it does.** Replaces `release_job_lock(p_job text)` with
  `release_job_lock(p_job text, p_holder text default null)`, whose DELETE adds
  `AND (p_holder is null or holder = p_holder)`. The `holder` column and the
  `try_acquire_job_lock` parameter that fills it have both existed since 00094;
  nothing ever passed a value.
- **Why.** The old release was an unconditional DELETE, so a run whose lease
  expired — and whose lock was then legitimately stolen by the next tick — went
  on to delete the NEW holder's live lock when it finished. The tick after that
  acquired freely and ran concurrently. Worked example on `autolister-reclaim`
  **as it was before this commit** (300s lease, `*/5` schedule, so lease ==
  interval exactly): tick 1 acquires at 0:00, tick 2 steals at 5:00, tick 1
  releases at 5:30 and destroys tick 2's lock, tick 3 acquires at 10:00 alongside
  the still-running tick 2. Mutual exclusion does not degrade there, it
  disappears. The same commit raises that lease to 600s (and six others like it),
  so the example describes a configuration this change removes — the holder check
  is the fix, the lease bump is defence in depth.
- **Risk: LOW.** Strictly narrows a DELETE, and the SQL is wrapped in
  `begin`/`commit` so there is no window in which the function is missing.
  **Apply-order, both directions:**
  - *SQL first, old edge still live* — safe. The deployed build sends only
    `p_job`, which binds to the new two-arg function through its default and
    behaves exactly as today.
  - *New edge first, SQL not yet applied* — degraded, not corrupting, and it
    should not be reachable. The new build sends `{p_job, p_holder}`, which
    PostgREST cannot bind to the old one-arg function (PGRST202); `job-lock.ts`
    catches it and logs `job.release_failed`, so locks expire on lease instead of
    releasing early. The boot guard makes a confirmed-behind DB fatal, so the
    only way to reach this is the fail-OPEN branch where the guard cannot read
    the tracker at all.
- **Why the one-arg function is dropped rather than kept alongside.** Two
  overloads where one has a defaulted second argument makes a *one-arg*
  named-argument call from PostgREST ambiguous (`function is not unique`;
  reproduced). Dropping it is what keeps the old edge working, not what breaks
  it.
- **⚠ The grant trap — the one thing to actually watch.** `DROP FUNCTION`
  discards the ACL, and a re-created function is a brand-new object that inherits
  nothing. `CREATE OR REPLACE` (what every other migration here does) preserves
  the ACL, so this hazard is unique to this file. Privileges would otherwise come
  only from the **applying role's** `alter default privileges`: apply as
  `postgres` and `service_role` gets EXECUTE back, apply as any other superuser
  and it does not — every `release_job_lock` call from the edge then returns
  42501 and locks only ever expire on lease. The migration therefore names the
  grant explicitly (`grant execute ... to service_role`) instead of relying on
  that, alongside the restated `REVOKE ALL ... FROM public, anon, authenticated`.
  If you apply by hand, do not stop after the `CREATE`. Verify after:
  `select proowner::regrole, proacl from pg_proc where proname = 'release_job_lock';`
- **CLIENT reads/writes.** None. `job_locks` is service-role only; grepped `src/`,
  `ios/`, `android/` and `functions/` for `job_locks` / `release_job_lock` — no
  matches anywhere, so a frontend auto-deploy changes nothing.
- **After applying:** `NOTIFY pgrst, 'reload schema';` **is** required and is
  load-bearing here — PostgREST caches function signatures, so without it the new
  edge's two-arg call is rejected even against a correctly migrated DB.

---

## ✅ APPLIED: 00511_submissions_protected_columns_guard.sql (US-2376 submissions guard, 2026-08-01 · applied — measured 2026-08-02)

- **Apply order.** After 00510. Idempotent: `CREATE OR REPLACE FUNCTION`,
  `COMMENT ON FUNCTION`, `DROP TRIGGER IF EXISTS` then `CREATE TRIGGER`. Safe to
  re-run.
- **What it does.** Adds a BEFORE UPDATE trigger on `public.submissions` that
  raises if an `authenticated`-role caller changes any grading-lifecycle column:
  `status`, `payment_status`, `service_tier`, `authenticity_addon`,
  `refunded_at`, `flagged`, `flag_reason`, `moderation_status`,
  `grading_started_at`, `grading_lease_until`, `grading_attempts`,
  `superseded_at`, `superseded_by_submission_id`. Exact counterpart to
  `guard_users_protected_columns` (00331), including the
  `auth.role() <> 'authenticated'` short-circuit that lets the service-role edge
  client and SECURITY DEFINER paths through untouched.
- **Why.** "Users can update own submissions" (00451) is USING-only — no
  `WITH CHECK`, no column list — and the only other trigger on the table just
  stamps `updated_at`. So a seller holding their own JWT could PATCH their own
  row and set `status='completed'`, clear `refunded_at`, unset `flagged`, or
  reset `superseded_at` to pull a retaken submission back into the active count
  the monthly quota is measured against. This is US-2376's AC4 for the
  submissions half.
- **Risk: LOW-MEDIUM.** It removes a capability, so the risk is a legitimate
  writer being blocked. Verified there is none: no web, iOS or Android client
  writes `public.submissions` at all (the SPA's only two writes were the admin
  ones this same commit moved to the edge), and every server path — the grading
  pipeline, the stuck/abandoned sweeps, the admin routes — uses the service-role
  client, which the short-circuit exempts. Seller-editable fields (title,
  description, brand, garment_type/category, style_attributes,
  verified_capture_opt_in) are deliberately NOT in the list and stay writable.
- **CLIENT reads/writes.** None new. Nothing in the frontend reads or writes any
  column this touches, so the frontend deploying first changes nothing.
- **⚠ The 00076 failure mode, and how it was ruled out.** PL/pgSQL resolves
  `NEW.<field>` at RUNTIME, so a trigger naming a column that doesn't exist
  throws `42703` on EVERY update of the table — that is exactly what 00076 did to
  `public.users` for 255 migrations. This one was exercised against a live DB, not
  reasoned about: `supabase db reset` from zero on the local stack (2026-08-01),
  then, per column, an UPDATE under `request.jwt.claims = {"role":"authenticated"}`.
  All thirteen raised; a title-only UPDATE **succeeded**, which is the load-bearing
  case — it forces the whole OR-chain to evaluate to false, so every one of the
  thirteen field references provably resolves. A service-role UPDATE setting
  `status='failed'` also succeeded.
- **After applying:** `NOTIFY pgrst, 'reload schema';` is not strictly required
  (no table/column/RPC shape change), but run it anyway with 00510's.
- **Deploy order.** No ordering constraint of its own — safe before or after the
  frontend. Follow 00510's sequence and apply this straight after it.

---

## ✅ APPLIED: 00510_prompt_versions_service_role_writes.sql (US-2348 prompt writes, 2026-08-01 · applied — measured 2026-08-02)

- **Apply order.** After 00509. Idempotent: three `DROP POLICY IF EXISTS` and
  one `COMMENT ON TABLE`. Safe to re-run.
- **What it does.** Revokes the RLS INSERT/UPDATE/DELETE policies on
  `ai_prompt_versions` that 00003 granted to every `is_admin()` caller. No
  replacement policy is created: with RLS on and no permissive policy for a
  command, that command is denied for every non-service role, and the edge's
  service-role client bypasses RLS entirely. The SELECT policy is deliberately
  KEPT — the admin UI still lists prompts directly.
- **Risk: MEDIUM — this one is order-sensitive.** It removes a capability the
  frontend currently uses. Cloudflare Pages auto-deploys the frontend on push,
  and the SAME commit repoints all four writes at
  `/api/admin/grading/prompts`, so the frontend is fine either way. What is NOT
  fine is applying the SQL while an OLD frontend build is still live: prompt
  create/edit/delete/deactivate would fail with an RLS error until the new
  build lands. The window is small and the surface is admin-only, but prefer
  SQL AFTER the frontend deploy here, which is the opposite of the usual order.
- **New edge routes in the same commit.** `PATCH /api/admin/grading/prompts/:id`
  and `DELETE /api/admin/grading/prompts/:id` do not exist in the deployed edge
  yet. Until the edge redeploys, the new frontend's edit and delete buttons 404.
  So: frontend deploy → edge redeploy → SQL is the safe sequence, and the edge
  redeploy must not lag.
- **CLIENT reads/writes.** Reads are untouched. Writes move entirely to the
  edge.
- **After applying:** `NOTIFY pgrst, 'reload schema';` — policies changed, and
  PostgREST caches them.
- **Deploy order.** frontend → edge → SQL (00508, 00509, then 00510).

---

## ✅ APPLIED: 00509_ebay_shipping_labels.sql (US-2160 buy eBay labels, 2026-07-31 · applied 2026-08-01)

- **Apply order.** After 00508. Idempotent: `ADD COLUMN IF NOT EXISTS`,
  `COMMENT ON COLUMN`, `CREATE INDEX IF NOT EXISTS`. Safe to re-run.
- **What it does.** Three columns. `marketplace_connections.logistics_access_denied`
  (boolean, default false) mirrors the existing `negotiation_access_denied` — a
  sticky flag set when a connection's token 403s a `/sell/logistics` call, so
  the label surfaces gate cheaply instead of re-probing eBay. `sales.ebay_shipment_id`
  and `sales.label_purchased_at` record a label bought in FlipDesk; the shipment
  id is what a reprint and a void need. The label PRICE goes into the existing
  `sales.shipping_cost`, so Finances and the per-item P&L need no change.
- **Risk: LOW.** Three new nullable/defaulted columns and one partial index. No
  existing column, view, enum or policy changes. `logistics_access_denied` has a
  `NOT NULL DEFAULT false`, so the rewrite is metadata-only on Postgres 11+.
- **CLIENT reads/writes.** The SPA does NOT read these columns directly — the
  ship dialog calls the edge (`/api/flipdesk/logistics/*`). A frontend deploy
  ahead of the SQL degrades to the capability probe failing closed, which HIDES
  the "Buy a label" block entirely (`useEbayLogisticsCapability` returns
  unavailable on a non-OK response). The manual tracking-number path is
  untouched. So the frontend-first ordering is safe here, not just tolerable.
- **After applying:** `NOTIFY pgrst, 'reload schema';` — PostgREST must learn
  the new columns or the label routes 400 at the API layer.
- **Deploy order.** SQL (00508 then 00509) → edge redeploy (its boot guard now
  expects 00509) → frontend.
- **NOT a blocker for the feature being off.** `sell.logistics` is a limited-
  release eBay scope that is deliberately absent from the default consent list
  (same posture as `sell.negotiation`, US-1967). Until the prod keyset is
  granted it and `EBAY_SCOPES` names it, `/capabilities` reports
  `feature_unavailable` and no label UI renders. The migration is still needed
  first so the edge boots.

---

## ✅ APPLIED: 00508_marketplace_event_item_link.sql (US-2156 automation triggers, 2026-07-31 · applied 2026-08-01)

- **Apply order.** After 00507. Idempotent: `ADD COLUMN IF NOT EXISTS`,
  `COMMENT ON COLUMN`, `CREATE INDEX IF NOT EXISTS`. Safe to re-run.
- **What it does.** Adds one nullable column,
  `marketplace_event_notifications.item_external_id` (the eBay legacy item id
  the offer/return happened on), plus a partial index for the automation
  lookup. The ledger already records WHICH event; this records WHAT it happened
  to, so the new `offer_received` and `return_opened` automation triggers can
  join it to `listings.platform_listing_id`.
- **Risk: LOW.** New nullable column on a service-role-only table. It is NOT
  part of the table's unique dedup key, so the US-1055 poll's idempotency is
  unchanged. Existing rows stay null and simply produce no automation match.
- **CLIENT reads/writes.** None. The SPA never touches this table — it is
  service-role-only (deny-all to anon/authenticated, classified in
  `SERVICE_ROLE_ONLY` in `rls-guard_test.ts`). So a frontend deploy ahead of
  the SQL changes nothing on the web app.
- **What breaks if the edge deploys first.** The poll's insert would name a
  column PostgREST doesn't know, so `claimMarketplaceEvent` fails-closed and
  offer/return/dispute notifications go quiet until the SQL lands. Apply the
  SQL first.
- **After applying:** `NOTIFY pgrst, 'reload schema';` — PostgREST must learn
  the new column or every insert naming it 400s at the API layer.
- **Deploy order.** SQL → edge redeploy (its boot guard now expects 00508) →
  frontend.

---

## ✅ APPLIED: 00507_autolister_handoff_sessions.sql (US-2374 phone → desktop handoff, 2026-07-31)

- **Apply order.** After 00506. Idempotent: `CREATE TABLE IF NOT EXISTS`,
  `CREATE INDEX IF NOT EXISTS`, `DROP POLICY`/`CREATE POLICY`,
  `DROP TRIGGER`/`CREATE TRIGGER`. Safe to re-run.
- **What it does.** Adds `public.autolister_handoff_sessions` — one row per
  batch the mobile app parks for the desktop AutoLister, holding the staged
  photo list and the grouping as JSONB. Owner-readable + owner-deletable via
  RLS; every write goes through the service-role edge client.
- **Risk: LOW.** New table only. Nothing existing reads or writes it, and no
  column, view or enum changes.
- **CLIENT reads/writes.** The SPA does NOT query this table directly — the
  AutoLister page calls the edge (`GET/POST/DELETE
  /api/flipdesk/autolister/sessions*`). So a frontend deploy ahead of the SQL
  degrades to the "Waiting from your phone" card never appearing (the list call
  500s and TanStack Query keeps an empty array), NOT a broken page. The iOS
  "Send to desktop" button fails with its own error banner until the table
  exists.
- **After applying:** `NOTIFY pgrst, 'reload schema';` — PostgREST must learn
  the new table or every edge call against it 404s at the API layer.
- **Deploy order.** SQL → edge redeploy (its boot guard now expects 00507) →
  frontend. The edge is what actually needs the table.

---

## ✅ APPLIED: 00506_items_full_quality_score.sql (US-2170 sortable quality score, 2026-07-30)

- **Apply order.** After 00505. Idempotent `CREATE OR REPLACE VIEW` (no DROP, so
  the analytics RPCs that SELECT from items_full are never observably absent).
- **What it does.** Exposes `listings.quality_score` (00476) as a new LAST column
  `quality_score` on the `items_full` view, so the inventory table can sort by
  the Listing Quality Score. Body is verbatim from 00438 plus the one column.
- **CLIENT reads/writes.** The SPA now reads `quality_score` off items_full rows
  (`ItemFullRow`, listings.tsx Quality column). If the frontend deploys before
  this applies, the column is simply absent → the row reads it as `undefined` and
  the Quality column sorts as "unscored"; it does NOT 42703 (the value is read
  from the already-selected row set, not a new filter). Low blast radius, but
  apply in order anyway.
- **If it stays unapplied.** Sorting by Quality is inert (all rows unscored)
  until applied; nothing breaks.
- **`NOTIFY pgrst, 'reload schema';`** after applying (the view changed).

---

## ✅ APPLIED: 00505_grading_roi_period_filter.sql (US-2234 AC3 grading-ROI presets, 2026-07-30)

- **Apply order.** After 00504. Idempotent (DROP FUNCTION IF EXISTS the 0-arg
  overloads, then CREATE OR REPLACE the 1-arg versions; grants; footer).
- **What it does.** Adds `p_period_start date default null` to
  `flipdesk_grading_roi()` and `flipdesk_grading_roi_summary()` so the Grading-ROI
  analytics tab can honour period presets like its siblings. Filters exactly like
  `flipdesk_sell_through` (sale_date/list_date `>= p_period_start`).
- **CLIENT reads/writes — SAY IT LOUD.** The SPA now CALLS these RPCs WITH
  `p_period_start` (`src/lib/flipdesk-analytics-server.ts` fetchGradingRoi /
  fetchGradingRoiSummary, driven by `analytics.tsx` GradingRoiReport). If the
  frontend auto-deploys before this migration is applied, the argless overload is
  gone and the new call passes an arg the old function never had → the Grading-ROI
  tab errors. ~~Apply 00505 to prod BEFORE the push.~~ (done — applied 2026-07-31.)
- **If it stays unapplied.** The Grading-ROI tab breaks once the frontend deploys
  (see above). Until the frontend deploys, prod is unaffected.
- **`NOTIFY pgrst, 'reload schema';`** after applying (functions changed).

---

## ✅ APPLIED: 00504_listings_is_active_lockstep.sql (US-2176 is_active lockstep, 2026-07-30)

- **Apply order.** Follows 00503. Idempotent (CREATE OR REPLACE FUNCTION, DROP
  TRIGGER IF EXISTS then CREATE TRIGGER, a guarded backfill DO block) — safe to
  re-run.
- **What it does.** Makes `listings.is_active` a derived mirror of
  `listing_status`: a BEFORE INSERT/UPDATE trigger (`trg_listings_sync_is_active`)
  sets `is_active := listing_status IN ('active','relisted')`, so the column is
  no longer independently writable, and a never-published draft is no longer born
  `is_active=true`. A backfill corrects existing rows where the two disagree and
  `RAISE NOTICE`s the corrected row count.
- **CLIENT reads/writes.** No NEW client read of a new column — `is_active` and
  `listing_status` already exist. The same commit DROPS the redundant
  `.eq("is_active", true)` from the storefront query
  (`content-public.ts loadStorefrontListings`), which keeps the authoritative
  `.eq("listing_status","active")` — so the storefront is correct whether or not
  the trigger has been applied yet. Nothing 42703s if this lands unapplied.
- **If it stays unapplied.** No breakage: existing code already writes `is_active`
  in lockstep by hand, so behaviour is unchanged until the trigger takes over
  enforcement. The backfill is the only thing that needs prod to run.
- **`NOTIFY pgrst, 'reload schema';`** after applying (a function + trigger changed).
- **Verification.** US-1108 triple green (`schema-version_test.ts` 18/18) AND
  db-lane verified — `npm run verify:db` re-applied the whole tree from zero
  (2026-07-30, green), so 00504 provably applies on a fresh schema.

---

## How this file works

The standing rule (US-1108, plus a direct instruction from the user): **a commit
containing a migration is committed locally but NOT pushed until the operator has
applied the SQL to prod.** Pushing runs ahead of the schema — Cloudflare Pages
auto-deploys the frontend the moment the branch lands, and the next Coolify edge
deploy boot-guards on `EXPECTED_SCHEMA_VERSION`.

So every held migration gets a section here before its commit, and the sections
are deleted once the operator confirms the apply.

### Adding a held migration

Add one `## ⏳ HELD: NNNNN_name.sql (US-#### short title, YYYY-MM-DD)` heading —
the exact shape matters, `.claude/hooks/session-context.mjs` parses it to warn at
the start of every session — then say:

- **Apply order.** Which migration it must follow, and why if that isn't obvious.
- **What it does**, in one paragraph. Objects created or altered.
- **Whether the CLIENT reads or writes anything new.** Say this LOUDLY if so.
  The SPA auto-deploys on push, so a client that writes a column the schema
  doesn't have yet breaks the moment the branch lands — that is the failure this
  whole file exists to prevent. Name the file and the code path.
- **Whether anything breaks if it stays unapplied.** A feature that degrades to
  its empty state is safe to push early; one that 42703s is not.
- **`NOTIFY pgrst, 'reload schema';`** whenever a table, column, or RPC changed.
- **Risk**, and whether it was exercised against a live DB (usually not — the
  `verify:db` lane needs Docker).

### Applying

1. Run the SQL in `NNNNN` order — `scripts/apply-prod-migrations.sh`, or by hand.
   Every migration is idempotent, so re-running the tail is safe.
2. `NOTIFY pgrst, 'reload schema';`
3. Redeploy the edge on Coolify.
4. Then push, and delete the section from this file.

### Clearing a section

Deleting the section is the whole job — this file is a queue, not an archive. The
reasoning is not lost: it lives in the migration's own header, in the story's
`prd.json` note, and in any vault note the migration's `code_refs` point at.

One more step, and it is easy to miss: a story whose `prd.json` note still calls
the migration HELD now says something false. `prd-lint` catches that (it warns on
any note claiming a hold for a migration already on `origin/main`), and because
notes are append-only the fix is to APPEND a `STATUS CORRECTION` line rather than
edit the original sentence.

## ✅ APPLIED: 00561_measure_card_tracking.sql (US-2231 — tracking on a mailed MeasureCard, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00560. No dependency between them; both only need to be
in before the code that reads them.

**Risk: LOW.** Two nullable `text` columns on `measure_card_requests`, no
default, no backfill, no constraint, no index. Nothing is rewritten and no
existing row changes. Old edge code that never mentions them keeps working.

**Apply BEFORE the edge deploy.** The new edge SELECTs `tracking_number` and
`tracking_carrier` on both the operator queue and the seller's own
`/card-request` read. If the edge goes first, PostgREST answers 42703 and the
MeasureCard status panel breaks for every seller — not just those with tracking.
The frontend does not read these columns directly, so a Cloudflare Pages deploy
is harmless on its own.

**`NOTIFY pgrst, 'reload schema';`** after applying — the columns are selected
by name through PostgREST.

**What it does, and what it deliberately does NOT.** US-2231 AC3 asks for an ETA
*and* a tracking number. Only tracking is here. Quoting "ships in 3–5 days" on a
page a paying seller reads is a promise the fulfilment process does not make, and
a date we cannot honour is worse than no date. The ETA needs a real SLA first.

**Both columns are NULLABLE on purpose.** Cards are mailed by hand and many go
out as untracked letters. NOT NULL would either stop the operator marking those
shipped or push them to type a placeholder — and a placeholder tracking number is
worse than an empty one, because the seller clicks it.

**Plaintext, unlike the street address on the same table.** US-2417 encrypts
ship_name/address_line1/address_line2/city/postal_code because they say where a
person lives. A tracking number is a carrier's identifier for a parcel, the
operator has to search and paste it, and it is the one field on the row the
SELLER is meant to read back — the same reasoning that keeps state and country
readable there.

**The refusal worth knowing about.** The bulk transition takes up to 500 ids and
tracking is per-parcel, so sending a number with a batch is REFUSED (400) rather
than applied. Stamping one carrier reference onto 200 sellers would give each of
them a link that tracks somebody else's parcel, which is worse than no tracking
because it looks authoritative.

**Verified on a throwaway local stack:** applied from clean and re-applied
(idempotent); the US-1108 self-record footer present; schema-version guard green
at 00561 with the manifest regenerated in the same pass.
