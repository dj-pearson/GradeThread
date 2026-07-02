# PENDING MIGRATIONS — apply BEFORE pushing this branch to origin

> Running package for the pre-launch loop. As of the latest push (af1b3d74), local main == origin/main and ALL committed stories are code-only (no migrations). Future migrations will be listed here for you to apply before the next push. At
> check-in, apply any migrations below to prod (DB → edge → frontend order per
> DEPLOY.md), redeploy the edge (Coolify), then give the OK to `git push`.

## How to apply
1. Apply each migration SQL below to prod in listed order (they're idempotent).
   Or run `scripts/apply-prod-migrations.sh` if you prefer the scripted path.
2. Redeploy the edge service on Coolify so `EXPECTED_SCHEMA_VERSION` matches.
3. `NOTIFY pgrst, 'reload schema';` if any table/column/RPC changed.
4. Tell me "OK to push" — I'll `git push origin main`.

---

## Status: ⚠️ 1 PENDING MIGRATION — apply `00332` before pushing US-1515

**`supabase/migrations/00332_sales_item_photos_updated_at.sql`** (US-1515) —
adds `updated_at` (+ `set_updated_at` trigger + backfill + delta index) to
`public.sales` and `public.item_photos` so the iOS sync can delta them on EDITS.
Idempotent; ends with the `applied_migrations` self-record footer.
`EXPECTED_SCHEMA_VERSION` bumped **00331 → 00332** (edge `schema-version.ts`) in
the same commit.

**To apply (before I push the US-1515 commit):**
1. Apply `00332` to prod (idempotent) — via `scripts/apply-prod-migrations.sh` or
   run the SQL directly.
2. `NOTIFY pgrst, 'reload schema';` (new columns).
3. Redeploy the edge (Coolify) so its boot guard sees `00332`.
4. Tell me "OK to push" — I'll push the held US-1515 commit (+ any later ones).

The US-1515 commit is **held locally, NOT pushed**, until you apply `00332` (its
iOS code queries `updated_at` on sales/item_photos — that column must exist first).

---

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
