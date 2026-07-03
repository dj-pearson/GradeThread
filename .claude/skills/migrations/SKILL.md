---
name: migrations
description: "Use when creating or editing ANY file under supabase/migrations/, bumping EXPECTED_SCHEMA_VERSION (services/edge-functions/src/lib/schema-version.ts), applying migrations to prod, or committing work that contains a migration. Encodes the US-1108 migration triple (idempotent / version bump same commit / self-record footer), the held-migration push rule, and the prod-apply runbook."
metadata:
  author: gradethread
  version: "1.0.0"
---

# GradeThread migrations — the US-1108 contract

Prod is a SELF-HOSTED Supabase; migrations apply via an explicit step, never
`supabase db push`. The edge container boot-guards on the schema version, so a
migration and its code MUST travel together and reach prod in the right order.

## The triple — every migration, no exceptions

1. **Idempotent**: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
   `CREATE OR REPLACE FUNCTION`, `CREATE INDEX IF NOT EXISTS`,
   `ADD VALUE IF NOT EXISTS` (enums), `DROP TRIGGER IF EXISTS` before
   `CREATE TRIGGER`. It must be safe to run twice and safe to re-run the whole
   directory (`scripts/apply-prod-migrations.sh` does exactly that).
2. **`EXPECTED_SCHEMA_VERSION` bump in the SAME commit**
   (`services/edge-functions/src/lib/schema-version.ts`) = the new file's
   NNNNN. CI (`schema-version_test.ts`) enforces it — note the comparison is
   LEXICAL on the filename prefix.
3. **Self-record footer** — last line of every migration:
   `insert into public.applied_migrations (version) values ('NNNNN') on conflict do nothing;`
   This keeps the boot guard truthful no matter how the SQL was applied.

## Numbering

Next number = highest existing NNNNN + 1 — but a CONCURRENT agent may be
appending too: re-check `ls supabase/migrations | sort | tail` immediately
before creating the file, and never renumber an already-committed migration.

## 🔒 Held-migration push rule (STANDING, from the user)

A commit containing a migration is **committed to local main but NEVER
pushed** until the user explicitly OKs it — they apply the SQL to prod BEFORE
the push (Cloudflare Pages auto-deploys the frontend on push, and the next
Coolify edge deploy boot-guards the new version). Package every held migration
in `PENDING_MIGRATIONS.md`: what it does, risk level, apply order, and the
`NOTIFY pgrst, 'reload schema';` reminder. If code in the same commit READS
the new column/enum from the CLIENT side, say so loudly — that's what breaks
the moment the frontend auto-deploys.

## Prod apply runbook

1. Apply the SQL (in NNNNN order): `scripts/apply-prod-migrations.sh`, or run
   the files by hand. All idempotent, so re-running the tail is safe.
2. `NOTIFY pgrst, 'reload schema';` whenever a table/column/RPC changed.
3. Redeploy the edge on Coolify (its boot guard now expects the new version;
   there's a ~40s grace window, US-778, plus a pre-deploy migrate gate).
4. THEN push / OK the push.

## Local verification caveats

- `verify:db` boots a THROWAWAY local stack purely to prove migrations apply
  on a fresh schema (needs Docker). It never touches prod; `config.toml`
  configures only this local stack. Don't `supabase link`/`db push`.
- Operator tables with deny-all RLS must be registered in
  `SERVICE_ROLE_ONLY` in `rls-guard_test.ts` — see the tenant-isolation skill.
- New deny-all tables: name owner columns `owner_user_id` and keep the literal
  string `user_id` out of the CREATE TABLE block (rls-guard discovery trips on
  it, even in comments).

## Enum additions

`ALTER TYPE ... ADD VALUE IF NOT EXISTS` is fine on prod Postgres 12+ but the
new value can't be USED in the same transaction. Never `.eq`/`.neq` a new enum
value from edge code that might run before the migration applies — either
filter in JS or rely on the deploy-order guarantee (boot guard) and say which.
