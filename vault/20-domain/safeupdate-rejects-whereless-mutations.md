---
title: A WHERE-less UPDATE or DELETE works everywhere we test and fails in production
aliases: [safeupdate, 21000, DELETE requires a WHERE clause]
type: contract
status: current
source_of_truth: code
code_refs:
  - scripts/migrations-lint.mjs
  - scripts/migrations-lint.test.mjs
  - supabase/migrations/00777_ledger_rebuild_safeupdate.sql
  - supabase/migrations/00697_home_office.sql
  - src/lib/ledger.ts
reviewed: 2026-09-11
tags: [postgres, migrations, ledger, prod-only]
summary: Production loads the safeupdate extension and rejects any UPDATE or DELETE with no WHERE clause as SQLSTATE 21000. The local image does not have it, so the statement applies green locally, in verify:db and in CI, and fails for the first time on a real user's request — which is how one DELETE kept the Money tab at $0.00 for four months.
---
# A WHERE-less mutation is a production-only failure

Production loads the [`safeupdate`](https://github.com/eradman/pg-safeupdate)
extension. It refuses any `UPDATE` or `DELETE` with no `WHERE` clause and raises
**SQLSTATE 21000** — `DELETE requires a WHERE clause`. PostgREST maps 21000 to
**HTTP 400**.

The local Postgres image does not have the extension at all:
`pg_available_extensions` returns no row for it on the 17.6 image the Supabase
CLI boots (checked 2026-09-09). So the statement applies green locally, green in
`verify:db`, green in the `db-migrations` lane, and fails for the first time on a
real user's request in production.

That is the same shape as the `.or()`-on-a-mutation rule in `CLAUDE.md`
(US-1552), where the self-hosted prod PostgREST rejects a logical operator on an
UPDATE or DELETE that the newer local one accepts: prod's stack is stricter than
the one CI runs, in a way only a **write** can reveal. A read-shaped check
cannot find either one.

## What it cost

`DELETE FROM _acct;` was one line inside `rebuild_ledger_for_user`, the function
that derives a seller's whole ledger from their sales, expenses, payouts,
mileage and home office. It sits **before** anything is written, so the function
aborted on its first statement after the authorization check and no ledger row
was ever inserted for anybody.

Read off production on 2026-09-09 for the owner's own account, with nothing but
the anon key that ships in the browser bundle:

| | |
|---|---|
| `sales` | 220 |
| `flipdesk_expenses` | 8 |
| `ledger_accounts` | 33 |
| **`ledger_entries`** | **0** |

Every figure the Money tab derives from the ledger therefore read zero — the
overview cards, the entire Schedule C statement (gross receipts, COGS, gross
profit, net profit, all `$0.00` against 220 real sales), the reconciliation. It
read zero **confidently**: `ensureLedgerBuilt()` rebuilds only when the ledger is
empty, so the empty ledger is exactly the state that triggers the call that
cannot succeed, and the page renders a clean, wrong answer.

It survived four rewrites of the function. The line was written in `00685` and
carried forward verbatim by `00686`, `00691`, `00695` and `00697`, because
`CREATE OR REPLACE` takes a whole body and a rewrite copies whatever is in it.
`00777` is the fix.

## Write TRUNCATE, not `WHERE true`

`safeupdate` inspects the **planned** statement, and the planner constant-folds a
true qual away before it gets there. `DELETE FROM t WHERE true` may or may not
survive depending on the version — a coin flip is not a fix for a bug that hid
for four months.

`TRUNCATE` is a utility statement, not `CMD_DELETE`, so `safeupdate` never
inspects it. On a temp table it is also cheaper than the DELETE it replaces.

```sql
-- rejected in production, accepted everywhere we test
DELETE FROM _acct;

-- correct
TRUNCATE TABLE _acct;
```

If you genuinely mean to touch every row of a real table, name the predicate
that says so (`WHERE user_id = p_user_id`) rather than reaching for a tautology.

## The guard

`scripts/migrations-lint.mjs` fails any **new** WHERE-less `UPDATE` or `DELETE`
under `supabase/migrations/` (`whereLessMutations`). It runs in `npm run verify`
and in CI.

Two details that make it a guard rather than a tripwire that everyone silences:

- A statement is only recognised where one can **start** — at the beginning of a
  file or after `;`, `begin`, `then`, `else`, `loop`, `declare`, or a `$$` body
  opener. Without that anchor, `FOR UPDATE`, `ON UPDATE CASCADE`,
  `BEFORE UPDATE ON` and a policy named `"update own profile"` all match, and the
  first cut of the rule produced 41 KB of findings with nothing real in it.
- The five already-applied instances are grandfathered **by name** in
  `WHERELESS_GRANDFATHERED`, and an entry that stops matching fails as loudly as
  a new violation — so the list can only shrink. Applied migrations are
  immutable, so the honest reason for one to disappear is a later migration
  replacing the object, never an edit to a shipped file.

`scripts/migrations-lint.test.mjs` proves the rule fires rather than asserting
the tree is clean today: cases for a WHERE-less DELETE, a WHERE-less UPDATE, two
mutations in a row, and a statement inside a dollar-quoted function body — plus
the non-firing cases above. See [[guards-that-cannot-fail]] for why that
distinction is the whole point.

## Related

- [[postgres-revoke-from-anon-is-a-noop]] — the other migration-shaped rule that
  is valid SQL, applies green, and does nothing you intended.
- [[states-that-look-normal]] — the wider pattern: a page that renders fine and
  is wrong.
- [[books-and-taxes]] — what the ledger is for.
