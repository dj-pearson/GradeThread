# Newsletter kickoff trigger — Make.com contract (US-923)

The autonomous newsletter pipeline has **exactly one external touchpoint**: a single
Make.com (or Coolify cron) scenario that pings the kickoff endpoint on a schedule.
Everything after the trigger — assembling the issue, the pre-send QA/guardrail gate,
scheduling, and the gated send — is automated. The endpoint **self-gates on cadence**,
so the Make schedule can be dead simple (even hourly) and re-triggers within the same
period are harmless no-ops.

## Endpoint

```
POST https://functions.gradethread.com/api/newsletter/scheduler/tick
```

> ⚠️ Routing: this is a **Hono edge** route, so it lives on `functions.gradethread.com`,
> NOT `api.gradethread.com` (Supabase/Kong). Hitting `/api/*` on `api.*` silently 404s.

Body is optional. `{"force": true}` bypasses the cadence gate and creates an issue this
tick (operator/testing use). The endpoint is also safe to call from the dashboard
"Run now" button with an admin JWT.

### Lightweight check

```
POST /api/newsletter/scheduler/test   →   { "ok": true, "ts": "<iso>" }
```

Use this in Make to validate the URL + secret before enabling the live cron.

## Authentication (pick one)

Same auth shape as the content scheduler / drip tick. The shared secret is
`NEWSLETTER_INTERNAL_JOB_SECRET` (constant-time compared; supports
`NEWSLETTER_INTERNAL_JOB_SECRET_OLD` for zero-downtime rotation).

1. **Static header (simplest for Make):**
   ```
   X-Internal-Job-Secret: <NEWSLETTER_INTERNAL_JOB_SECRET>
   ```

2. **Signed timestamped request (preferred — the secret never crosses the wire):**
   ```
   X-Internal-Job-Timestamp: <unix epoch seconds>
   X-Internal-Job-Signature: hex(HMAC-SHA256(secret, "v1:<ts>:POST:/api/newsletter/scheduler/tick"))
   ```
   Valid inside a 5-minute window and single-use (replays rejected).

3. **Admin JWT** (`Authorization: Bearer <token>`) — the dashboard "Run now" path.

A request that *presents* a signature header but fails verification is rejected
outright (it does not fall through to weaker auth).

## What one tick does

1. **Create (cadence-gated):** if the program is due — no issue created within
   `newsletter_cadence_period_days` (settings registry, default 7) — build the next
   editable draft and fire an `issue.created` webhook. Otherwise creation is skipped
   (`createdSkipped: true`) and the tick still advances/dispatches existing issues.
2. **Advance:** push gateable issues that already carry real content through the
   autonomous pre-send guardrail gate (US-924) toward `approved`. Bare scaffolds
   (no subject yet) are left as drafts for the copywriter.
3. **Dispatch:** release due approved issues through the gated weekly dispatcher
   (cadence guard + send-time optimization), firing an `issue.sent` webhook for any
   issue that completes this tick. Skipped while `newsletter_send_paused` is set.

**Safety:** a job-lock (`newsletter-kickoff`) prevents overlapping runs; the master
kill-switch is the `newsletter` feature flag (when off, the whole tick no-ops). Every
run is recorded to `cron_runs` and shows in the Operations → Jobs console (US-881).

### Response

```jsonc
{
  "ok": true,
  "created": "<issue-uuid|null>",   // new issue id, or null when not due
  "createdSkipped": false,           // true when cadence not yet elapsed
  "advanced": 0,                     // issues run through the QA gate
  "released": 0,                     // issues the dispatcher released
  "sentNotified": 0,                 // issue.sent webhooks fired
  "webhooks": { "created": true, "sent": 0 }
}
```

A `{ "ok": true, "skipped": true, "reason": "..." }` response means a deliberate skip
(lock held, program halted) — Make should treat it as success.

## Downstream webhook contract (issue lifecycle → Make)

On `issue.created` and `issue.sent`, a signed notification is POSTed to the configurable
URL in the settings registry key **`newsletter_make_webhook_url`** (empty = disabled).
Wire a *second* Make scenario to that URL for any downstream automation (e.g. cross-post
the issue, log to a sheet, notify Slack).

- **Headers:**
  ```
  X-Newsletter-Event: issue.created | issue.sent
  X-Newsletter-Signature: hex(HMAC-SHA256(NEWSLETTER_WEBHOOK_SIGNING_SECRET, <raw body>))
  ```
  Verify the signature before trusting the body. The header is absent only when no
  signing secret is configured.
- **Delivery:** 3 attempts (0s / 5s / 30s, 10s per-attempt timeout). Every attempt is
  logged to `newsletter_webhook_log`; a terminal failure raises an ops alert.
- **Body:**
  ```jsonc
  {
    "event": "issue.created",
    "timestamp": "<iso>",
    "data": {
      "id": "<issue-uuid>",
      "title": "...",
      "subject": "...",
      "status": "draft",
      "scheduled_for": "<iso|null>",
      "pillar": "...",
      // issue.sent additionally carries:
      "sent_at": "<iso>",
      "recipients_total": 0, "sent_count": 0, "skipped_count": 0, "failed_count": 0
    }
  }
  ```

## Idempotency / "safe to over-fire"

- **Creation** is gated by the cadence period, so calling the endpoint more often than
  the cadence never creates a second issue in the same period.
- **Dispatch** is idempotent: send windows are assigned once and the per-recipient
  ledger upserts with `ON CONFLICT DO NOTHING`, so re-runs never double-send.
- **`issue.sent`** fires exactly once per issue (an issue leaves the dispatcher's
  approved/sending selection the moment it flips to `sent`).
- The **job-lock** guarantees no two ticks run concurrently.

> If you also run the legacy `/api/jobs/newsletter-dispatch` Coolify cron, prefer the
> single kickoff trigger instead — running both can let an issue reach `sent` via the
> dispatch cron without firing the `issue.sent` webhook. The kickoff tick already calls
> the same dispatcher, so it fully supersedes the standalone dispatch cron.

## Secrets (env config — never hardcoded)

| Var | Purpose |
|---|---|
| `NEWSLETTER_INTERNAL_JOB_SECRET` (+ `_OLD`) | kickoff trigger auth |
| `NEWSLETTER_WEBHOOK_SIGNING_SECRET` | HMAC for outbound lifecycle webhooks |
| `newsletter_make_webhook_url` (settings registry) | downstream Make webhook URL |

Generate secrets with `openssl rand -hex 32`.
