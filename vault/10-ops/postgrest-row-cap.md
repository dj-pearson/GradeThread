---
title: PostgREST row cap (db-max-rows)
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/paged-read.ts
  - src/test/row-cap-contract.test.ts
  - src/hooks/use-items-full.ts
  - services/edge-functions/src/routes/admin-dashboard.ts
  - services/edge-functions/src/tests/admin-dashboard-kpi-provenance_test.ts
reviewed: 2026-09-03
tags: [postgrest, supabase, perf, correctness, flipdesk, admin]
summary: There is NO row cap in prod (db-max-rows is unset, read from pg_roles) — the bound that actually bites is an 8s statement_timeout, 3s for anonymous; every read must still page until empty, count without rows, or aggregate in SQL.
---

# PostgREST row cap (db-max-rows)

> **Re-reviewed 2026-09-03.** Drift flagged `src/test/row-cap-contract.test.ts`
> for `2fcefa411` (US-3077): the capped-surface list became `{ reads, renders }`
> pairs because the AutoLister drafts and scheduled drops reads moved into
> `use-autolister.ts` and `use-scheduled-drops.ts` so the overview widgets can
> count the same rows. Each pair must still call `fetchCapped()` in the hook and
> render the truncation notice on the page. The cap rule below is unchanged.

> **Re-reviewed 2026-08-17.** Drift flagged `use-items-full.ts` for `b0c2eda3`,
> which added a `DeleteBlockingListing` type so a refused delete can name the
> listings that blocked it (US-2657). It adds a shape, not a query: no new
> unpaged read, no `select('*')` over an unbounded set, no count-without-rows.
> The statement-timeout bound and the paging rule here are untouched.

## The fact this exists for

PostgREST clips **any** response at its `db-max-rows` setting. It reports the
clip in the `Content-Range` response header and nowhere else.

**supabase-js does not surface that header.** So an over-cap read returns a
short array with `error: null`. From the client, "the server truncated you" and
"that is all the rows there are" are the same value.

That makes it a correctness problem wearing a performance problem's clothes.
Every symptom is a plausible normal state: items missing from a kanban, a prep
queue that looks caught up, a reconciliation that finds no match, a bulk
markdown that skips listings the seller believes they just repriced.

## What the prod value is

**Measured 2026-08-01: there is no cap at or below 1055 rows.** A single
authenticated PostgREST request against prod (`api.gradethread.com`) for
`item_photos?select=id&limit=100000` returned **1055 of 1055** rows —
`Content-Range: 0-1054/1055`, no clip. Repeated across the six largest tables
reachable under RLS (`item_photos` 1055, `inventory_items` 840, `listings` 751,
`submission_images` 266, `sales` 176, `submissions` 38); every one came back
complete.

**Measured again 2026-08-05, this time from the server side, and it settles it:
`db-max-rows` is UNSET. There is no row cap.**

The 2026-08-01 probe could only ever prove a *bound* — you cannot detect a
ceiling you never reach, and the largest reachable table was 1055 rows. Reading
the configuration directly answers the question the probe could not:

```sql
SELECT rolname, rolconfig FROM pg_roles WHERE rolconfig IS NOT NULL;
```

PostgREST connects as `authenticator` and, with `db-config` on (the default
since v10), reads its settings from that role. On prod the role carries
`session_preload_libraries=safeupdate`, `statement_timeout=8s` and
`lock_timeout=8s` — **no `pgrst.db_max_rows`**. Nothing sets it in this repo
either: not `supabase/config.toml` (the throwaway local verify stack, see
[[blocked-work-gates]]) and not `docker-compose.coolify.yml` (the edge service,
not Kong or PostgREST — see [[dns-and-routing]]).

So three independent channels agree, and each rules out something the others
cannot: the empirical probe rules out any cap **≤ 1055**, the role config rules
out an **in-database** setting, and the repo rules out a **committed** one. The
one channel not read from here is a `PGRST_DB_MAX_ROWS` env var on the PostgREST
container itself — but a value from that channel at or below 1055 would have
shown up as a clip in the probe, so the only survivor is a cap *above* 1055,
which the code is deliberately built not to depend on (`fetchAllPages` advances
by rows **returned**).

## The real bound is a clock, not a row count

The same query turned up the constraint that *does* bite, and it is easy to miss
while looking for a row cap:

| Role | `statement_timeout` |
|---|---|
| `anon` | **3s** |
| `authenticated` | **8s** |
| `authenticator` | **8s** |

A read is not cut off after N rows; it is **killed after N seconds**. That
inverts the intuition this note is otherwise about — and it is why "page until
empty" is the right shape for a second reason nobody wrote down. Many bounded
round trips each finish well inside 8s. One unbounded query over a growing table
does not: it works, works, works, and then starts failing outright once the
table is big enough. That failure is at least *loud* (an error, not a short
array), which makes it the better failure of the two — but the fix is the same
paging, so there is no separate remedy to build.

Anonymous reads get **3s**, so the public surfaces (certificates, passports, the
sitemap feeds) have less than half the budget an authed one does. Weigh that
before adding a join to a public endpoint.

The assumption is named once, as `ASSUMED_DB_MAX_ROWS` in
`src/lib/paged-read.ts`, and asserted by `src/test/row-cap-contract.test.ts` —
not repeated in prose here.

**Re-measure the ROW cap only if someone sets one** — re-run the `pg_roles`
query above after any PostgREST reconfiguration. The 2026-08-01 volume trigger
("re-measure when a table passes ~1000 rows") is now retired: it existed because
the answer was a bound, and a bound expires as data grows. A read of the
configuration does not.

**The TIMEOUT is the one to watch as volume grows.** 8s (3s anonymous) is a
budget an unbounded query spends faster every month.

## The contract

Every client-side read of a table that can grow with a seller's account is one
of three shapes. The first two are fine; the third is the bug.

1. **Page until empty** — `fetchAllPages()`. Advances by the rows **actually
   returned** and stops only on an **empty** response. Never on a short one.
2. **Cap and say so** — `fetchCapped()`. Asks for `limit + 1` rows and drops the
   probe row, so `truncated` is evidence rather than a guess, and the surface
   renders `TruncatedNotice`.
3. **A bare `.limit(N)` rendered as everything** — forbidden. This is the shape
   that lets a seller decide against a list they cannot tell is incomplete.

A single server-side page with `count: "exact"` (as `grid.tsx` does) is a
legitimate variant of shape 2: the count tells the seller what they are not
seeing. The FlipDesk listings table is the fullest worked example (US-2168): it
asks `flipdesk_listing_page` for one page and gets `total` back alongside the
rows, so the pager is honest without the client ever holding the set.

### The fourth shape: don't read the rows at all

The three shapes above are about **client reads that must render rows**. When
the rows are only being read in order to be *counted, summed, averaged or
bucketed*, none of the three is the right answer — the right answer is to not
transfer them.

- `count: "exact", head: true` for anything count-shaped. The server answers it
  and returns **zero rows**, so a row ceiling cannot apply.
- A SQL aggregate (an RPC) for anything needing values: a mean, a sum, a set of
  time buckets, a funnel, a cohort table.

This matters most where the reader is an **operator, not a seller**, because the
tell is weaker. A seller eventually notices an item missing from their kanban.
Nobody can look at "average grade 7.8" and see that it was measured on a slice —
US-2390 found the admin dashboard deriving every headline KPI, plus a
signup→submit→pay funnel and a cohort-retention table, from three unbounded
reads that PostgREST was free to clip.

**Capping such a read is the wrong fix and it is worth being explicit about
why.** A bound does not make an all-time aggregate fail; it makes it *plausible*.
The number still renders, still looks ordinary, and is now wrong with our name on
it rather than the server's. Prefer, in order: aggregate it away → count it
exactly → page until empty → cap and label loudly. Reach for a cap only when the
number is a sample by nature (a tuning signal, a recent-activity feed), and then
the response must carry a `truncated` flag the UI actually shows —
`/admin-dashboard/enrichment-log` is the worked example.

### Why "stop on empty" and not "stop on short"

This is the part that has already been got wrong twice in this codebase, in
`use-items-full.ts` and `bulk-pricing.tsx`. Both loops advanced by their page
size and broke on a short page. That is correct **only while the ceiling is at
least the page size** — and since the ceiling is unknown, it is an assumption
the loop cannot check. Below it, every response comes back capped-short, the
loop stops on its first request, and the paging written to prevent silent
truncation performs it instead.

Advancing by `batch.length` removes the assumption rather than documenting it.
The cost is one confirming empty request per read, always. That round trip is
the entire price of never truncating silently, and it is worth paying.

### Why this is a contract and not advice

The failure has no symptom below the cap. It cannot be caught by a test against
a small fixture, it cannot be seen in review, and by the time a seller notices,
the wrong decision is already made. `src/test/row-cap-contract.test.ts` scans
for both broken shapes so the rule fails a build rather than relying on memory.

## Related

- [[blocked-work-gates]] — why the local verify stack is not prod.
- [[dns-and-routing]] — Kong on `api.*` vs the edge service on `functions.*`.
