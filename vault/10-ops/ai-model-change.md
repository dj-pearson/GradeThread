---
title: Changing the AI model, and the eight places a code change does not reach
type: runbook
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/ai-model-registry.ts
  - services/edge-functions/src/lib/ai-config.ts
  - services/edge-functions/src/lib/ai-usage.ts
  - services/edge-functions/src/lib/ai-token-profile.ts
  - services/edge-functions/src/lib/agent-kernel.ts
  - services/edge-functions/src/lib/second-opinion.ts
  - services/edge-functions/src/tests/ai-model-registry_test.ts
reviewed: 2026-09-11
tags: [ops, ai, cost, models]
summary: A model change is one line in ai-model-registry.ts plus one Coolify team variable; it deliberately does not reach the three allowlists, the price table or the five system_settings rows, and this says why and what to do about each.
---

# Changing the AI model (US-3186)

## The short version

There are two edits, and between them they move all live traffic.

1. **The code default.** `CURRENT_MODELS` in
   `services/edge-functions/src/lib/ai-model-registry.ts` holds one id per tier
   (`default`, `lightweight`, `image`). `ai-config.ts` `DEFAULTS` is those three
   values and nothing else, so every tier resolver, the operator drift guard and
   the banner an operator script prints all move with them.
2. **The deployed variable.** `DEFAULT_AI_MODEL` (and `LIGHTWEIGHT_AI_MODEL`) as
   a Coolify **team** variable, referenced by the service as
   `{{team.DEFAULT_AI_MODEL}}`. The variable WINS over the code default at
   runtime, so a build shipped with a new `CURRENT_MODELS` still serves the old
   model until the variable moves. See [[env-reference]] and
   [[edge-container-settings]].

Adding a genuinely new id is one more edit first: put it in `MODEL_IDS` in the
registry. `src/tests/ai-model-registry_test.ts` fails if any derived surface
names an id the registry does not know, and fails if a raw model-id literal
reappears in code in `ai-config.ts`, `ai-usage.ts`, `ai-token-profile.ts` or
`agent-kernel.ts`.

## What the code change does NOT reach

Eight things. Two are code and deliberately independent; six are data.

### Deliberately independent, in code

**The three allowlists.** `GRADING_MODEL_ALLOWLIST` and
`CONTENT_MODEL_ALLOWLIST` (`ai-config.ts`) and `AGENT_MODEL_ALLOWLIST`
(`agent-kernel.ts`) list what an operator MAY route to, which is a different
question from what the build runs. Grading is the clearest case:
`claude-opus-5` is a current id and is NOT on the grading list, because nothing
has put it through the eval gate. A model joins that list by being qualified.

**`MODEL_PRICES`** (`ai-usage.ts`) is a table of history, not of traffic.

Both keep their previous-generation entries on purpose, and both are load-bearing
in a way that fails silently:

- Deleting a price row does not raise anything. `priceFor()` answers 0 for an
  unknown id, so every historical `ai_usage_events` row on that model reprices to
  $0.00 and the bill appears to have fallen. That reads as a cost win and is a
  data loss.
- Deleting a grading allowlist entry means a submission graded on that model can
  no longer be re-graded on it, so a certificate and a regrade stop being
  comparable.

`RETAINED_MODEL_IDS` in the registry names each retained id, the reason, and the
surfaces that must keep it; the test asserts every one of those memberships.
Today the list is one id, `claude-sonnet-4-6`, the default before 2026-07-02.

### Data, so a deploy cannot move them

Five rows in `system_settings` ([[system-settings]]) and the team variable
itself. A code change touches none of them.

| Key | What a wrong id does |
|---|---|
| `grading_second_opinion.model` | ROUTES, once migration 00791 lands (US-3359). Dormant while `enabled:false`, which is how it is seeded. The dangerous direction is a stale id that has drifted onto the PRIMARY model: `resolveSecondOpinionConfig` now refuses that and disables the pass rather than grading twice with one model and reporting agreement, so this one fails loudly. Omit `model` from the row entirely and it falls back to `CURRENT_MODELS.secondOpinion`. |
| `grading_model_cascade.escalationModel` | ROUTES. Dormant while `enabled:false`; flipping it on starts grading escalations on whatever is written here. |
| `ai_action_model_cascade` | ROUTES FlipDesk AI actions. Falls back to the lightweight and default tiers when unset, so leaving it alone is safe. |
| `ai_model_prices` | PRICES. The `ai_profitability` / `ai_budget_status` RPCs re-price the ledger from this copy, not from `MODEL_PRICES`. Same deletion trap. |
| `ai_feature_economics.*.current_model` | DESCRIBES. The AI-profitability dashboard compares margin against this string. On 2026-09-08 five features claimed `claude-sonnet-4-6` while running on Sonnet 5, and one claimed Haiku while running on Sonnet, so the dashboard was crediting a saving nobody was making. |

## Checking `ai_feature_economics` against the ledger

This is the one that goes stale invisibly, because nothing writes it and nothing
reads it back. The ledger already carries the answer: `ai_usage_events.model` is
recorded per call. Run the READ first; it changes nothing.

```sql
with ledger as (
  select feature,
         model,
         count(*) as calls,
         row_number() over (partition by feature order by count(*) desc) as rk
  from public.ai_usage_events
  where created_at >= now() - interval '30 days'
    and feature is not null
  group by feature, model
),
declared as (
  select f.key as feature,
         f.value ->> 'current_model'     as declared_current,
         f.value ->> 'recommended_model' as declared_recommended
  from public.system_settings s,
       lateral jsonb_each(s.value) as f(key, value)
  where s.key = 'ai_feature_economics'
)
select d.feature,
       d.declared_current,
       d.declared_recommended,
       l.model as ledger_dominant_model,
       l.calls
from declared d
left join ledger l on l.feature = d.feature and l.rk = 1
order by d.feature;
```

Read the result this way:

- `ledger_dominant_model` null means no calls in the window. That is not drift;
  check the call site in code before changing anything.
- `declared_recommended` disagreeing with reality matters MORE than
  `declared_current`, because somebody can act on a recommendation. A dashboard
  recommending a retired model is worse than one reporting a stale current.

Then write only the rows that disagree, one feature at a time, so the statement
says out loud which feature it is touching:

```sql
update public.system_settings s
set value = s.value
  || jsonb_build_object(
       'grading',
       (s.value -> 'grading') || jsonb_build_object('current_model', 'claude-sonnet-5')
     )
where s.key = 'ai_feature_economics';
```

Re-run the READ afterwards. The same query is the verification.

## Why this is not automated

Making the dashboard derive `current_model` from the ledger is a change to the
`ai_profitability` RPC (migration 00240) and to
`src/pages/admin/ai-profitability.tsx`, not to the edge service. The pure
arithmetic already exists and is tested: `profileByPhase()` in
`ai-token-profile.ts` returns a `modelMix` per phase, which is the same
"what actually served this" reduction the SQL above does. Wiring it into the
dashboard is open work, not done work.

## Related

- [[system-settings]] for how the registry is read and edited.
- [[env-reference]] for the model variables and which surface each belongs to.
- [[deploy]] for the order a model change ships in: the variable is a service
  restart, the registry is a normal edge deploy.
- [[ai-spend-failure-domain]] for what still costs money when the controls are
  down.
