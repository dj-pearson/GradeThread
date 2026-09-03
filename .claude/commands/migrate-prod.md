---
description: Walk the held-migration → prod apply runbook (US-1108)
argument-hint: [optional migration number, e.g. 00494]
allowed-tools: Bash(git:*), Bash(ls:*), Bash(npm run migrate:prod*), Bash(node scripts/migrate-prod.mjs*), Read, Grep, Glob, Skill
---

Apply held migrations to production. Target: **$ARGUMENTS** (all held, if empty)

**Load the `migrations` skill first** — it owns the full checklist and the
prod-apply runbook; this command is the sequence, not the contract.

1. Run `npm run migrate:prod` (read-only dry run) FIRST and treat its answer as
   the truth about prod. It asks the database which versions are recorded and
   compares by membership, so it catches a gap below the highest version — the
   thing `PENDING_MIGRATIONS.md` and `apply-prod-migrations.sh` both miss. The
   doc has been stale before (00724 and 00725 sat marked PENDING after they were
   applied). It reads `PROD_SSH_HOST` from the shell or the gitignored repo-root
   `.env`; if the command exits 2 saying it is unset, say so and ask rather than
   guessing a host. Never read or echo `.env` values.
2. Read `PENDING_MIGRATIONS.md`. For each migration the dry run listed: what it
   changes, its stated risk, and whether it is flagged **apply-BEFORE-push**.
   Report any disagreement between the doc and the dry run; do not paper over it.
3. Verify the triple for each — idempotent SQL, self-record footer (00255+), and
   `EXPECTED_SCHEMA_VERSION` in
   `services/edge-functions/src/lib/schema-version.ts` matching the highest
   migration file. Report any drift; do not paper over it.
4. The apply is destructive and forward-only, so **do not run it yourself.**
   Give the user the exact command:
   `! npm run migrate:prod -- --apply --yes`
   (the `!` prefix runs it in this session so the output lands here). It takes a
   `pg_dump` backup before the first migration and prints the path; add
   `--no-backup` only if they ask. It stops at the first failure and leaves the
   rest unapplied.
5. It sends `NOTIFY pgrst, 'reload schema';` itself on success. After the user
   reports the result: re-run the dry run to confirm nothing is pending, then
   spot-check anything the `PENDING_MIGRATIONS.md` entry flagged as unverified,
   and tell them to redeploy the edge on Coolify.
6. Only then flip the applied entries in `PENDING_MIGRATIONS.md` to
   `## ✅ APPLIED <date>:`, and say which migrations are now clear to push behind.

If a migration fails mid-run, stop. Do not apply the rest — report which
succeeded, which failed, and the error.
