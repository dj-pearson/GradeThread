# The weighted-overall lockstep

**Moved to `vault/20-domain/weighted-overall-lockstep.md` (US-2063).**

That note is `type: contract` with `code_refs`, so the drift guard flags it when
any implementation changes — which is what this file needed and could not have.

It was materially stale when moved: titled "the three rounding sites", listing
four, while the code had nine touch points and, more importantly, had been
CONSOLIDATED by US-2034 into one client helper (`src/lib/weighted-grade.ts`) and
one edge helper (`human-review.ts`). Anyone following this file would have gone
looking for four copies to keep in sync that no longer exist.
