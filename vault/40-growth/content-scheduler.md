---
title: Content scheduler
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-09-02
tags: [content, scheduling]
summary: How scheduled posts are queued, fired and recovered when a run is missed.
---
# Content Scheduler — Cron Wiring & Safe Rollout

The autonomous content engine publishes on-brand blog + social posts with **no
human in the loop**. This doc covers how the cron is wired, the env var it needs,
and the **safe low-cadence rollout** to turn it on without spamming live channels.

- Edge handler: `services/edge-functions/src/routes/content-scheduler.ts`
- Admin config: `/admin/content/settings` (cadence, models, toggles, kill-switch)
- Admin observability: `/admin/content/analytics` (autopilot state, recent
  publishes per surface/product, topic-bank levels, webhook health)

> **Dependencies:** the knowledge base (US-850, migration `00191`) and the topic
> bank (US-851, migration `00192`) must be seeded before turning autopilot on, or
> the first ticks will refill from research instead of publishing.

---

## What one tick does

`POST /api/content/scheduler/tick` is idempotent and safe to call on a cron. Each
tick, in order:

1. **Kill-switch check** — if `content_settings.publishing_paused` is true, the
   tick does **nothing** and returns `{skipped, reason:"publishing paused"}`.
2. **Promote scheduled drafts** — any `blog_posts`/`social_posts` with
   `status='scheduled'` and `scheduled_for <= now` are published (with optimistic
   concurrency), regardless of cadence. So the cron doubles as the
   scheduled-post processor — no separate cron needed.
3. **Pick a surface** — `blog` if today's blog count < `post_cadence_per_day_blog`,
   else `social` if under `post_cadence_per_day_social`, else skip ("cadence met").
   A day's slot is consumed by a post the scheduler **authored** today, published
   or not (deduped by id, `failed` generations excluded). Counting only
   *published* posts starved the second surface whenever the first one's
   `auto_publish_*` flag was off: with `auto_publish_blog=false` the blog count
   stayed 0 forever, so every tick picked `blog` and social was never generated
   at all — the exact configuration the rollout below asks for. It also made an
   hourly cron author a blog article every hour instead of once a day.
4. **Pick a product** — whichever of `gradethread`/`flipdesk` has fewer posts in
   the last 14 days (keeps the two balanced).
5. **Refill the topic bank** — if the chosen (surface, product) slice has fewer
   than `min_topics_in_bank` queued topics, research a `topics_refill_batch` of
   new ones first.
6. **Generate** the post from the next queued topic.
7. **Safety gate** (`reviewContentSafety`) — the autonomous path is the only one
   with no human review, so it must pass. On fail the post is **held** as a draft
   (`safety_status='held'`) with notes for a human; the topic stays `assigned`.
8. **Weekly ceiling** (SOCIAL only) — if AI **social** posts published in the
   last 7 days ≥ `max_auto_publishes_per_week`, a social tick still generates but
   demotes to draft instead of publishing (hard cap independent of daily
   cadence). **Blog is uncapped** (product decision 2026-06): every generated
   blog article publishes on completion; the safety gate (step 7) is the backstop
   that holds risky posts. Blog publishes do not count toward the ceiling —
   until 2026-09-02 they did, and with blog autopilot at 2/day the cap of 10 was
   reached by blog alone, so every social post landed in drafts with the run
   log reading "success". If social posts generate but never publish, check
   this ceiling before anything else.
9. **Publish** (only if the surface's `auto_publish_*` flag is on) → stamp
   `published_at` → mark topic `used` → append to history index → dispatch
   Make.com webhook → purge Cloudflare cache (blog) → write a system audit row.

If `auto_publish_*` is **off**, the tick stops at step 6/7 and leaves a `draft`
for a human to publish from the dashboard.

> **Social publishing has a hard precondition (US-2104):** if every
> `make_webhook_social` / `_long` / `_short` is unset there is nowhere to fan out
> to, so **no** social path will mark a post `published` — the tick leaves it a
> draft, due scheduled posts stay `scheduled`, and the manual publish button
> returns `422 social_webhook_unconfigured`. `auto_publish_social=true` on its
> own publishes nothing; set a webhook in Content Settings first. A *configured*
> webhook that fails still publishes — that payload is logged, dead-lettered and
> replayable.

Other endpoints on the same router (same auth):
- `POST /api/content/scheduler/test` — `{ok:true,ts}` ping to validate secret + URL.
- `GET  /api/content/scheduler/summary?days=7` — weekly-digest JSON (what
  published, topics added/used, webhook success rate, bank levels).

---

## Auth

The scheduler router accepts **either** of:

- **Internal job secret** — header `X-Internal-Job-Secret: $CONTENT_INTERNAL_JOB_SECRET`
  (constant-time compared; `CONTENT_INTERNAL_JOB_SECRET_OLD` is also accepted
  during a zero-downtime rotation window).
- **Signed request** (preferred for Make.com) — header `X-Internal-Job-Signature`
  is an HMAC bound to method+path with a freshness window and single-use replay
  rejection, so the secret never crosses the wire.
- **Admin JWT** — the dashboard "Generate next" buttons fall through to
  `authMiddleware + adminAuthMiddleware`.

> `CONTENT_INTERNAL_JOB_SECRET` is its **own** secret, distinct from
> `FLIPDESK_INTERNAL_JOB_SECRET`. Set it in Coolify before wiring the cron.

---

## Wiring the cron

Run the tick **hourly**. Cadence is enforced inside the tick (per-day counts), so
an hourly cron with `post_cadence_per_day_blog=1` publishes ~1 blog/day — the
extra ticks just return "cadence met". An hourly tick also means a scheduled post
fires within ~1h of its `scheduled_for`.

### Option A — Coolify scheduled task (recommended; in-container, skips WAF)

Coolify → edge service → **Scheduled Tasks** → add:

| Field | Value |
|---|---|
| Name | `content-scheduler-tick` |
| Schedule | `0 * * * *` (hourly) |
| Command | see below |

```sh
curl -fsS -X POST http://localhost:8787/api/content/scheduler/tick \
  -H "X-Internal-Job-Secret: $CONTENT_INTERNAL_JOB_SECRET" \
  -H "Content-Type: application/json" -d '{}'
```

Click **Run Now** once and confirm a JSON body (`{"skipped":true,...}` is a
healthy idle response; `{"status":"published"|"draft"|"held",...}` means it acted).
`localhost:8787` hits the container directly, skipping Traefik/WAF — same pattern
as every other job in `vault/10-ops/launch-checklist.md` §3.

### Option B — Make.com scenario

1. **Scheduler** module → every 1 hour.
2. **HTTP → Make a request**: `POST https://functions.gradethread.com/api/content/scheduler/tick`,
   header `X-Internal-Job-Secret` = your secret (or compute the signed
   `X-Internal-Job-Signature`), body `{}`.
3. The publish webhooks (`make_webhook_blog` / `_social_long` / `_social_short`)
   are configured separately in **Content Settings** and fire *from* the edge
   when a post publishes — they are the downstream of this tick, not the trigger.
   Their payload contract, signing, per-channel UTM rewrite, and how to add a
   channel are documented in [CONTENT_PUBLISHING.md](./CONTENT_PUBLISHING.md).

---

## Safe rollout (start LOW)

Do this in order; each step is reversible from **Content Settings**.

1. **Seed & verify** the knowledge base + topic bank are non-empty
   (`/admin/content/analytics` → Topic bank levels — no slice should be red).
2. **Wire the cron with autopilot OFF.** Defaults ship safe:
   `auto_publish_blog=false`, `auto_publish_social=false`,
   `publishing_paused=false`, cadence blog `1`/day + social `2`/day,
   `max_auto_publishes_per_week=10`. The tick now generates **drafts only**.
3. **Review a few generated drafts** in Blog/Social lists. Confirm voice, claims,
   and that the safety gate isn't over-/under-holding.
4. **Set a social webhook, then turn on social autopilot first** (lower stakes),
   keep blog manual. The webhook is not optional — without one the tick
   deliberately refuses to publish (see the callout above). Drop social cadence
   to `1`/day for the first week. Watch `/admin/content/analytics` → Autopilot +
   Recent activity + Webhook success.
5. **Turn on blog autopilot** once social looks good. Keep the weekly ceiling low
   (e.g. `7`) until you trust it.
6. **Tune up** cadence/ceiling gradually. Everything is a number field in
   Content Settings; no deploy needed.

**Emergency stop:** flip **Pause all publishing** in Content Settings
(`publishing_paused=true`). The next tick does nothing — no auto-publish, no
scheduled-draft promotion. Manual dashboard publishing still works.

---

## Verifying it end-to-end

- **Manual tick:** Blog/Social list pages have a "Generate next" button
  (`useSchedulerTick`) that POSTs `/tick` with an admin JWT — use it to dry-run
  without waiting for the cron.
- **What published & when:** `/admin/content/analytics` → Autopilot status +
  Recent activity (per surface/product, with timestamps) + Published-30d
  breakdown.
- **Webhooks:** Content Settings → Recent webhook deliveries (retry failures
  one-click); Analytics → Webhook success KPI.
- **Audit trail:** every autonomous publish/hold writes a system audit row
  (`content.blog_publish`, `content.social_publish`, `content.blog_held`, …).

## Related

- [[content-publishing]] — the fan-out this triggers
- [[INDEX]]
