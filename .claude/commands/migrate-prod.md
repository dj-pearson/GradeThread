---
description: Walk the held-migration → prod apply runbook (US-1108)
argument-hint: [optional migration number, e.g. 00494]
allowed-tools: Bash(git:*), Bash(ls:*), Read, Grep, Glob, Skill
---

Apply held migrations to production. Target: **$ARGUMENTS** (all held, if empty)

**Load the `migrations` skill first** — it owns the full checklist and the
prod-apply runbook; this command is the sequence, not the contract.

1. Read `PENDING_MIGRATIONS.md`. List every `HELD` migration in apply order, and
   for each: what it changes, its stated risk, and whether it is flagged
   **apply-BEFORE-push**.
2. Verify the triple for each — idempotent SQL, self-record footer (00255+), and
   `EXPECTED_SCHEMA_VERSION` in
   `services/edge-functions/src/lib/schema-version.ts` matching the highest
   migration file. Report any drift; do not paper over it.
3. **Confirm a backup exists** before anything is applied (`vault/10-ops/backups.md`).
   Migrations are forward-only. State plainly if you cannot verify one.
4. The apply itself needs a prod connection string, so **do not run it yourself.**
   Give the user the exact command to run:
   `! SUPABASE_DB_URL="…" bash scripts/apply-prod-migrations.sh`
   (the `!` prefix runs it in this session so the output lands here). Point them
   at the vault for where the connection string is stored — never print, read, or
   echo the value.
5. After they report success: check the recorded version, run `NOTIFY pgrst,
   'reload schema';` if any migration added a column the API must expose, and
   spot-check anything the `PENDING_MIGRATIONS.md` entry flagged as unverified.
6. Only then remove the applied entries from `PENDING_MIGRATIONS.md`, and say
   which migrations are now clear to push behind.

If a migration fails mid-run, stop. Do not apply the rest — report which
succeeded, which failed, and the error.
