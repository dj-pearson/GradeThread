---
title: PostgREST row cap (db-max-rows)
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/paged-read.ts
  - src/test/row-cap-contract.test.ts
  - src/hooks/use-items-full.ts
reviewed: 2026-08-01
tags: [postgrest, supabase, perf, correctness, flipdesk]
summary: Every client read must page until empty or declare its cap out loud, because PostgREST truncates silently and supabase-js does not surface it.
---

# PostgREST row cap (db-max-rows)

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

**Not established.** Nothing in this repo sets it: it is not in
`supabase/config.toml` (which configures only the throwaway local verify stack,
see [[blocked-work-gates]]) and not in `docker-compose.coolify.yml` (which is
the edge service, not Kong or PostgREST — see [[dns-and-routing]] for why those
are different hosts).

The code assumes **1000**, which is Supabase's default "Max rows" API setting,
self-hosted included. That assumption is named once, as
`ASSUMED_DB_MAX_ROWS` in `src/lib/paged-read.ts`, and asserted by
`src/test/row-cap-contract.test.ts` — not repeated in prose here.

**The open operator step** (US-2169 AC1) is to read the real value off the
self-hosted stack and record it here. Until then, treat 1000 as a guess that the
code is deliberately built not to depend on.

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
seeing.

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
