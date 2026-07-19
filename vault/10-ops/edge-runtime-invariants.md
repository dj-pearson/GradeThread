---
title: Edge runtime invariants — replicas and deploy ordering
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/coherent-cache.ts
  - services/edge-functions/src/lib/schema-version.ts
reviewed: 2026-07-19
tags: [edge, caching, deploy, contract]
summary: The edge runs N replicas and migrations apply separately from the code roll; both facts constrain what any edge module may assume.
---

# Edge runtime invariants

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

## Related

- [[deploy]] — the DB → edge → frontend order these assume
- [[capacity]] — how many replicas, and when to add more
- [[connection-pooling]] — the Supavisor layer the no-Redis decision matches
- [[moc-ops]]
