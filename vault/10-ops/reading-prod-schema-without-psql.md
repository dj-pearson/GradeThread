---
title: Reading the production schema without psql
type: runbook
status: current
source_of_truth: vault
code_refs:
  - scripts/prod-schema-audit.sql
  - scripts/prod-schema-probe.mjs
  - services/edge-functions/scripts/check-prod-migration.ts
  - services/edge-functions/src/routes/health.ts
reviewed: 2026-09-11
tags: [operator, postgrest, schema, prod, read-only]
summary: PostgREST publishes an OpenAPI document listing every exposed column, its nullability and every RPC, and /health/ready publishes the set of migrations prod has no record of - so a whole class of "go and run this in psql" operator steps can be answered from a laptop with no credentials at all.
---

# Reading the production schema without psql

A lot of stories end with an `OPERATOR:` step that is really just a schema
question — does this column exist, is it nullable, did that function land. Those
do not need a database session. PostgREST already publishes the answer.

```bash
curl -fsS -H "apikey: $ANON_KEY" \
     -H "Accept: application/openapi+json" \
     https://api.gradethread.com/rest/v1/ -o openapi.json
```

The anon key is the one that ships in the frontend bundle, so this needs no
credential anyone has to be careful with, and it is read-only by construction.
The document is about 1.8 MB.

## What it answers

| Question | Where |
|---|---|
| Does this column exist? | `definitions.<table>.properties.<column>` |
| What type is it? | that property's `format` / `type` |
| **Is it NOT NULL?** | the column appears in `definitions.<table>.required` |
| Does this RPC exist? | `paths["/rpc/<name>"]` |
| Was a function dropped? | that path is absent |

The nullability one is the surprise, and it is the most useful. `required` is
PostgREST's rendering of NOT NULL, so a column's absence from that array is a
positive statement that it is nullable — which is exactly the question a
`23502 null value in column ...` incident leaves you with.

```js
const j = JSON.parse(readFileSync("openapi.json", "utf8"));
const req = j.definitions.listings.required ?? [];
req.includes("listed_at");            // false -> nullable
Object.keys(j.definitions.listings.properties).length;  // 95 columns
```

## What it does NOT answer

- **Anything not exposed.** Only the tables and functions in the exposed schema
  appear. A deny-all operator table is invisible here and is not "missing".
- **Grants.** The document says a function exists, never who may execute it. For
  that see [[security-definer-exposure]].
- **Defaults, indexes, triggers, constraints other than NOT NULL.** A CHECK
  constraint does not appear, so `users_billing_source_chk` still needs psql.
- **Whether the cache is fresh.** It reflects PostgREST's schema cache, which is
  the point when diagnosing a `PGRST204`, and a trap otherwise: a migration
  applied without `NOTIFY pgrst, 'reload schema'` is invisible here while being
  perfectly present in the database.

That last one cuts both ways and is worth stating plainly. **This tells you what
the API can see, which is not always what the database holds.** For "did the
migration apply", ask `/health/ready`, which reads `applied_migrations` through
the service-role client. For "can the app use it", ask this.

## Is a SPECIFIC migration recorded? Also no credentials

`/health/ready` publishes more than a version number. Its `schema` block carries
`missing` — the **set difference** between the manifest the running build ships
and the versions `applied_migrations` actually holds. So an **absent `missing`
key is a positive statement** that every version in that manifest has a row.

```
$ deno run --allow-net --allow-env --allow-read \
    services/edge-functions/scripts/check-prod-migration.ts 00660
```

With `SUPABASE_SERVICE_ROLE_KEY` set it reads the table. Without one — or with
the placeholder most checkouts carry — it falls back to `/health/ready` and says
`APPLIED` / `NOT APPLIED` / `UNKNOWN` with the reason attached. Measured
2026-09-11: `expected 00784, applied 00785, no missing key`, so 00660 (the
durable record of the `listings.draft_id` repair) **is** recorded on prod.

**The ceiling is real and the script names it.** Three things it cannot settle:

- **Anything below 00254.** Pre-footer-era migrations carry no self-record
  footer, so no manifest has ever covered them and the completeness set cannot
  see them. That blind spot is not hypothetical — it is exactly how 00134's
  `listings.draft_id` stayed missing for months while every version above it was
  recorded (US-2726, US-2832). `scripts/prod-schema-audit.sql` is what answers
  for that range, and it needs a session.
- **Anything newer than the deployed build's `expected`.** Its manifest cannot
  contain a version it was built before, so its silence means nothing.
- **A read failure.** `complete: false` means the applied SET could not be read.
  It is reported as UNKNOWN, never as clean.

The maximum (`applied`) answers none of this on its own, and reading it as if it
did is the mistake. `apply-prod-migrations.sh` skips by maximum rather than by
membership (`[[ "$prefix" > "$current" ]] || continue`), so a hole beneath the
watermark is never re-applied and never noticed. See [[migrations-process]].

## The whole schema at once, not one column at a time

`scripts/prod-schema-audit.sql` holds the expected schema as a literal VALUES
block: every table, every column, every NOT NULL, every function. It is the
complete answer to "is anything missing from prod" and it needs a psql session,
which is why it sat unrun from the day it was written.

`node scripts/prod-schema-probe.mjs` runs the part of it that does not. It parses
the expectation out of that same `.sql` — one source of truth, never a second
copy — and diffs it against the OpenAPI document.

**Measured 2026-09-11:** 246 exposed tables and 3,103 columns checked, **no
missing column and no nullability drift**. 55 tables and 91 functions are not in
the document at all (deny-all RLS or unexposed); their absence proves nothing and
is never reported as a finding.

It does not replace the `.sql`. Indexes, triggers, defaults and CHECK constraints
are invisible to PostgREST, so `idx_listings_draft_id` still cannot be confirmed
this way, and neither can any of those 55 tables. What it does is shrink the
operator step from "audit the whole schema" to "audit the part nothing public can
see".

## Answered this way on 2026-08-21

Four stories, one request, no psql session:

- **US-2726** — `listings.draft_id` exists and is nullable, so the `PGRST204`
  was a stale cache rather than migration 00134 never reaching prod. The far
  less serious of the two possibilities, and the one that decides the fix.
- **US-2727** — `listings.listed_at` is absent from `required`, so 00634 landed
  and the column is nullable. 30 other columns are in that array.
- **US-2729** — all four agent columns are STILL NOT NULL in prod while every
  migration declares them nullable: `agent_proposals.evidence`,
  `agent_proposals.summary`, `agent_run_steps.name`, `agent_runs.trigger`.
  Prod stricter than the repo is the dangerous direction, because CI builds from
  the migrations and can never reproduce it.
- **00640** — `increment_grades_used` gone from `/rpc/`, `gt_require_role`
  present. The migration is reflected in the cache.
