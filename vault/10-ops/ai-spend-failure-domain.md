---
title: AI spend controls and the shared failure domain
aliases: [AI-SPEND-RESIDUAL, correlated-fail-open]
type: decision
status: current
source_of_truth: vault
code_refs:
  - services/edge-functions/src/middleware/rate-limit.ts
  - services/edge-functions/src/lib/ai-budget-gate.ts
  - services/edge-functions/src/lib/ai-limiter.ts
  - services/edge-functions/src/main.ts
reviewed: 2026-07-19
tags: [ops, cost, reliability, ai]
summary: What still costs money during a Postgres outage, why the correlation is accepted, and the dollar bound.
---
# AI spend controls and the shared failure domain (US-2013)

## The problem this records

Three cost controls guard Claude spend. **Two of them read the same Postgres**,
so a single database degradation used to remove per-user rate limiting AND the
hard USD kill-switch *simultaneously* — while Anthropic stayed up and billable.

The argument was never "fail-open is wrong". Fail-open per control is a
deliberate and defensible choice: a transient blip must not halt the product.
**The correlation is what turned a degradation into an unbounded bill.**

## The three layers, and what survives a Postgres outage

| Layer | Backing store | Survives DB outage? |
|---|---|---|
| Per-user rate limiters (`rate-limit.ts`) | Postgres | Only where `failClosed: true` |
| AI budget kill-switch (`ai-budget-gate.ts`) | Postgres (`ai_budget_status()`) | Partially — retains last known kills |
| Global concurrency + daily ceiling (`ai-limiter.ts`) | Postgres, with in-process fallback | **Yes** — this is the real backstop |

## What was changed

**Every AI-spending surface now fails CLOSED.** During a store outage these
return 429 and the caller retries, instead of fanning out to the vision API:

- `/api/grade/*` — and `/api/grade/snap` transitively, since the group limiter
  also matches it
- `/api/flipdesk/ai/*`
- `/api/flipdesk/scout/*` — highest fan-out per request (grades N candidates)
- `/api/flipdesk/autolister/*` **writes only**
- `/api/support/assistant/*`

**The budget gate retains rather than clears.** On a read error it keeps the
last known kill set instead of caching an empty one. Previously an error
*actively erased* a known breach for the cache TTL, so a feature whose hard USD
ceiling had already been hit resumed spending for 30s per failed read, for as
long as the outage lasted. An error can no longer un-kill anything.

## Deliberate asymmetry: close what spends, not what reads

`/api/flipdesk/autolister/*` GET (the batch-status poll) stays **fail-open**. It
buys no tokens, and 429ing a status poll during a blip would break the queue view
for a batch that is already running and already paid for. Same reasoning for the
non-AI routes (`/product`, `/measure` — CPU-only image work, no model call).

Closing a read path buys no safety and costs availability.

## The residual exposure, in dollars

**The correlation is now broken for request-driven spend, and accepted for the
rest.** What can still spend money during a total Postgres outage:

1. **In-flight work already past the limiter** — bounded by the concurrency
   semaphore, so at most `AI_MAX_CONCURRENCY` calls.
2. **Background crons** that call AI without passing a request limiter. These are
   job-secret authed, not user-triggerable, and fixed-rate.
3. **The degraded global ceiling.** When the shared counter store is unreachable
   `ai-limiter.ts` falls back to an in-process count, so the effective global cap
   becomes `AI_GLOBAL_DAILY_CALL_CEILING × replica count`.

The ceiling is the number that bounds the worst case:

- Default ceiling: **50,000 calls/day** (`AI_GLOBAL_DAILY_CALL_CEILING`)
- Replicas today: **1** (see the single-replica note in `scaling.md` / US-2010)
- Default model `claude-sonnet-5` at **$3/MTok in, $15/MTok out**
- A vision call of ~1.5k input + ~800 output tokens ≈ **$0.017**

> **Worst-case bound: 50,000 × $0.017 ≈ $850 for a full day of total outage,
> at one replica.** Each additional replica adds the same amount, because the
> fallback counter is per-process.

⚠️ **The $0.017 is a per-call ESTIMATE, not a measurement.** It is derived from
list pricing and typical token counts, not from `ai_usage.cost_usd`. To replace
it with a real number:

```sql
select avg(cost_usd), count(*) from ai_usage where created_at > now() - interval '7 days';
```

Do that before quoting this figure anywhere it matters — the bound is only as
good as the per-call cost, and that is the one input here nobody has measured.

## Why the correlation is accepted rather than eliminated

Giving the limiters a separate store (Redis, or process-local) would remove the
shared failure domain outright. That was rejected for now: it adds an
infrastructure dependency and a second consistency problem to solve a bill
already bounded at roughly a day's ceiling. Fail-closed on every spending surface
gets most of the benefit for none of the operational cost.

**Revisit this if** the replica count rises (the bound scales linearly with it),
or if the daily ceiling is raised substantially.

## Related

- [[capacity]] — concurrency and memory limits
- [[scaling]] — replica count, the multiplier on the bound above
- [[incident-response]] — what to do during the outage this note describes
