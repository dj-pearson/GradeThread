---
title: Experimentation — which system owns which decision
type: contract
status: current
source_of_truth: vault
code_refs:
  - src/lib/client-experiments.ts
  - src/hooks/use-feature-flag.ts
  - services/edge-functions/src/lib/feature-flags.ts
  - services/edge-functions/src/lib/experiments-governor.ts
reviewed: 2026-07-19
tags: [growth, experiments, feature-flags, analytics, consent]
summary: Three flag/experiment systems exist for three different jobs; pointing two at the same decision is the failure mode this contract prevents.
---

# Experimentation — which system owns which decision

There are **three** systems here and they are not interchangeable. The rule is
one sentence: **exactly one system owns any given decision.** Everything below
is the reasoning behind that sentence.

## The three systems

| System | Where | Decides | Bucketing |
|---|---|---|---|
| Server feature flags | `services/edge-functions/src/lib/feature-flags.ts` | Whether an expensive or external-dependency flow RUNS at all | Deterministic FNV-1a on key+userId, plus plan targeting, allow/deny, schedule window |
| Client experiments | `src/lib/client-experiments.ts` + `useFeatureFlag` | Which VARIANT of a UI surface a visitor sees | PostHog's own bucketing — this layer does none |
| Experiments Governor | `services/edge-functions/src/lib/experiments-governor.ts` | Nothing at runtime; it AUDITS the portfolio | n/a |

### Server flags are kill-switches, not experiments

They exist so grading, autolister, content AI and repricing can be switched off
during an outage or a cost spike without a redeploy. They **fail open** — a
missing row or a DB error means ENABLED — because a kill-switch should only ever
turn something off when an operator explicitly says so.

That fail-open default is precisely why they must never carry an experiment. An
experiment that silently defaults every visitor into the treatment arm on a
transient DB blip does not produce a weak result; it produces a confident wrong
one.

### Client experiments are UI variants, and they fail to control

The client layer is the mirror image: it **fails to control**. No consent, no
PostHog, no flags delivered, PostHog throwing — every one of those paths returns
`{ variant: "control", ready: false }`. See the header of
`src/lib/client-experiments.ts` for the three integrity properties (consent gate,
no mid-session flips, exposure-not-evaluation) and why each one exists.

The consent gate is **structural rather than checked**: flags are read off
`window.posthog`, which `analytics.ts` only creates after the visitor opts into
the analytics category. There is no code path that can bucket someone earlier,
because there is nothing to ask. Do not add one — in particular, do not "pre-warm"
flags before consent to avoid the load flicker. The category model itself lives
in the header of `src/lib/analytics.ts` (necessary / analytics / marketing) — it
has no vault note of its own, which is a gap worth closing the next time
consent work comes up.

### The Governor audits, it does not decide

It is a registry over every live A/B, detecting interference (two experiments on
the same audience and the same metric window), underpowered reads presented as
wins, and experiments past their decision date.

> [!warning] Known gap as of 2026-07-19
> The Governor has adapters for the four server-side engines
> (`newsletter-ab`, `drip-optimizer`, `prompt-rollout`, `listing-prompt`). It has
> **no adapter for client-side experiments.** A paywall or pricing test is
> therefore invisible to interference detection — so a copy test running against
> the same conversion metric as a drip test will not be flagged, and both reads
> will look clean. Registering client experiments is the next piece of work;
> until it exists, check by hand before starting a client test on a conversion
> metric that a server engine is already moving.

## Rules

1. **One owner per decision.** If the server already gates a capability, do not
   also A/B its UI affordance — you cannot attribute the outcome.
2. **Never express an experiment as a server flag.** Fail-open makes the control
   arm leak into treatment. Kill-switches only.
3. **Never express a kill-switch as a client experiment.** It fails to control,
   which is the wrong direction for turning something OFF, and it does nothing
   for visitors who declined analytics.
4. **Analyse on `experiment_exposed`, not on `$feature_flag_called`.** The latter
   fires when code ASKS — on mount, in effects, on surfaces never scrolled to.
   Diluting a real effect across people who never saw the variant is the most
   common way an experiment reads as a tie.
5. **Hold the render until `ready`** on a conversion surface. Rendering control
   and swapping to the variant means that visitor saw both arms and belongs to
   neither.

## Related

- [[seo-distribution-and-measurement]] — how channel attribution is measured;
  UTM capture is the other half of making conversion work measurable.
