---
description: Add a story to prd.json at nextId (and bump it), with real ACs
argument-hint: <what the story should cover>
allowed-tools: Bash(node scripts/prd-story.mjs:*), Bash(npm run prd:lint:*), Read, Grep, Glob
---

File a new prd.json story for: **$ARGUMENTS**

Before writing anything, **check it isn't already built or already filed.** A
duplicate story is worse than no story — grep the code for the feature and
search `prd.json` for overlapping titles. If it exists, say so and stop.

Then create it with:

```
node scripts/prd-story.mjs new --title "…" --description "…" --ac "…" --ac "…"
```

Rules:

- The script takes the id from `prd.json.nextId` and bumps it. **Never** compute
  `max(id)+1` — the high-id completed stories live in `prd.archive.json`, so that
  would silently reuse an id.
- `--description` is a user story: *As a <role>, I want <capability>, so that
  <outcome>.*
- Each `--ac` is a **falsifiable** criterion — something a reviewer can check and
  a test can assert. "Works well" is not an AC; "publishing a listing with no
  `item_photos` rows returns 422 with `error: 'photos_required'`" is. Repeat
  `--ac` per criterion.
- Ground the ACs in this repo: name the real routes, tables, and files the work
  touches. Read them first if you aren't sure they exist.
- If the work needs a migration, add an AC covering the US-1108 triple
  (idempotent SQL / `EXPECTED_SCHEMA_VERSION` bumped in the same commit /
  self-record footer).
- If the work adds an edge route on a multi-tenant table, add an AC covering
  tenant scoping plus a `tenant-isolation_test.ts` case (US-268).
- Add `--depends US-####` for real ordering dependencies only.

Then run `npm run prd:lint` and report the new id.
