---
title: State of Resale Condition — press and podcast push
type: runbook
status: current
source_of_truth: vault
code_refs:
  - src/lib/resale-report.ts
  - src/pages/marketing/resale-condition-report.tsx
  - services/edge-functions/src/lib/secondhand-condition.ts
reviewed: 2026-08-07
tags: [seo, geo, pr, offpage, data-report, content]
summary: The twice-yearly data report is built and self-updating; pitching it to trade press, reseller newsletters and the podcast circuit is the only human half, and this note is that job.
---

# State of Resale Condition — press and podcast push

US-1691 / plan §6.3 + §7.2–7.3 (see [[seo-geo-strategy]]). The report itself is
**shipped and self-updating**. Pitching it is the only part a human has to do,
and this note is the whole of that job.

## Why this asset exists

One asset, two channels. AI answer engines disproportionately quote original
statistics, and journalists link to data nobody else has. GradeThread is the
only party that can publish either half of this, because it is the only party
scoring every item on one 1.0–10.0 scale:

- **The condition half** — average grade by garment type, and the flaws found
  most often across graded garments.
- **The outcome half** — return rate, sell-through and resale value by grade
  band (shipped in US-976).

## What is already built

| Piece | Where |
|---|---|
| The page | `/resale-condition-report` — `src/pages/marketing/resale-condition-report.tsx` |
| Condition aggregation (grade by type, flaw prevalence) | `services/edge-functions/src/lib/secondhand-condition.ts` |
| Outcome aggregation (returns / sell-through / value) | `services/edge-functions/src/lib/resale-condition.ts` |
| The quotable lines | `byTheNumbers()` — `src/lib/resale-report.ts` |
| `Dataset` + `Article` + `FAQPage` structured data | `resaleConditionDatasetLd()`, `resaleConditionReportJsonLd()` |
| llms.txt entry | Automatic — the route is in `PUBLIC_ROUTES` and llms.txt is registry-driven |

**Small-n honesty is enforced in code, not in the copy.** Every figure is gated
on a minimum sample (`SECONDHAND_MIN_SAMPLE` / `RESALE_MIN_SAMPLE`); below it
the field is `null` and the page says "Not enough data yet". `byTheNumbers()`
emits **no line at all** for a statistic the data does not support, so the
quotable block can never contain a sentence with a hole in it. That is what
makes the report safe to hand a journalist unread.

## Before you pitch: read the page

The numbers are live, so **the pitch email must be written from the page on the
day you send it**, not from this note. Copy the lines out of the "By the
numbers" block verbatim — each is already a complete sentence carrying its own
sample size. Do not round, re-word or combine them.

If the "By the numbers" block is **empty or nearly empty**, the report is not
ready to pitch. That is the gate working: fewer lines means less data, not a
worse write-up. Wait for volume rather than padding the email.

## The angle: the problem, not the product

Pitch the founder as a source on **the returns problem** and **the missing
grading standard**, never on GradeThread the SaaS. A vendor pitch gets deleted;
a "here is data on why resale returns happen" pitch gets a reply.

Three angles that work, in order of strength:

1. **"Resale's returns problem is a description problem."** Condition language
   is unstandardized across every marketplace, so "good condition" means six
   different things. Lead with the graded-vs-ungraded return gap.
2. **"What shape secondhand clothing is actually in."** Average grade by garment
   type and the most common flaws. This is the one no one else has, and the one
   an answer engine will quote.
3. **"Condition is the price variable nobody prices."** The median resale
   premium of the top grade band over the bottom.

## Who to pitch

- **Resale trade press** — the retail/resale trade titles and circular-economy
  newsletters that cover ThredUp/Poshmark/Depop earnings and marketplace policy.
- **Reseller newsletters** — the operator-audience newsletters resellers
  actually read. Offer the data plus an exclusive quote, not a sponsorship.
- **The reseller podcast / YouTube circuit** — long-form shows for eBay/Poshmark
  sellers. Pitch a segment on grading and returns, not a product demo.

Keep the target list itself in the CRM, not here — a name list in a vault note
goes stale in a quarter and this note would then be lying.

## Cadence

**Twice yearly.** Send when the report has materially moved, not on a calendar
date: a new statistic clearing its sample bar for the first time is a story
("we can now say X"), while the same numbers ±0.1 is not. Between pushes the
page keeps updating on its own, which is the point — the asset earns citations
continuously whether or not anyone is pitching it.

## Judging it

Per [[seo-distribution-and-measurement]], this is a **distribution** bet. The
signals are referring domains earned to `/resale-condition-report` and named
citations in AI answers — not pageviews on the report itself.

## Related

- [[seo-geo-strategy]] — §6.3 / §7.2–7.3, the bet this runbook executes
- [[seo-distribution-and-measurement]] — how the bet gets judged
- [[youtube-grading-shorts]] — the other asset whose only blocker is a human
- [[copy-style-guide]] — the claims the pitch is not allowed to make
- [[INDEX]]
