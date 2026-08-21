---
title: Reading the production schema without psql
type: runbook
status: current
source_of_truth: vault
code_refs:
  - scripts/prod-schema-audit.sql
reviewed: 2026-08-21
tags: [operator, postgrest, schema, prod, read-only]
summary: PostgREST publishes an OpenAPI document listing every exposed column, its nullability and every RPC - so a whole class of "go and run this in psql" operator steps can be answered from a laptop with the public anon key.
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
