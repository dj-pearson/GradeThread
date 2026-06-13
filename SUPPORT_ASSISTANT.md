# AI Support Assistant

The in-app AI support assistant ("ask GradeThread") answers product, account, and
FlipDesk questions for paying customers, reads (never writes) their own data to
give grounded answers, and hands off to a human when it can't help. This document
is the launch + operations reference: architecture, the read-only tool allowlist,
the thresholds, the escalation flow, the abuse/lockout policy, and the phased
rollout.

> **Status: built, OFF by default.** The `support_assistant` feature flag ships
> seeded `enabled=false` (migration `00189`). The assistant is invisible and
> non-functional until an operator flips it on. See **Rollout** below.

---

## Architecture

```
SPA widget                         Edge (Deno/Hono)                       Data
──────────                         ────────────────                       ────
support-chat-widget.tsx            routes/support-assistant.ts            Supabase
  └ useSupportAssistant-             ├ GET  /eligibility  ◄── widget       (service-role,
    Eligibility() ──────────────────┤ POST /message       (SSE stream)     RLS bypassed,
  └ streamSupportMessage() ─────────┤ GET  /conversations                  tenant-scoped
                                     └ GET  /conversations/:id              in code)
                                          │
                                          ├ lib/support-assistant-config.ts  ← launch + tier policy
                                          ├ lib/support-assistant-engine.ts  ← gate, tool registry, loop
                                          ├ lib/support-tools.ts             ← read-only tool impls
                                          ├ lib/support-abuse.ts             ← rate/flood/jailbreak thresholds
                                          ├ lib/support-escalation.ts        ← handoff decision + paths
                                          └ lib/support-analytics.ts         ← per-turn events / cost
```

- **Model:** the bounded tool-use loop runs on the lightweight model from
  `ai-config.ts` (Haiku tier). The abuse classifier is a separate best-effort
  Haiku call.
- **Streaming:** `POST /message` streams the reply over SSE; the route meters
  tokens *after* the stream (streaming bypasses the limiter's `create()` path).
- **Tenancy:** the edge uses the service-role client (RLS bypassed). Every tool
  read is explicitly scoped to the caller's workspace owner (`ctx.ownerId`); see
  the security invariants in `support-assistant-engine.ts` and the
  tenant-isolation tests.
- **Grounding:** product answers come **only** from the published knowledge base
  (`support_kb_articles`). An empty KB hit is the signal to offer a human, not to
  invent an answer.

## The single launch + eligibility config

`services/edge-functions/src/lib/support-assistant-config.ts` is the one place
that decides *is the assistant available, and may this caller use it*. Both the
**engine** (`loadGateAndDecide` in `routes/support-assistant.ts`) and the
**widget** (via `GET /api/support/assistant/eligibility`, since the SPA can't read
`feature_flags` directly) consume it. There are two dials:

1. **Launch kill-switch** — the `support_assistant` feature flag
   (`feature_flags` table). `isSupportAssistantLaunched()` reads it **fail-closed**
   (missing row or DB error ⇒ OFF), the deliberate opposite of the generic
   fail-open `isFeatureEnabled()`. Flipping `enabled=false` **fully disables** the
   assistant fleet-wide within the cache TTL (~30s), no redeploy: the engine
   returns `403 not_available` and the widget renders nothing.

2. **Tier-eligibility / rollout phase** — `SUPPORT_ASSISTANT_PHASE` narrows
   *which plans* see the assistant once the kill-switch is on:

   | Phase | Eligible |
   |---|---|
   | `off` | platform admins only |
   | `internal` | platform admins only (staff dogfooding) |
   | `business` | Business tier (+ admins) |
   | `paid` | Starter, Pro, Business (+ admins) |

   **Free is never eligible.** Platform admins (`users.role` in
   `admin`/`super_admin`) are eligible in every phase so staff can test it.

### Tool allowlist (read-only)

The model can call **only** this fixed registry (`ASSISTANT_TOOLS` /
`ASSISTANT_TOOL_NAMES` in `support-assistant-engine.ts`). There is **no**
write/update/delete/publish tool reachable — `executeAssistantTool()` rejects any
name not in the set, so a prompt injection can never reach a mutating capability.

| Tool | Returns (tenant-scoped to the caller) |
|---|---|
| `get_inventory_status` | inventory counts by pipeline status |
| `get_listings` | the caller's marketplace listings (status filter, ≤20) |
| `get_sales_summary` | sales **aggregates only** (count, gross, fees, net) by period |
| `get_grade_report` | one of the caller's own items' grade report |
| `get_open_submissions` | in-progress grading submissions |
| `get_plan_and_limits` | plan, caps, and usage against caps |
| `search_knowledge_base` | published KB snippets (never whole articles) |
| `escalate_to_human` | records intent to hand off (no durable write itself) |

## Thresholds

### Gate (per turn, before any token is spent)
- **Launch flag** off ⇒ `not_available`.
- **Subscription** must be `active` or `trialing` (owner's billing) ⇒ else
  `not_subscribed`.
- **Plan** must be eligible at the current phase ⇒ else `not_subscribed` (upsell).
- **Lockout** (`users.support_assistant_locked_until` in the future) ⇒ `locked`.

### Abuse / rate caps — `SUPPORT_ABUSE_THRESHOLDS` (`support-abuse.ts`)
Per-tier (free / starter / pro / business):

| Cap | free | starter | pro | business |
|---|---|---|---|---|
| messages / minute | 6 | 10 | 15 | 20 |
| messages / day | 30 | 100 | 200 | 400 |
| tokens / day | 60k | 200k | 500k | 1M |

- **Flood:** a burst at ≥ cap×2 is a HIGH-severity event.
- **Abuse window:** 1 hour rolling.
- **Lock trigger:** 3 HIGH-severity events in the window.
- **Cooldown ladder** (graduated by prior lockout count):
  15m → 1h → 6h → 24h.

### Confidence (grading, related)
Grades under **0.75** confidence route to human review before publishing.

## Escalation flow

`support-escalation.ts` decides handoff. Three paths, all scoped to the caller's
own conversation:

1. **Model** (`trigger='model'`) — the model calls `escalate_to_human` (e.g. the
   user explicitly asks for a person).
2. **Auto** (`trigger='auto'`) — `unresolved_turns` reaches
   `AUTO_ESCALATION_THRESHOLD = 3` (tool loop hit its cap, or the output guard
   replaced the answer).
3. **User** (`trigger='user'`) — reserved for the human-side action.

On escalation the conversation flips to `escalated`, an `escalation_summary` is
synthesized (auto path), and the platform admins + workspace owner are notified
in-app and by email (best-effort; an alert failure never changes enforcement).
Escalated/`awaiting_user` threads are **human-handled** — the bot stays out of the
way until resolved.

## Abuse / lockout policy

- Jailbreak / prompt-injection / flood / scope-probe attempts are classified by a
  heuristic **and** a lightweight model classifier; verdicts are combined into a
  severity. Events are appended to `support_abuse_events` (never client-readable).
- Accumulated HIGH-severity events trigger an atomic lockout via
  `apply_support_assistant_lockout()` (sets `support_assistant_locked_until` +
  bumps the durable `support_assistant_lockout_count` that drives the cooldown
  ladder).
- A locked-out caller is rejected at the gate (`locked`) **before** any token is
  spent. They remain "eligible" for widget purposes (the launcher still shows);
  they just see the pause message inline when they send.
- Platform admins are alerted on every auto-lock (in-app + the abuse-alert inbox).
- Manual unlock and abuse monitoring live in the admin dashboard (US-841).

## Rollout

Phased, conservative ramp. **The kill-switch stays off until you're ready.**

1. **Internal** — set `SUPPORT_ASSISTANT_PHASE = "internal"`, flip
   `support_assistant` → `enabled=true`. Only platform admins see it; staff
   dogfood end-to-end (gate, tools, KB grounding, escalation, abuse caps).
2. **Business** — set `SUPPORT_ASSISTANT_PHASE = "business"`. Only Business-tier
   customers (the priority tier) get it; watch analytics (US-842) and the abuse
   dashboard (US-841).
3. **All paid** — set `SUPPORT_ASSISTANT_PHASE = "paid"` (the shipped default).
   Starter, Pro, and Business all get it. Free never does.

To **disable** at any point: set the `support_assistant` flag `enabled=false`.
That fully removes the assistant (engine `403 not_available`, widget renders
nothing) within the cache TTL — no redeploy.

## Key files

| Concern | File |
|---|---|
| Launch + tier config | `services/edge-functions/src/lib/support-assistant-config.ts` |
| Feature flag reader | `services/edge-functions/src/lib/feature-flags.ts` |
| Engine: gate, registry, loop | `services/edge-functions/src/lib/support-assistant-engine.ts` |
| HTTP/SSE routes + eligibility | `services/edge-functions/src/routes/support-assistant.ts` |
| Read-only tool impls | `services/edge-functions/src/lib/support-tools.ts` |
| Abuse thresholds | `services/edge-functions/src/lib/support-abuse.ts` |
| Escalation | `services/edge-functions/src/lib/support-escalation.ts` |
| KB schema | `supabase/migrations/00183_support_kb.sql` |
| Flag + KB seed | `supabase/migrations/00189_support_assistant_launch.sql` |
| Widget | `src/components/support/support-chat-widget.tsx` |
| Widget client | `src/hooks/use-support-assistant.ts` |
| Admin inbox / monitoring | `src/pages/admin/support.tsx`, US-841 dashboard |
