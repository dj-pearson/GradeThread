# GradeThread Agentic OS — the A→Z Map

> The operating layer that lets GradeThread run itself: a governed fleet of AI agents
> that watch, triage, propose, and (once trusted) act across every subsystem —
> grading, marketplace ops, finance, support, trust & safety, marketing, growth,
> infrastructure — with the operator supervising from one console instead of
> babysitting 54 crons and 60 admin pages.
>
> Backlog: stories **US-1583 → US-1613** in `prd.json` (notes tagged `[AGENTIC-OS]`).
> This document is the source-of-truth design; stories cite sections here.

---

## 1. What already exists (do not rebuild)

GradeThread is already unusually automated. The Agentic OS **federates** this
machinery — it does not replace it:

| Existing rail | Where | The OS uses it for |
|---|---|---|
| 54 scheduled jobs (`/api/jobs/*`, `X-Internal-Job-Secret`) | `lib/cron-runs.ts` CRON_REGISTRY, COOLIFY.md | Agent ticks run as ordinary registered crons |
| Cron ledger + job locks | `cron_runs` table, `lib/job-lock.ts` | Agent run dedup + last-run health |
| Ops events / activity stream | `lib/ops-events.ts`, `/admin/ops-activity` | Every agent action emits an event |
| Dead-letter console, system health, runbooks | `lib/ops-dead-letters.ts`, `lib/ops-health.ts`, `/admin/ops-runbooks` | Sentinel agent's primary inputs |
| AI budget guardrails (alert/throttle/kill) | `lib/ai-budget.ts`, `ai-budget-gate.ts`, `jobs-ai-budget.ts` | Per-agent spend caps |
| Model routing + cascade + allowlist | `lib/model-routing.ts`, `ai-action-cascade.ts`, `ai-config.ts` | Agent model selection |
| Admin console patterns (RBAC, AAL2, audit) | `routes/admin-*.ts`, `lib/rbac-scopes.ts`, `lib/audit-log.ts` | Mission Control UI + approval endpoints |
| Admin tasks / notifications | `admin_tasks`, `lib/admin-notifications.ts` | Escalation targets |
| Feature flags + system settings + maintenance | `lib/feature-flags.ts`, `system-settings.ts` | Kill switches |
| Autonomous domain engines | content-scheduler, newsletter self-tuning, drip optimizer, AutoLister, repricing, grading self-improvement, support assistant | Domain agents **supervise** these engines rather than reimplementing them |
| Ralph (autonomous dev loop) | `scripts/ralph/` | Module Z governs its backlog hygiene |

**Design rule #1:** an agent is a *supervisor with judgment* sitting on top of an
existing deterministic engine — never a replacement for one. Deterministic work
stays in crons; agents handle triage, synthesis, anomaly judgment, and decisions
that today require the operator's eyes.

## 2. Architecture

```
                    ┌──────────────────────────────────────────────┐
                    │  C · Mission Control  (/admin/agents)        │
                    │  registry · runs · proposals · budgets ·     │
                    │  kill switches · operator brief              │
                    └──────────────▲───────────────────────────────┘
                                   │
     Coolify cron ──► /api/jobs/agent-tick ──► A · Agent Kernel
                                   │             run loop (Claude tool-use)
        ┌──────────────────────────┼─────────────────────────────┐
        │ D · Policy engine        │ B · Budget governor          │
        │ (autonomy L0–L3,         │ (ai-budget rails, per-agent  │
        │  action classes,         │  caps, alert/throttle/kill)  │
        │  kill switches)          │                              │
        └──────────────────────────┼─────────────────────────────┘
                                   │
                   Tool Registry (typed, allowlisted, audited)
                    read tools ────┼──── write tools (proposal-gated)
                                   │
   ┌───────────┬───────────┬───────┴────┬───────────┬────────────┐
   │ H Sentinel│ G Grading │ S Support  │ F Finance │ T Safety   │  … domain
   │ L Mktplace│ M Marketing│ U Lifecycle│ P Pricing │ R Growth  │  agents
   └───────────┴───────────┴────────────┴───────────┴────────────┘
                                   │
        E · Escalation & approvals (proposals → operator → execute)
        O · Observability (transcripts, ops_events, metrics)
        K · Memory   V · Evals   W · Playbooks   X · Experiments
```

### The autonomy ladder (Module D — the spine of the whole OS)

| Level | Name | May do | Requirement to reach it |
|---|---|---|---|
| **L0** | Observe | Read tools only; emit reports, memos, ops_events, admin_tasks | Default for every new agent |
| **L1** | Propose | Everything L0 + create **proposals** (structured write-actions awaiting approval); approved proposals are executed by the kernel, not the agent | Operator flips it in Mission Control |
| **L2** | Act + notify | Execute **allowlisted, reversible** action classes autonomously; every action notifies + is undoable/compensatable | ≥ 20 approved proposals, ≥ 90% approval rate, eval suite passing (Module V) |
| **L3** | Act silent | As L2 without per-action notification (still fully audited) | Sustained L2 track record; per-action-class, never per-agent-blanket |

Promotion/demotion is **per (agent, action-class)**, not per agent. A single
rejected-then-executed action or a budget breach auto-demotes a level and emits
a warning event. A global `agents.pause` kill switch (system settings) halts
every agent instantly; each agent also has its own switch.

### Non-negotiable guardrails (every story inherits these)

1. **No raw writes.** Agents mutate the world only through registered write
   tools, and write tools only execute at the agent's authorized autonomy level
   (else they auto-downgrade to proposals). Tools are ordinary typed functions
   wrapping existing libs — the prompt never contains SQL or fetch calls.
2. **Tenant isolation (US-268).** Agent tables are operator tables → register in
   rls-guard. Any tool touching multi-tenant data uses the existing owner-scoped
   query patterns. Every new agent route gets a `tenant-isolation_test.ts` case.
3. **Budgeted.** Every run passes the ai-budget gate; per-agent daily caps;
   breach = halt + demote + alert. Spend rolls into `/admin/ai-spend`.
4. **Audited.** Every tool invocation → `audit_log` + `ops_events`; every run
   keeps a full transcript (prompt, tool calls, results, output) for replay.
5. **Idempotent + locked.** Agent ticks take `job_locks`; actions carry
   idempotency keys; a re-run after a crash never double-executes.
6. **Bounded.** Per-run hard caps: max steps, max tokens, max wall-clock; the
   kernel kills and records a `run.timeout` outcome rather than hanging.

---

## 3. The modules, A → Z

Each module: **Purpose · Exists today · Build · Stories.**

### A — Agent Kernel *(foundation)*
- **Purpose:** the runtime. Agent definitions, the tick → gather-context →
  Claude tool-use loop → record steps → emit outputs (report / proposals /
  actions) lifecycle.
- **Exists:** ai-config, model-routing, ai-limiter/metering, job-lock, cron-runs.
- **Build:** `agents`, `agent_runs`, `agent_run_steps`, `agent_proposals`,
  `agent_memory` tables; `lib/agent-kernel.ts` run loop; per-run caps.
- **Stories:** US-1583 (schema), US-1584 (runtime).

### B — Budget Governor
- **Purpose:** per-agent spend caps on the existing ai-budget rails; the OS can
  never outspend its leash.
- **Exists:** `ai-budget.ts`, `ai-budget-gate.ts`, `jobs-ai-budget.ts`, `/admin/ai-spend`.
- **Build:** agent-scoped budget keys, breach → halt+demote, spend rollups per agent.
- **Stories:** US-1591.

### C — Command Center (Mission Control)
- **Purpose:** one admin surface: agent registry cards (level, last run, spend,
  health), run transcripts, proposals inbox, kill switches.
- **Exists:** the whole `/admin` design system, RBAC, ops pages to link out to.
- **Build:** `/admin/agents` (+ run detail, proposals inbox), `routes/admin-agents.ts`.
- **Stories:** US-1590.

### D — Decision Policies & Autonomy Ladder
- **Purpose:** the L0–L3 machinery: action classes, per-(agent, class) levels,
  kill switches, auto-demotion rules.
- **Exists:** feature-flags, system-settings registry, canary-rollout patterns.
- **Build:** `lib/agent-policy.ts`; `agents.pause` global switch; policy checks in kernel.
- **Stories:** US-1586; promotion automation in US-1608.

### E — Escalation & Approvals (human-in-the-loop)
- **Purpose:** proposals with typed payloads, TTLs, approve/reject/annotate;
  approved actions executed by the kernel with the proposal as authorization.
- **Exists:** admin_tasks, admin-notifications, step-up auth for sensitive ops.
- **Build:** proposal lifecycle + admin endpoints + notification wiring.
- **Stories:** US-1587; agent→agent handoffs US-1613.

### F — Finance Agent
- **Purpose:** daily read of billing-reconciliation deltas, revenue-window
  anomalies, credit-ledger drift, payout sanity (affiliate/consignor), AI spend
  vs revenue; files discrepancies with evidence; proposes remediations.
- **Exists:** billing-reconciliation cron, revenue dashboards, credit ledger, payout jobs.
- **Stories:** US-1596.

### G — Grading Quality Agent
- **Purpose:** the grading moat's supervisor: weekly synthesis of
  accuracy-tracking / shadow results / calibration drift; review-queue routing
  by information value (active learning, AGENT_LEVELUP_ROADMAP §6.3); proposes
  prompt-version promotions and threshold changes (executed via existing
  eval-gated lifecycle — never bypassing it).
- **Exists:** grading-monitor, confidence-calibration, exemplar-assembly,
  review-info-value, shadow A/B, golden set.
- **Stories:** US-1594.

### H — Health & Incident Agent (“Sentinel”)
- **Purpose:** the SRE on duty. Triages failed cron runs, dead letters, health
  regressions, audit anomalies; correlates (one root cause, not ten alerts);
  files admin_tasks citing the matching runbook; proposes safe remediations
  (retry job, requeue dead letter); drafts incident timelines.
- **Exists:** cron_runs, ops_events, dead-letter console, system_health,
  integrity-scan, audit-anomaly, uptime workflow, runbooks page.
- **Stories:** US-1593; playbook execution US-1605.

### I — Integrations Watchdog
- **Purpose:** vendor-facing health: Stripe/eBay/SES/Google/Apple API error
  rates and circuit-breaker trips, OAuth token fleet health, key/secret
  rotation calendar (vault/10-ops/key-rotation.md as data), quota tracking.
- **Exists:** circuit-breaker, marketplace-health, ebay token refresh cron,
  email warmup/suppression machinery.
- **Stories:** US-1604.

### J — Jobs Orchestrator
- **Purpose:** governance of the 54-cron fleet itself: runtime dependency/
  overlap analysis, backpressure detection (job runtimes trending up, queues
  growing), schedule-drift alarms, missed-tick detection.
- **Exists:** CRON_REGISTRY + drift-guard test (build-time only), cron_runs data.
- **Stories:** US-1588 (agent scheduling itself), US-1611 (fleet governance).

### K — Knowledge & Memory
- **Purpose:** what an agent learned persists: per-agent durable memory
  (curated learnings, decision log, entity notes) assembled into context each
  run; pruning/curation so memory stays small and sharp (the Ralph
  LEARNINGS.md pattern, upgraded to DB).
- **Stories:** US-1606.

### L — Listings & Marketplace Ops Agent
- **Purpose:** FlipDesk operational health across tenants (operator view):
  stuck publish batches, orphan listings, compliance-health failures, webhook
  backlog, sync-conflict pileups; proposes reconciliation nudges and drafts
  the marketplace-ops morning summary.
- **Exists:** marketplace-ops/pipeline admin, reclaim crons, reconciliation
  sweep, listing-compliance-health, sync-conflicts.
- **Stories:** US-1598.

### M — Marketing & Content Agent
- **Purpose:** supervises the three autonomous engines (content scheduler,
  newsletter self-tuning, drip optimizer) as one portfolio: weekly performance
  review, cross-channel frequency sanity, next-week content plan proposals,
  flags cannibalization/fatigue that per-engine tuning can't see.
- **Exists:** all three engines + marketing-coordinator + performance-signals.
- **Stories:** US-1599.

### N — Notifications & Operator Brief
- **Purpose:** one daily brief instead of N alert streams: overnight agent
  outcomes, pending proposals (with one-click links), anomalies, spend, and
  "nothing needs you" when true. Email + `/admin` page.
- **Exists:** admin-notifications, north-star digest (weekly), SES transport.
- **Stories:** US-1592.

### O — Observability for Agents
- **Purpose:** agent runs are as debuggable as HTTP requests: full transcripts,
  step timings, token/cost per run, outcome taxonomy, `agent.*` ops_events,
  Sentry on run crashes.
- **Exists:** observability.ts, ops-events, cron_runs ledger.
- **Stories:** US-1589.

### P — Pricing Agent
- **Purpose:** operator-side oversight of the repricing/automation engines:
  outcome review (did drops sell?), margin-guard breaches, price-guide and
  condition-curve staleness, anomalous rule behavior across tenants.
- **Exists:** repricing crons, price-guide, condition curves, automation rules.
- **Stories:** US-1601.

### Q — Quality & Release Agent
- **Purpose:** post-deploy verification: run smoke scripts, watch error rates
  and canary rollouts in the hour after deploy, compare to baseline, file or
  escalate regressions with the offending commit range.
- **Exists:** smoke-functions/staging scripts, canary-rollout.ts, Sentry ingest.
- **Stories:** US-1610.

### R — Revenue & Growth Agent
- **Purpose:** funnel/retention anomaly narration (not just dashboards),
  referral/affiliate program health, growth-dispatch oversight, weekly
  experiment ideas ranked by expected impact.
- **Exists:** admin-analytics funnels, growth suite, referral/affiliate modules.
- **Stories:** US-1602.

### S — Support Agent
- **Purpose:** upgrades the existing user-facing assistant with an
  operator-side triage layer: classify/prioritize the ticket queue, draft
  replies as proposals, detect emerging issue clusters ("5 tickets about
  checkout in 2h" → page Sentinel), auto-resolve known-answer tickets at L2+.
- **Exists:** support-assistant engine + tools + escalation + KB.
- **Stories:** US-1595.

### T — Trust & Safety Agent
- **Purpose:** triage moderation/fraud/abuse/passport-integrity queues by
  severity and pattern; summarize rings (same device/IP across accounts);
  propose actions (suspend, require step-up, claim denial) — always L1 for
  account-level actions.
- **Exists:** abuse-signals, moderation queue, fraud/safety admin, forensics,
  passport-integrity scans.
- **Stories:** US-1597.

### U — User Lifecycle Agent
- **Purpose:** per-cohort judgment on top of drip/journeys: churn-risk scoring
  narratives, winback slate proposals, activation stall diagnosis ("signed up,
  never submitted — why?"), trial-expiry saves.
- **Exists:** drip engine + journeys + user_events + trial-expiry cron.
- **Stories:** US-1600.

### V — Verification & Evals (for the agents themselves)
- **Purpose:** the grading-engine discipline applied to agents: golden
  scenario suites per agent (frozen inputs → expected judgments), run on every
  prompt change and weekly; eval pass required for L2 promotion.
- **Exists:** the pattern (`grading-eval.ts`, `listing-eval.ts`) to copy.
- **Stories:** US-1607; promotion gate US-1608.

### W — Workflow / Playbook Engine
- **Purpose:** declarative multi-step remediations (JSON: steps = registered
  tool calls + conditions) that agents can propose and, once approved, the
  kernel executes step-by-step with per-step audit. Codifies `/admin/ops-runbooks`
  into executable form.
- **Stories:** US-1605.

### X — eXperiments Governor
- **Purpose:** one registry over every live A/B (newsletter, drip, listing
  prompts, staged grading rollouts): interference detection (two experiments
  on one audience), sample-size honesty, result adjudication memos, auto-stop
  proposals for clear losers.
- **Exists:** per-engine A/B machinery (newsletter-ab, drip-optimizer,
  listing-prompt-promote, staged prompt rollout).
- **Stories:** US-1609.

### Y — Yield Analytics ("CEO Brief")
- **Purpose:** the weekly north-star digest grows into a narrated brief: what
  moved, why (agent-attributed causes), what the fleet did about it, the one
  decision the operator should make this week.
- **Exists:** jobs-north-star + gamification schema, revenue/analytics data.
- **Stories:** US-1603.

### Z — Zero-touch Dev Loop (Ralph Governor)
- **Purpose:** the OS maintains its own maker: prd.json hygiene (dependsOn
  cycle lint, stale in-flight stories, passes:true accumulation → re-archive
  reminder with the stop-the-loop procedure), progress digest, LEARNINGS.md
  size guard.
- **Exists:** Ralph loop, archive convention, AGENT_LEVELUP_ROADMAP §2.6 (prd-ralph skill).
- **Stories:** US-1612.

---

## 4. Rollout phases

**Phase 0 — Kernel (US-1583 → US-1592, priorities 2360→2351).**
Schema → runtime → tools → policy → approvals → scheduling → observability →
Mission Control → budgets → operator brief. After Phase 0 the OS exists but
manages nothing yet.

**Phase 1 — Domain agents at L0/L1 (US-1593 → US-1604, priorities 2340→2329).**
Sentinel first (it watches everything else), then Grading, Support, Finance,
Safety, Marketplace, Marketing, Lifecycle, Pricing, Growth, Analyst, Watchdog.
Every agent ships at L0; the operator promotes to L1 per action class from
Mission Control after reviewing its first reports.

**Phase 2 — OS maturity (US-1605 → US-1613, priorities 2320→2312).**
Playbooks, memory, evals, autonomy promotion, experiments governance, release
agent, cron-fleet governance, Ralph governor, agent-to-agent handoffs. L2 is
unlocked only here (US-1607/US-1608 gate it).

**Sequencing note:** `dependsOn` in the stories enforces the true order; the
priority band just slots the whole program after the current in-flight stories
(p2368–2378) and far ahead of the parked Android backlog.

## 5. What the OS explicitly does NOT do

- **No tenant-facing autonomy changes.** Users' own automations (FlipDesk rules,
  AutoLister, US-1362) stay user-configured; the OS supervises the *platform*,
  not users' businesses.
- **No bypassing existing safety lifecycles.** Grading prompt promotion still
  goes shadow → eval gate → canary; the agent proposes, the lifecycle disposes.
- **No new AI providers or infra.** Same Claude API, same edge service, same
  Coolify cron pattern, same admin console.
- **No un-audited action, ever.** If a path exists where an agent could mutate
  state without an audit row, that's a bug with the severity of an RLS hole.
