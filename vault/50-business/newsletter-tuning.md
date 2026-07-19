---
title: Newsletter tuning
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [email, newsletter, growth]
summary: Cadence, segmentation and the levers that move open and click rates.
---
# Newsletter self-tuning (closed loop from engagement) — US-928

The autonomous newsletter program learns from how readers engage and feeds that
back into **what** it sends, **how** it writes the subject, and **when** it sends
— with no manual inputs. The loop is fully data-driven from the engagement tables
and guarded against runaway narrowing.

## The loop

```
issues are assembled ──► sent ──► opens / clicks / unsubscribes recorded
        ▲                                         │
        │                                         ▼
   weights bias the   ◄──  analysis job aggregates per topic /
   next assembly           subject-style / send-hour and re-tunes weights
```

1. **Provenance.** Every issue records the dimensions it used:
   `newsletter_issues.pillar` / `angle` (the topic), `subject_style`, and
   `send_hour` (migration `00281`).
2. **Engagement ledger.** Per-recipient `opened_at` / `clicked_at` /
   `unsubscribed_at` on `newsletter_issue_recipients` (migration `00281`) are the
   signals. (Population is the open/click-pixel + unsubscribe wiring; the column
   home + aggregation live here so the loop is data-driven by construction.)
3. **Analysis job.** `POST /api/jobs/newsletter-tuning`
   (`routes/jobs-newsletter-tuning.ts`, cron `45 12 * * *`, job-locked, recorded
   to `cron_runs`) aggregates engagement per topic / subject-style / send-hour and
   per issue, computes selection weights, and persists them. An operator can force
   a pass from the console (`POST /api/admin/newsletter/tuning/recompute`).
4. **Assembler bias.** `build-next` reads the computed weight stores and picks the
   topic + subject style by weighted selection, and schedules the send at the
   learned best hour, stamping all three back onto the issue.

## Weighting (pure, tested)

`lib/newsletter-tuning.ts` is supabase/env-free (mirrors `drip-optimizer.ts`) so
it unit-tests directly (`tests/newsletter-tuning_test.ts`).

- **Winner** = best click-through rate among *trusted* (sent ≥ `minSample`)
  non-paused dimensions, open rate as the tiebreak. A newsletter's job is the
  click-through, so CTR is the goal — never opens alone.
- **Exploration floor** — a fixed fraction of weight is split across all surviving
  dimensions so under-tested topics keep airtime (no premature convergence).
- **Unsub ceiling** — a sufficiently-sampled dimension whose unsubscribe rate
  exceeds the ceiling is **paused** (weight 0). The loop never pauses the last
  surviving topic.
- Below the sample threshold there is no winner → uniform weights (keep gathering
  data).

## Configuration (settings registry — override without a deploy)

| key | default | meaning |
|---|---|---|
| `newsletter_tuning_enabled` | `true` | freeze the weights when off (program keeps running) |
| `newsletter_tuning_min_sample` | `50` | sends before a rate is trusted |
| `newsletter_tuning_exploration_floor` | `0.15` | weight reserved across survivors |
| `newsletter_tuning_unsub_ceiling` | `0.005` | unsub rate that pauses a topic |

Computed stores (written by the job, read by the assembler):
`newsletter_topic_weights`, `newsletter_subject_style_weights`,
`newsletter_send_hour_stats`, and the `newsletter_tuning_recommendations`
snapshot the admin console surfaces.

## Admin transparency / override

The Newsletter Console (`/admin/growth` → newsletter) shows a **Self-tuning**
card: current topic weights, per-dimension open/click/unsub rates, the winner,
paused topics, the best send hour, and a *Recompute now* button
(`GET /api/admin/newsletter/tuning`). Operators override any weight directly from
the system settings registry editor (`/admin/ops/settings`).

## Related

- [[deliverability]] — tuning is pointless if the mail does not land
- [[content-scheduler]] — what queues the sends
- [[INDEX]]
