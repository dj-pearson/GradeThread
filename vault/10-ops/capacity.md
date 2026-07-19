---
title: Capacity and edge memory profile
aliases: [CAPACITY, scale-out]
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [ops, capacity, performance]
summary: Where memory and throughput limits bite, and the scale-out rule.
---
# Edge Capacity, Memory Profile & Scale-out Rule (US-573)

The edge container's dominant memory cost is the grading pipeline's **in-process
base64 image buffering**. This document records the measured/estimated profile,
the right-sized container limits, and the memory/CPU scale-out rule (which ties
to the replica plan in [`vault/10-ops/scaling.md`](vault/10-ops/scaling.md), US-501).

## Where the memory goes

`services/edge-functions/src/lib/grading-pipeline.ts` (step 3) downloads every
submission photo and converts it to a **base64 data URI held resident in
memory** until the per-image vision analysis settles (step 4). Grades are kicked
**fire-and-forget** (`grade.ts → processSubmission().catch`, plus the stuck-grade
reaper and the FlipDesk bridge), so without a bound an unbounded number of
submissions could buffer their images at the same time and OOM the container.

Per-submission worst case:

| Factor | Value |
|---|---|
| Photos per submission | up to ~8 (front, back, label, detail ×2, defect ×3) |
| Per-photo upload cap | 15 MiB (`UPLOAD_MAX_BYTES`, body-limit.ts) |
| base64 inflation | ~1.33× the raw bytes |
| Resident per submission (worst case) | ~8 × 15 MiB × 1.33 ≈ **~160 MiB** |
| Resident per submission (typical: 5 photos × ~3 MiB) | ≈ **~20 MiB** |

The raw `Uint8Array` and its base64 string co-exist briefly during decode, so
the instantaneous spike is a little higher than the resident figure.

## The bound (what prevents OOM)

`services/edge-functions/src/lib/grading-capacity.ts` adds a **process-wide
semaphore** (`withImageBufferSlot`) wrapping the download→base64→analysis block.
`GRADING_MAX_CONCURRENT_PIPELINES` (default **6**) caps how many submissions hold
base64 data resident at once. Excess pipelines park FIFO holding only a closure
(and their grading lease, US-569) — **not** image data — until a slot frees.

This is distinct from the AI concurrency limiter (`ai-limiter.ts`,
`AI_MAX_CONCURRENCY`, default 8), which bounds concurrent Claude **calls** but
does nothing to bound image buffering.

Worst-case resident base64 with the cap: `6 × ~100 MiB ≈ 600 MiB` (using a
mixed ~100 MiB/submission worst case). Plus the Deno runtime baseline
(~80–150 MiB), in-memory caches, and the Anthropic SDK's per-call buffers.

## Right-sized container limits

`docker-compose.coolify.yml` `deploy.resources`:

| | Before | After (US-573) |
|---|---|---|
| CPU limit | 1.5 | 1.5 (base64 encode is CPU-light; unchanged) |
| **Memory limit** | **1G** | **2G** |
| CPU reservation | 0.25 | 0.25 |
| Memory reservation | 256M | 512M |

At 2G, the ~600 MiB worst-case base64 + baseline lands peak RSS well under the
70% scale-out line (≥ 30% headroom). The same number is exported to the app as
`EDGE_MEMORY_LIMIT_MB=2048` so `/health/metrics` can report headroom. **Keep the
env var and the `deploy.resources.limits.memory` value in sync.**

## Measuring the profile

`GET /health/metrics` (dependency-free, unauthenticated, safe to sample at high
frequency) returns a `memory` block from `Deno.memoryUsage()`:

```json
{
  "memory": {
    "rss_mb": 312.4, "heap_used_mb": 110.2, "heap_total_mb": 180.0,
    "external_mb": 95.1, "limit_mb": 2048,
    "rss_pct_of_limit": 15.3, "headroom_pct": 84.7, "pressure": "ok"
  },
  "grading": { "buffer_pipeline_cap": 6 }
}
```

`pressure`: `ok` (< 70%), `elevated` (≥ 70%, the scale-out line), `critical`
(≥ 85%, OOM danger).

## Load test

`scripts/ops/loadtest-grading.mjs` drives the grade/autolister path at a target
concurrency while sampling `/health/metrics`, and **fails if peak RSS ≥ 80% of
the limit** (the OOM safety gate — deliberately above the 70% scale-out line):

```bash
METRICS_URL=https://functions.gradethread.com/health/metrics \
TARGET_URL=https://functions.gradethread.com/api/grade/submit \
TARGET_AUTH="Bearer <token>" \
node scripts/ops/loadtest-grading.mjs \
  --concurrency 20 --duration 120 --method POST --body-file grade-payload.json
```

Sample-only mode (point real/replayed traffic at the host separately and just
watch memory): omit `TARGET_URL`.

> [!todo] **MANUAL (pre-launch gate):** run this against staging at the launch-target
> concurrency for both the grade and autolister paths and record the peak RSS %
> here. The PASS (peak < 80%, no OOM) is the AC-4 sign-off.

## Memory/CPU scale-out rule (ties to US-501)

**Headroom target: ≥ 30%** (peak RSS ≤ 70% of the memory limit, CPU ≤ 70%
sustained).

| Signal (sustained ≥ 5 min) | Action |
|---|---|
| `memory.pressure` = `elevated` (RSS ≥ 70%) **or** CPU ≥ 70% | Add a replica (US-501) — horizontal first; the service is stateless (see SCALING.md). |
| `memory.pressure` = `critical` (RSS ≥ 85%) | Page on-call; lower `GRADING_MAX_CONCURRENT_PIPELINES` (sheds buffering, queues grades) as the immediate lever, then scale. |
| Peak RSS chronically < 40% at target load | Right-size memory back down (cost). |

Horizontal scale-out is the primary lever and is preferred over raising the
single-container limit, because replicas also remove the single point of failure
(US-501). The pooler (US-570) already absorbs the extra Postgres connections
replicas bring. `GRADING_MAX_CONCURRENT_PIPELINES` is the per-replica memory
lever; the replica count is the throughput lever.

## Related

- [[scaling]] — what to turn up when this says you are out of headroom
- [[edge-runtime-invariants]] — why replica count constrains caching
- [[connection-pooling]] — the other resource that runs out first
- [[moc-ops]]
