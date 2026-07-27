---
description: Verify, commit and push the working tree to main (pre-prod workflow)
argument-hint: [optional commit subject]
allowed-tools: Bash(npm run verify:*), Bash(git:*), Bash(node scripts/prd-story.mjs:*), Read, Grep, Glob
---

Ship the current working tree. Commit subject hint: **$ARGUMENTS**

Run this in order and **stop at the first failure** — report it and fix it or ask;
never push past a red gate.

1. `git status --porcelain` and `git diff --stat`. Read the actual diff of every
   changed file. If something in the tree is unrelated to the work being shipped,
   flag it and ask before including it.
2. **Migration check.** If the diff touches `supabase/migrations/`, confirm the
   US-1108 triple — idempotent SQL, `EXPECTED_SCHEMA_VERSION` bumped in THIS
   commit, self-record footer present — and confirm `PENDING_MIGRATIONS.md` has
   an entry. If any held migration is marked **apply-BEFORE-push** (a client in
   this commit reads the new column), say so and STOP: the SQL must hit prod
   first, or Cloudflare Pages will deploy a frontend that queries a column that
   doesn't exist.
3. `npm run verify`. Docker-dependent lanes (`db`, `security`) self-skip with a
   warning — that's expected, but if the diff touches migrations or the edge
   Dockerfile, say plainly that those lanes did not run.
4. Stage and commit. Message: a `type(scope): subject` line, a blank line, a body
   explaining **why** — then one blank line and exactly:
   `Co-Authored-By: Claude <noreply@anthropic.com>`
   Nothing else. No session link, no model name, no second attribution line.
5. Push to `origin/main` — the pre-production override in `CLAUDE.md` says commit
   straight to main, no branch, no PR. If that override block is gone from
   `CLAUDE.md`, stop and ask: the normal branch-and-PR workflow has been
   restored.
6. Report the commit sha and what the `pre-push` hook (`npm run verify`) did.

Never use `--no-verify`. If the pre-push hook fails, fix the cause.
