# PENDING MIGRATIONS — apply BEFORE pushing this branch to origin

## 📌 CURRENT STATE — 2026-07-02 (bulk-intake epic session)

### 🔸 NEW + HELD LOCALLY (not pushed): `00339` (US-1539)

**`supabase/migrations/00339_item_photos_provenance.sql`** — adds nullable
`item_photos.original_filename text` (+ a belt-and-suspenders
`captured_at timestamptz`, which most DBs already have from 00066). Idempotent
(`ADD COLUMN IF NOT EXISTS`), self-record footer, `EXPECTED_SCHEMA_VERSION`
bumped **00338 → 00339** in the same commit. Apply to prod +
`NOTIFY pgrst, 'reload schema';` BEFORE the edge redeploy that follows the next
push (its boot guard will expect 00339). Low-risk: nullable columns, no code
reads them server-side yet — the web AutoLister writes them at generate().
**Per the standing rule, the commit carrying 00339 stays local until you apply
it and say "OK to push".**

### Previously outstanding — apply to prod (already on origin)

Everything through migration **00338** is already ON `origin/main` (0230db73 was
pushed). What's outstanding is **applying to prod**, not pushing:

- **`00338_listings_marketplace_connection_id.sql`** (US-1507) — nullable
  `listings.marketplace_connection_id` FK + partial index; idempotent + self-record
  footer; `EXPECTED_SCHEMA_VERSION` is at **00338**. Legacy rows stay null (edge
  falls back to the primary connection). Safe to apply any time; MUST be applied
  before the next edge redeploy (boot guard expects 00338).
- If `00332`–`00337` haven't been applied yet either, apply them first — every
  migration is idempotent, so the simplest path is `scripts/apply-prod-migrations.sh`
  (or run 00332→00338 in order), then `NOTIFY pgrst, 'reload schema';`, then
  redeploy the edge.

**Held locally (NOT pushed):** 17e8b614 (autolister watchdogs) + this session's
US-1507/1509 completion commit — both code-only, no new migration. They stay local
until you apply 00338 (+ any earlier stragglers) and say "OK to push".

---

> Running package for the pre-launch loop. As of the latest push (af1b3d74), local main == origin/main and ALL committed stories are code-only (no migrations). Future migrations will be listed here for you to apply before the next push. At
> check-in, apply any migrations below to prod (DB → edge → frontend order per
> DEPLOY.md), redeploy the edge (Coolify), then give the OK to `git push`.

## 🔸 HELD (commit-only loop — NOT pushed): `00334` (US-1531)

**`supabase/migrations/00334_ai_enrichment_corrected_fields.sql`** — adds
`ai_enrichment_log.corrected_fields jsonb NOT NULL DEFAULT '{}'` (idempotent,
`ADD COLUMN IF NOT EXISTS`). `EXPECTED_SCHEMA_VERSION` bumped **00333 → 00334**.
Apply to prod (idempotent) + `NOTIFY pgrst, 'reload schema';` BEFORE pushing the
held US-1531 commit. No code reads the column yet (foundation chunk), so applying
it early is harmless.

---

## How to apply
1. Apply each migration SQL below to prod in listed order (they're idempotent).
   Or run `scripts/apply-prod-migrations.sh` if you prefer the scripted path.
2. Redeploy the edge service on Coolify so `EXPECTED_SCHEMA_VERSION` matches.
3. `NOTIFY pgrst, 'reload schema';` if any table/column/RPC changed.
4. Tell me "OK to push" — I'll `git push origin main`.

---

## ⚠️ STATUS UPDATE — commits PUSHED; migrations still must be APPLIED to prod

`origin/main` now includes US-1515 (`00332`) + US-1524 (`00333`). **Pushing to git
is NOT the same as applying the SQL to prod.** No immediate breakage from the push
alone (the edge only re-reads the schema version on a Coolify redeploy, and the new
iOS build isn't released yet) — BUT you must apply `00332` + `00333` to prod BEFORE:
  • redeploying the edge (its boot guard now expects `00333`; DB at `00331` →
    schema-guard failure after the ~40s grace window), and
  • releasing the new iOS build (US-1515 queries `updated_at` on sales/item_photos;
    missing column → PostgREST 400 on those syncs).
  • To fix the **Tag-rotation 400 now**, apply `00333` (independent of `00332`).

Apply order + steps below. Once applied, tell me and I'll push the remaining
code-only commit (US-1494).

---

## Original packaging note (apply `00332` then `00333`)

Apply IN ORDER (both idempotent, both end with the `applied_migrations` footer).
`EXPECTED_SCHEMA_VERSION` is bumped **00331 → 00333** (edge `schema-version.ts`).

**1. `supabase/migrations/00332_sales_item_photos_updated_at.sql`** (US-1515) —
adds `updated_at` (+ `set_updated_at` trigger + backfill + delta index) to
`public.sales` and `public.item_photos` so the iOS sync can delta them on EDITS.

**2. `supabase/migrations/00333_submission_images_owner_update.sql`** (US-1524) —
adds the missing per-user-folder UPDATE RLS policies (owner + workspace member) on
`storage.objects` for the private `submission-images` bucket. FIXES the reported
bug: rotating a **Tag / Certificate** photo returned HTTP 400 because the rotate
re-upload (`x-upsert`) is an UPDATE and that bucket had no UPDATE policy (only
INSERT/SELECT/DELETE). Public `item-photos` rotates fine (it has UPDATE).

**To apply (before I push the held commits):**
1. Apply `00332` then `00333` to prod — `scripts/apply-prod-migrations.sh` or run
   the SQL directly, in order.
2. `NOTIFY pgrst, 'reload schema';` (00332 adds columns).
3. Redeploy the edge (Coolify) so its boot guard sees `00333`.
4. Tell me "OK to push" — I'll push the held commits.

The US-1515 + US-1524 commits are **held locally, NOT pushed** until you apply
these — US-1515's iOS code queries `updated_at` (must exist first), and 00333 is a
pure prod-RLS fix (no code depends on it, but keep the schema-version in lockstep).

---

| US-1494 (iOS expense date integrity) | none | none | (held behind 00332/00333)

### Earlier stories this loop — code-only (already pushed, no schema changes)

| Story | Migration? | Schema bump? |
|-------|-----------|--------------|
| US-1505 (eBay specifics string[] normalize) | none | none |
| US-1506 (End-listing truthfulness) | none | none |
| US-1502 (grade → live eBay listing) | none | none |
| US-1503 (measurements → live listing) | none | none |
| US-1504 (price coherence) | none | none |
| US-1518 (photo thumbnail tier — edge job) | none | none |
| US-1522 (iOS UX dead-end sweep, 8 fixes) | none | none |
| US-1521 (iOS auth/signup polish) | none | none |
| US-1516 (iOS member-tenant item write) | none | none |
| US-1514 (iOS stale-read gating) | none | none |

`EXPECTED_SCHEMA_VERSION` unchanged at **00331**; latest migration file is
`00331_fix_users_guard_bogus_moderation_cols.sql`. Next migration, when one is
needed, is `00332`.

_This file is updated as the loop progresses — check it at every check-in._
