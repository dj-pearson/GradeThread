# PENDING MIGRATIONS — apply BEFORE pushing this branch to origin

**Queue is empty.** Nothing is held. Schema is at **00503**, applied to prod on
**2026-07-29**, and `EXPECTED_SCHEMA_VERSION`
(`services/edge-functions/src/lib/schema-version.ts`) matches.

The last apply cleared `00493` → `00503`: the grade-dispute uniqueness index,
`submissions.overall_score` + its sync trigger, the non-destructive photo-edit
columns, `grade_reports.tag_read` and `.size_verification`, the sizing-chart
backfill and size-system columns, the authenticity reference table + private
bucket, and the registered-number / style-code observation tables.

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
