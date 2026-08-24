---
name: migrations
description: "Use when creating or editing ANY file under supabase/migrations/, bumping EXPECTED_SCHEMA_VERSION (services/edge-functions/src/lib/schema-version.ts), applying migrations to prod, or committing work that contains a migration. Encodes the US-1108 migration triple (idempotent / version bump same commit / self-record footer), the US-2059 knowledge-in-a-note rule, the held-migration push rule, and the prod-apply runbook."
metadata:
  author: gradethread
  version: "1.0.0"
---

# GradeThread migrations — the US-1108 contract

Prod is a SELF-HOSTED Supabase; migrations apply via an explicit step, never
`supabase db push`. The edge container boot-guards on the schema version, so a
migration and its code MUST travel together and reach prod in the right order.

## The rules — every migration, no exceptions

1. **Idempotent**: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
   `CREATE OR REPLACE FUNCTION`, `CREATE INDEX IF NOT EXISTS`,
   `ADD VALUE IF NOT EXISTS` (enums), `DROP TRIGGER IF EXISTS` before
   `CREATE TRIGGER`, `DROP POLICY IF EXISTS` before `CREATE POLICY`. **It must be
   safe to run twice.** `scripts/migrations-lint.mjs` enforces this as of
   US-2837 — a `CREATE FUNCTION` that is not `CREATE OR REPLACE` fails at zero,
   and an unguarded `CREATE TRIGGER` / `CREATE POLICY` fails above 00291.

   Dropping first is still correct when the ARGUMENT LIST changes — adding a
   defaulted parameter creates a second overload rather than replacing the
   first — but keep `OR REPLACE` on the create anyway. On the second run the
   drop matches nothing and a bare `CREATE` aborts the whole file.
   `00609_appstore_transaction_environment.sql` is the worked example, and was
   the only migration in 658 that got this wrong.

   > ⚠ **`scripts/apply-prod-migrations.sh` does NOT re-run the whole
   > directory.** This line used to say it did. It reads the highest recorded
   > version and skips every file at or below it
   > (`[[ "$prefix" > "$current" ]] || continue`). The skip is by **maximum, not
   > by membership**, so a hole BELOW the maximum is never re-applied — which is
   > precisely how `listings.draft_id` from 00134 stayed missing in production
   > for months while every version above it was recorded (US-2726, US-2832).
   > An agent who believes the old sentence has no reason to go looking for the
   > hole. `scripts/prod-schema-audit.sql` is what actually answers "is anything
   > missing", and it is a read.
2. **`EXPECTED_SCHEMA_VERSION` bump in the SAME commit**
   (`services/edge-functions/src/lib/schema-version.ts`) = the new file's
   NNNNN. CI (`schema-version_test.ts`) enforces it — note the comparison is
   LEXICAL on the filename prefix.
3. **Self-record footer** — last line of every migration:
   `insert into public.applied_migrations (version) values ('NNNNN') on conflict do nothing;`
   This keeps the boot guard truthful no matter how the SQL was applied.
4. **Knowledge belongs in a note, not in the header** (US-2059). A migration
   whose name contains `knowledge`, or whose leading comment runs past **40
   lines**, must be referenced by `code_refs` from at least one vault note.
   `vault-lint` fails otherwise.

   **Why this is a rule and not a style preference:** applied migrations are
   IMMUTABLE. Knowledge left in a header can never be corrected — amending it
   means writing another migration whose only purpose is a fixed comment, which
   nobody does. US-2058 found **2,259 lines** of research reasoning stranded
   this way across 37 `*_brand_knowledge.sql` files: not editable, not indexed,
   invisible to anyone working on grading.

   Migrations at or below **00478** are grandfathered by number. Do NOT raise
   that threshold to silence a failure — write the note. See
   `vault/20-domain/brands/brand-taxonomy-overview.md` for the split: per-brand
   VALUES go in the table, per-corpus RULES go in a note.

5. **Regenerate the shipped manifest**: `node scripts/gen-migration-manifest.mjs`
   (writes `services/edge-functions/src/lib/migration-manifest.ts`). The boot
   guard compares this list against `applied_migrations`, so a stale manifest
   silently shrinks what it checks. `schema-version_test.ts` fails otherwise —
   and it fails inside the FULL `deno test` run, long after `deno check` and the
   web build have both gone green, which is where the minutes go.

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
