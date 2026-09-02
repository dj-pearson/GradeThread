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
reviewed: 2026-09-02
tags: [analytics, posthog, measurement, naming]
summary: Every product event name is declared in src/lib/analytics-events.ts and enforced by tsc; two naming conventions are live and neither may be renamed.
---

# Analytics event registry

> **Re-reviewed 2026-09-02.** Drift flagged `src/lib/analytics-events.ts` for the
> cross-listing batch, which adds four names, all snake_case, all declared rather
> than passed as strings: `closet_import_started` and `closet_import_completed`
> (US-9201), `review_approved` (US-9204) and `extension_install_cta_click`
> (US-9210). Nothing in this note staled -- it names no count and no list.
>
> One of them is worth a line because of what it carries rather than what it is
> called. `review_approved` reports `seconds_from_first_photo`, `channels_now`
> and `channels_queued`: a duration and two counts, never an item id, so the
> hours-saved number can be computed without the event joining back to a
> seller's inventory. That is the shape to copy for any future "how long did
> this take" event.

> **Re-reviewed 2026-08-31.** Drift flagged `src/lib/analytics-events.ts` for US-9033, which ADDS
> `rn_lookup_searched`, `rn_tag_read` and `rn_lookup_cta_click`, all in the
> existing snake_case convention. Re-verified while here: this note names no
> event count, so the addition cannot have staled it, and all three names are
> declared in the registry rather than passed as free strings — which is the
> rule that makes `tsc` the enforcement.
>
> `rn_lookup_cta_click` landed last and closes a measurement hole worth naming:
> the hub shipped with the two read events and no conversion event at all, so
> the funnel could show that 10,000 monthly searches arrived and nothing about
> whether any of them became a signup. It matches `grade_checker_cta_click`,
> `cta` payload included, so the two free tools are comparable.

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

## The computed-name families

`buyerFunnelEventName()` builds its name from a step, so its events cannot be
listed as literals. They are typed as a **template literal**
(`buyer_funnel_${step}`) rather than given an escape hatch. This was the part
expected to need a cast and did not: the family stays fully enumerable, adding a
step to `BUYER_FUNNEL_STEPS` legalises its event automatically, and a typo in a
hand-written `buyer_funnel_*` literal is still rejected. No `as`, no `any`, no
widening — which matters, because any of those would have reopened exactly the
hole the registry closes.

US-2884 added the SECOND family the same way, deliberately rather than by
precedent: `activationEventName()` computes `activation_${step}` from the ordered
step list in `activation-analytics.ts`, and `ActivationEventName` is the matching
template literal. Two families for the same idea would have made the two funnels
uncomparable, so the shape was copied on purpose. The steps and their splits are
[[activation-funnel]]; the iOS half is generated from the same array, so the
names cannot fork across clients.

A third family is a decision, not a default. Add one only when the names really
are computed from an ordered list, and copy this shape when you do.

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

## The calculator funnel (US-9010, 2026-08-18)

Four steps, and the question it exists to answer is the story's own: is the
calculator family an acquisition channel, or just traffic.

| Step | Event | Fires | Key property |
|---|---|---|---|
| 1 | `calculator_view` | on mount of any `/tools/*` calculator | `calculator` = slug |
| 2 | `calculator_used` | ONCE, on the first input change this visit | `calculator` |
| 3 | `calculator_cta_clicked` | on the handoff into the matching FlipDesk surface | `calculator`, plus `{source, destination}` |
| 4 | `signup_started_from_tool` | on the FlipDesk signup control, only when the visit came from a calculator | `calculator`, `landing` |

**Step 2 is not step 1.** A visitor who lands on the eBay fee calculator, reads
the Store-tier table and leaves is a different animal from one who typed their
own numbers in. Both are useful; conflating them makes the conversion rate
meaningless, because the denominator would be dominated by readers who never
intended to use the tool.

**Attribution survives the hop.** The handoff does not go to `/signup`, it goes
to the matching `/flipdesk/*` page, which is where the product is explained. The
calculator slug rides across in a `from` query parameter
(`TOOL_SOURCE_PARAM` in `src/components/marketing/calculator-funnel.tsx`), the
landing page reads it back, and `signup_started_from_tool` fires only when it is
present. Without that, every tool-driven signup would be credited to the landing
page and the calculator that caused it would vanish.

### One page where step 2 is a different event (US-9022, 2026-08-28)

On `/tools/reseller-inventory-spreadsheet` the DOWNLOAD is the tool. There is
no input to change, so `calculator_used` would fire for anyone who scrolled and
report every visitor as having used it - which makes the use rate below read as
100% for that one slug and drags the family average with it.

`inventory_template_downloaded` (property `slug`) is step 2 for that page.
Substitute it wherever query 2 and query 3 say `calculator_used`, for that slug
only. The other three steps are unchanged, because the handoff and the signup
work the same way.

This is worth stating because the alternative looks tidier and is wrong: making
the download emit `calculator_used` would keep one query definition and quietly
mean two different things by it.

### The four saved queries (AC3)

These are the definitions, not a dashboard — the dashboard is built in PostHog
by hand and this is what it has to compute.

1. **Sessions per calculator.** `calculator_view` counted by `calculator`,
   unique by session. The denominator for everything below.
2. **Use rate.** `calculator_used` / `calculator_view`, by `calculator`. How
   many arrivals actually compute something. A low number here means the page
   ranks for a question it answers in prose before the tool is reached.
3. **Handoff rate.** `calculator_cta_clicked` / `calculator_used`, by
   `calculator`. Deliberately over USED, not over VIEW: the question is whether
   someone who got a result wants the product, and dividing by readers who never
   touched an input buries that.
4. **Signup conversion.** `signup_started_from_tool` / `calculator_cta_clicked`,
   by `calculator`. The last hop, and the one where a mismatched handoff shows
   up: a calculator whose click rate is fine and whose signup rate is not is
   pointing at the wrong FlipDesk surface.

### The baseline (AC4)

The first calculator shipped **2026-08-18** (US-9003), so the 30-day baseline is
due **2026-09-17**. It is not recorded here yet and must not be guessed: the
kill criteria in US-9016 compare against it, and a baseline invented before the
window closed would make those criteria unfalsifiable. Record all four rates
per calculator on that date.

## The commercial landing funnel (US-9009, 2026-08-18)

Three events, in order, and the reason they exist is that this segment cannot be
judged the way the rest of the SEO backlog is judged.

| Step | Event | Fired |
|---|---|---|
| 1 | `commercial_landing_view` | on mount of any `/flipdesk/*` landing page, property `landing` = the slug |
| 2 | `commercial_landing_signup_start` | on the primary call to action, same `landing` property |
| — | `crosslist_listicle_vendor_handoff` | the listicle sending commercial intent to the vendor page, `{source, destination}` |

**Step one fires on mount, not on a click.** A conversion rate needs its
denominator, and a click-only event gives you a numerator and nothing to divide
it by. That is the mistake GT-001 records in a different form.

**Why conversion and not position.** Combined volume across the five commercial
terms US-9009 targeted is 2,200/mo, and `docs/seo/crosslisting-cluster-diagnosis.md`
found the SERP is held by independent listicles that a vendor page structurally
cannot outrank: GradeThread's own crosslisting listicle sits at position 51.5
while every other crosslisting page on the site ranks in the top 11, and the
difference is that the listicle is a "best apps" list published by one of the
apps. So the landing pages are not trying to win that SERP. Their job is to
catch traffic that already arrived from the calculators, which makes the share
of arrivals that start a signup the only number that says whether they work.

The `calculator_grading_cta_click` event (US-9006) is the other exit from step
one and uses the same `{source, destination}` pair described above.

Related: [[buyer-economy]].
