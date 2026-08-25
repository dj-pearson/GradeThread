---
title: Activation contract and funnel
aliases: [activation, onboarding-funnel, activation-steps]
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/activation-steps.ts
  - src/lib/activation-analytics.ts
  - src/hooks/use-activation.ts
  - ios/GradeThread/Telemetry/ActivationEvents.swift
reviewed: 2026-08-25
tags: [onboarding, analytics, contract, ios, privacy]
summary: One activation step list per persona, one event per funnel step named from that list, and the rule that renaming a step renames its event because both are generated from the same ordered array.
---

# Activation contract and funnel

Two things live together here because they cannot be changed apart: **what a
new account still has to do**, and **how we measure whether they did it**.

Established by US-2859 (the step list) and US-2884 (the funnel). This note is
what US-2884's AC4 asked for — and the AC assumed a contract note already
existed next to the step list. It did not; this is the first.

---

## 1. The step list

`src/lib/activation-steps.ts` is the single source of truth for "what does this
account still have to do". Every surface renders from it. Before it there were
four lists whose first steps disagreed.

**One list per persona:**

| Persona | Steps |
|---|---|
| seller / consignment | grade, item, source, ebay, (notifications) |
| developer | apikey, grade, (notifications) |
| buyer | extension, alert, closet |

Ordered the way a garment moves, not by how easy each step is.

### The rule that makes it work

**A step is done when the REAL THING happened** — a grade row exists, a source
row exists, eBay is connected — never when a button was clicked. That is why
the same list can be shown on more than one surface without the surfaces
disagreeing, and it is why the funnel below can measure completion at all.

### A step that cannot complete is banned

Not a style preference. US-2553 found a "Verify a certificate" step that could
never complete (the page records nothing against an account), and wrote down
why that is worse than a shorter list: **a permanently-lit step tells somebody
who has done everything that they have done nothing.**

US-2859 then reintroduced exactly that for buyers — a single `scan` step
written `isDone: () => false` — because it did not know the buyer's own
checklist existed. US-2883 removed it. `src/test/buyer-activation-parity.test.ts`
fails on the pattern now.

### The shell decides the persona, not the profile

Every seller can shop (US-1887), so a dual-role account has one `use_case` and
meets two shells. `useActivation(persona?)` takes an override; the buyer home
passes `"buyer"`, the seller surfaces pass nothing.

The dismissal is keyed **per persona** for the same reason, and a buyer
dismissal never writes `users.flipdesk_onboarded` — that column is named after
FlipDesk and belongs to the seller list.

---

## 2. The funnel

`src/lib/activation-analytics.ts` declares the ordered funnel. The order is
exported **as data**, so a drop-off chart needs no hand-maintained funnel
definition in the PostHog UI.

```
first_session → tour_finished / tour_skipped → persona_chosen
  → step_completed → first_grade → first_item
  → marketplace_connected → listing_published → sale_reconciled
```

`checklist_dismissed` is an **exit**, not a step. Putting it in the ordered
list would make every drop-off chart count giving up as progress.

### Renaming a step renames its event

The event name is computed: `activation_${step}`. So the array is the only
place a name exists, and the Swift enum is **generated from that same array**
by `scripts/generate-swift-mirrors.mjs`. Rename a step and both clients follow
in the same commit; `npm run verify` fails if they do not.

That is the answer to "how do we stop the two clients emitting different
names". `Telemetry.event(_:props:)` on iOS takes a raw `String`, and a typo
there is not an error — PostHog accepts the event and the funnel simply shows
iOS dropping to zero at that step, which is invisible until somebody looks.

### Emitted on completion, once per account

`activation_step_completed` fires when `isDone` turns true, **not** when the
button is pressed. US-2859's `onboarding.activation_step_started` records the
press and is kept: the gap between the two is the abandonment rate for that
step, which is the most useful single number this funnel produces.

The once-only marker is `localStorage`, keyed by user id and step. **Per
account and per device** — a second browser emits each step once more. A
durable answer means a column, which means a held migration (US-1108), and
PostHog funnels already take the first occurrence per person, so a duplicate
from a second device changes no chart this funnel is for.

### Privacy

`track()` is a no-op until the visitor opts into the analytics cookie
category, so these events are opt-in by construction — PostHog is not even
downloaded before that.

Beyond consent: **no activation event carries content.** No titles, brands,
emails, prices or free text. The only identifiers are opaque row ids; the only
other properties are enums the module declares.
`BANNED_ACTIVATION_PROPS` is a list rather than a review note, because a
reviewer reads a diff once and a test reads every one.

---

## 3. What is NOT built

**A saved PostHog view.** US-2884's AC3 asks for one, or an admin page.
Neither shipped:

- A saved view is a change to the live production analytics account, not a
  change to this repo. The funnel definition here is what makes one
  reproducible — ordered steps, declared splits (`persona`, `platform`) — but
  creating it is somebody's deliberate act against production.
- The admin funnel page (`/admin/analytics`) reads
  `/api/admin/analytics/funnel`, backed by the `funnel_metrics` RPC from
  migration 00229. An activation funnel there needs a new RPC, which needs a
  migration, which is held in this repo.

So the measurement ships and the chart does not. The events accrue from the
day this lands, which is the half that cannot be back-filled later.

## 4. Related

- [[product-vocabulary]] — the one-verb rule the step CTAs follow.
- `src/lib/buyer-analytics.ts` — the buyer funnel, same shape and the reason
  this one copies it rather than inventing a second convention.
