# Full-surface review, August 2026

The review covered every page of the web app and the iOS app in 20 batches. It
is COMPLETE. `REVIEW-FINDINGS.md` is what it found; `FIX-PROGRESS.md` is the
tracker that drives the fixes, and it carries the rules, the priority order and
the lessons learned per story.

Both files started life in a session scratchpad. They are in the repo so the
work can move between machines.

## Picking it up on another machine

1. Read `FIX-PROGRESS.md`. Take the first story not marked `[x]`, in priority
   order (ascending, lowest number first).
2. `node scripts/prd-story.mjs show US-####` — every open story is in
   `prd.json`, so the backlog itself needs nothing from these files.
3. Implement against the acceptance criteria. **Check the premise against the
   code first** — five stories in this batch turned out to describe something
   already built, and closing one as "already built" is a real outcome.
4. Verify: `npx tsc -b`, `npm run lint`, `npm run ui:check`, and the relevant
   vitest suites. Write a guard test and prove it red before the fix.
5. Close with `node scripts/prd-story.mjs done US-#### --note "..."`, then
   `node scripts/archive-passing-stories.mjs`, then commit BOTH json files.
6. Commit to local `main`. Do not push. A commit carrying a migration is never
   pushed until Dj OKs it — package it in `PENDING_MIGRATIONS.md`.
7. Tick the line in `FIX-PROGRESS.md` with the commit sha and append anything
   learned.

## What is blocked, and on whom

- **Needs macOS**: US-2503, US-2504, US-2531, US-2532, US-2533, US-2534,
  US-2557, US-2561. There is no swiftc or xcodebuild on Windows, and the macOS
  CI lane only runs on a push this branch must not make.
- **Needs Dj**: US-2528 (counsel has to sign off the Terms copy; the brief is at
  `docs/legal/terms-update-brief-2026-08.md`) and US-2535 (a product call on the
  onboarding taxonomy).
- **Needs Dj before ANY push**: migrations 00592 and 00593 are held. Apply the
  SQL and redeploy the edge first, or the auto-deployed frontend 404s.
