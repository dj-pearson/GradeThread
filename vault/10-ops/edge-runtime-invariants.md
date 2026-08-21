---
title: Edge runtime invariants — replicas and deploy ordering
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/coherent-cache.ts
  - services/edge-functions/src/lib/schema-version.ts
  - services/edge-functions/src/lib/circuit-breaker.ts
reviewed: 2026-08-21
tags: [edge, caching, deploy, contract]
summary: The edge runs N replicas, migrations apply separately from the code roll, and a deadline must cover the response body — three facts that constrain what any edge module may assume.
---

# Edge runtime invariants

> **Re-reviewed 2026-08-21.** Drift flagged `schema-version.ts` again, and for
> the same reason: `EXPECTED_SCHEMA_VERSION` moved 00640 -> 00642 across two
> migrations (00641 and 00642), each with its bump in its own commit. That is
> the US-1108 triple working exactly as this note describes. The note names the
> RULE and not a version, so nothing in it moved — which is now true of two
> consecutive drift flags, and is worth saying rather than re-deriving next time.
>
> Previously re-reviewed 2026-08-20 for 00629 -> 00630.

Two facts about how the edge service runs. Neither is visible from inside a
single module, and both change what that module is allowed to do.

## 1. The edge runs multiple replicas

Since US-501 the edge service runs as **N replicas**. Therefore:

> **A module-level cache is a correctness bug, not an optimisation.**

Several caches were per-process and broke when the service scaled out — replica
A serving a value replica B had already invalidated. Shared state now goes
through `edge_shared_cache`, one Postgres table (migration `00162`), with
deliberately **no Redis dependency**, to match the rest of the stack (Postgres +
Supavisor, US-570).

Before adding any cache to an edge module, ask whether two replicas disagreeing
about it would be a bug. If yes, it belongs in the shared store.

### The one legitimate exception, and why it is not a precedent

The AES-key cache in `crypto-aes.ts` is intentionally **not** migrated to the
shared store:

> "its inputs are environment variables — identical on every replica and changed
> only by a redeploy, which restarts every process — so it can never go stale or
> diverge between replicas."

That reasoning is the test. A per-process cache is safe only when its inputs
cannot change without restarting the process. Almost nothing else qualifies.

## 2. Migrations apply separately from the code roll

The deploy order is DB → edge → frontend ([[deploy]]), which means there is a
window where new code meets an old schema. `schema-version.ts` asserts the DB
version at boot, with a **grace window** for exactly that race — the edge
container may start moments before the migration step completes.

The rule this creates for authors is already enforced by the `migrations` skill:
bump `EXPECTED_SCHEMA_VERSION` in the **same commit** as the migration. The
grace window tolerates a race of seconds, not a missing bump.

Note the failure mode this guard once had: a pending migration used to 503 the
*whole* edge service, because the boot guard ran before `Deno.serve` and crashed
the process into a restart loop. The grace window (US-778) exists because the
strict version was worse than the problem.

## 3. A timeout that stops at the headers is not a timeout

`fetch()` resolves as soon as the response **headers** arrive. The body is still
streaming. So a deadline released when that promise settles — the natural way to
write it, with `clearTimeout` in a `finally` — bounds the handshake and nothing
else, and every `await res.text()` in the codebase runs unbounded.

The failure that produces is the worst shape available: an upstream that answers
`200 OK` and then stalls the body hangs the caller **forever**, while the
breaker records a success, the retry never fires, and the metrics look healthy.
US-2323 found `fetchWithTimeout` in exactly this state, affecting every caller,
after an audit flagged only the eBay Trading symptom.

`fetchWithTimeout` now keeps the timer armed and returns a Response whose body
is piped through a reader that releases the deadline when the body ENDS —
normally, by error, or by cancellation. A stall trips the same
`AbortController` and surfaces as the same `TimeoutError` the retry and breaker
machinery already understand.

**The general rule for this repo:** a deadline must cover the work the caller
actually waits on, not the first promise that happens to settle. When adding a
timeout to anything streaming, ask what the caller awaits AFTER the function
returns.

Pinned by `circuit-breaker_test.ts`, which serves a real stalled body over
loopback rather than stubbing `fetch` — the bug lives in the seam between the
headers promise and the body stream, and a stub has no such seam. The test was
confirmed non-vacuous by restoring the old behaviour and watching it hang.

## Related

- [[deploy]] — the DB → edge → frontend order these assume
- [[capacity]] — how many replicas, and when to add more
- [[connection-pooling]] — the Supavisor layer the no-Redis decision matches
- [[moc-ops]]
