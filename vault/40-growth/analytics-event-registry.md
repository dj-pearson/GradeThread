---
title: Analytics event registry
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/analytics-events.ts
  - src/lib/analytics.ts
  - src/lib/buyer-analytics.ts
  - src/lib/__tests__/analytics-events.test.ts
reviewed: 2026-08-18
tags: [analytics, posthog, measurement, naming]
summary: Every product event name is declared in src/lib/analytics-events.ts and enforced by tsc; two naming conventions are live and neither may be renamed.
---

# Analytics event registry

The full list of event names lives in **`src/lib/analytics-events.ts`** and
nowhere else. This note carries the two things the code cannot tell you: why the
names look inconsistent, and why that must not be fixed casually.

Filed and built as US-2446 (2026-08-09).

## What is enforced

`track()` takes `AnalyticsEvent`, not `string`. A name that is not declared fails
`npx tsc -b` at the call site. A guard suite checks the same thing from the other
side: no declared entry may sit unemitted, and `track()`'s signature may not be
widened back to `string` — that last one matters because the type check is the
whole enforcement mechanism, and widening it would leave every other test green.

Both directions were **mutation-tested**, not assumed: renaming a registry key,
passing an invented literal, and typo-ing a `buyer_funnel_*` name each produce a
`tsc` error, and a valid name still compiles.

## ⚠ Two naming conventions are live, and both are correct

At the time of the registry there were 59 distinct names across 75 call sites:

- **30 snake_case** — `cert_share`, `referral_share`, `passport_scan_lookup`,
  `measure_correction_saved`, `reward_celebration_shown`.
- **29 dotted and namespaced** — `subscription.paused`, `grade.paid`,
  `plan_picker.cta_clicked`, `upgrade.trigger.hard`, `content.draft.created`.

The dotted set is not random drift. It is coherent and covers the **money
surfaces** (subscription, plan_picker, credit_pack, trial, upgrade, grade.paid),
which reads as a convention introduced later and never backfilled.

**Do not unify them as part of any other change.** These strings are the join key
for every saved PostHog insight, funnel and dashboard. A rename does not error —
it orphans the history and the chart quietly goes flat, which nobody notices
until someone asks why conversion "dropped" on the day of the refactor.
Unifying may well be right; it is a separate decision that has to migrate the
saved queries alongside the code. A test asserts both families still exist so a
tidy-up fails loudly rather than silently.

## A name has to carry what it observes

Each entry has a one-line note saying what the event **observes**, not what is
assumed to have happened. Two entries exist because that distinction is real:

- `reward_celebration_shown` records the client **displaying** a reward moment.
  The grant itself happens on the edge and is already in `reputation_events`. A
  client-side "reward_granted" would double-count across tabs and miss anyone who
  never returns. See [[reward-ledger]].
- `trial.started` fires on **signup, for everyone** — the 14-day Pro trial is
  granted by the `handle_new_user` trigger, not chosen. A "trial conversion rate"
  built on it is a signup conversion rate under another name.

Both are cases where a reasonable person reads the name and gets the meaning
backwards. That is what the notes are for.

## The computed-name family

`buyerFunnelEventName()` builds its name from a step, so its events cannot be
listed as literals. They are typed as a **template literal**
(`buyer_funnel_${step}`) rather than given an escape hatch. This was the part
expected to need a cast and did not: the family stays fully enumerable, adding a
step to `BUYER_FUNNEL_STEPS` legalises its event automatically, and a typo in a
hand-written `buyer_funnel_*` literal is still rejected. No `as`, no `any`, no
widening — which matters, because any of those would have reopened exactly the
hole the registry closes.

## An absent event is a claim you cannot check (GT-001, 2026-08-15)

Signup emitted `trial.started`, `signup.buyer` and `signup.source_selected`.
Verification emitted nothing at all — not the check-your-email screen, not a
resend, not a success, not a failure. So "people sign up and never come back"
was sayable and not locatable: the funnel ended at the last event before the
part that was broken.

Four names close it, and the `reason` on the failure one is the point of the
exercise rather than a detail:

| Event | What it observes |
|---|---|
| `signup.confirm_sent` | the check-your-email screen rendered; the denominator |
| `signup.confirm_resend` | a second email was asked for (`at`: signup or confirm) |
| `signup.email_verified` | a confirmation completed (`via`: link or code) |
| `signup.verify_failed` | it did not (`reason`: cross_device_pkce, link_expired, code_expired, code_rejected, callback_timeout) |

`cross_device_pkce` is the one worth watching. It counts people who opened the
mail on a device that cannot finish the exchange, which is a configuration
problem wearing the costume of user error — see the `auth_email_hook` group in
`env-validation.ts`. A spike there is an operator action, not a UX experiment.

These are emitted from the CLIENT, so they see only people who reach the app. An
email that never arrives produces `signup.confirm_sent` and then silence, the
same shape as an email ignored. The two are told apart by SES delivery, not here.

## Handoffs share a property shape, not an event name (US-9018, 2026-08-18)

A free public page that sends someone to a FlipDesk page is a handoff, and there
are going to be several: comparison pages, calculators, the flaw library. Each
gets its own event name, because they are separate surfaces with separate
denominators and merging them would make "what fraction of comparison readers
click through" unanswerable.

What they share is the property pair, and that is the part worth writing down:

| Property | What it holds |
|---|---|
| `source` | the slug of the page the click came from, e.g. `vinted-vs-mercari` |
| `destination` | the FlipDesk surface it points at, e.g. `flipdesk-crosslisting` |

One shape means one saved query answers "which free pages actually feed
FlipDesk" across every surface, instead of one query per surface plus a manual
union. `comparison_crosslist_cta_click` is the first to use it. US-9010's
calculator handoff is the second and must match.

Related: [[buyer-economy]].
