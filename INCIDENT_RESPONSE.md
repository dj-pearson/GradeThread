# Incident Response & On-Call (US-506)

Per-scenario recovery runbooks + escalation, so incidents have a documented path.

This file covers **availability / operational** incidents. Security incidents
(breach, leaked secret, account compromise) follow
[`docs/INCIDENT_RESPONSE.md`](docs/INCIDENT_RESPONSE.md), which also holds the
monitor inventory, alert thresholds, and the end-to-end alert drill (US-500).

## Severity levels

| Sev | Definition | Response | Examples |
|---|---|---|---|
| **SEV1** | Customer-facing outage or data-loss risk | Page on-call immediately; all-hands | Site/API down, DB unreachable, billing double-charging, data corruption |
| **SEV2** | Major degradation, money/grades at risk | Page on-call; fix same day | Grading failing, webhooks dropping, eBay publish broken, mass email failure |
| **SEV3** | Minor / contained | Ticket; fix next business day | One cron failing, elevated latency, single-tenant issue |

## On-call & escalation

GradeThread runs a **single-operator on-call** model until headcount grows:
the founder is primary on-call 24/7. Redundancy comes from independent alert
channels (one dead channel never hides an incident) and from the
auto-remediation crons (stuck-submission sweep, webhook dead-letter capture,
token-refresh backoff) that contain damage until a human responds.

| Role | Who | Reach via |
|---|---|---|
| Primary on-call | DJ Pearson (founder, Pearson Media LLC) | On-call Slack channel (the `MONITOR_ALERT_WEBHOOK` / `UPTIME_ALERT_WEBHOOK` destination); GitHub `uptime` issues (repo watch with mobile push); Sentry email; pearsonperformance@gmail.com |
| Secondary / escalation | Pearson Media leadership | Phone — private contact sheet (kept OUT of this repo, deliberately) |
| Final escalation / comms owner | Pearson Media LLC (owner) | Same channels; owns user notification, `/status` + social updates |

**Ack targets** (clock starts at the first *confirmed* alert — see
`UPTIME_MONITORING.md` for what counts as confirmed): **SEV1 = 15 min,
SEV2 = 1 h, SEV3 = next business day.**

**Escalation ladder** (SEV1; advance every 15 unacknowledged minutes):
1. On-call via the Slack channel mention / assigned `uptime` issue.
2. Phone (private contact sheet).
3. If user data may be affected, switch to the security flow in
   [`docs/INCIDENT_RESPONSE.md`](docs/INCIDENT_RESPONSE.md).

All three alert sources — Sentry (`SENTRY_DSN`), the edge service's
`MONITOR_ALERT_WEBHOOK`, and the uptime monitor's `UPTIME_ALERT_WEBHOOK`
(`UPTIME_MONITORING.md`) — must point at the same on-call channel before
launch (`LAUNCH_CHECKLIST.md`), and everyone on call watches the repo with
issue notifications enabled.

## Detection

- Synthetic monitors → `UPTIME_MONITORING.md`.
- App alarms → the error tracker (US-491) + metrics (US-508): `circuit.open`,
  `submissions.stuck`, `webhook.fail_open/closed`, `email.dead_lettered`,
  `integrity.anomaly`, `grading_monitor.alert_*`.

## Per-scenario runbooks

### 1. Database outage / unreachable
1. Confirm: `/health/ready` → 503; `circuit`/DB errors in the tracker.
2. Check the Postgres host (disk full? OOM? crashed?). Restart if safe.
3. If the volume/data is lost → restore from backup: `BACKUPS.md` → "Restore
   procedure" (verified by drill; `scripts/ops/restore-postgres.sh`). Prefer
   PITR when WAL archiving covers the loss window.
4. After recovery: run `integrity-scan` cron; verify a test grade + certificate.

### 2. Edge crash-loop
1. `GET /health` failing; Coolify shows restarts.
2. Check container stdout (structured logs, correlation IDs) for the boot error —
   common cause: a missing migration (`MIGRATIONS.md`) or a bad env var.
3. Roll back to the last-good commit (`ROLLBACK.md`) while you fix forward.

### 3. Webhook backlog / dropped events
1. Stripe: check `webhook.fail_closed` metric + Stripe dashboard's failed
   deliveries. Fix the underlying DB issue; Stripe auto-retries (72h window).
2. eBay: `webhook.fail_open` means processed without a claim (idempotent) — check
   the tracker; re-run `ebay-orders-sync` to reconcile.

#### 3a. Dead-lettered webhook (non-transient handler bug) — US-772
A `webhook.dead_letter` Sentry event (or rows in the Admin → Dashboard "Dropped
webhook events" card) means a handler hit a **code bug** a Stripe retry can't
fix. The event returned 200 (so Stripe stops storming it) and was captured in
`webhook_dead_letters` with a redacted payload. To recover:
1. Open the card; read the error + redacted payload to identify the failing
   handler.
2. Fix the bug and deploy (`ROLLBACK.md` in reverse — ship the fix).
3. **Replay the event:** Stripe Dashboard → Developers → Events → search the
   `evt_…` id shown on the row → **Resend**. The resend is a *new* event id, so
   the idempotency claim (`processed_webhook_events`) won't dedupe it; the (now
   fixed) handler processes it, and the money-side effects are individually
   idempotent on the Stripe object id (US-390) so a partial first run is safe.
4. Confirm the side effect applied (credits granted / submission graded /
   subscription synced), then click **Mark resolved** on the card.
5. If the original PaymentIntent can't be reprocessed cleanly, refund via Admin →
   user Billing actions instead, and note it on the row before resolving.

### 4. Stuck submissions (grades stranded)
1. `submissions.stuck` metric > 0. The `stuck-submissions` cron auto-fails +
   refunds them every 10 min (US-495); confirm it's scheduled + running.
2. If grading itself is broken, flip the `grading` kill-switch (US-507) to stop
   taking money for grades that will fail, fix, then re-enable.

### 5. eBay token mass-refresh failure
1. Symptom: many connections show `refresh_error`; eBay breaker open.
2. If eBay is down → wait; the breaker backs off and refresh retries.
3. If it's a cert/app-cred issue → rotate per `KEY_ROTATION.md`; permanent
   failures (invalid_grant) require sellers to reconnect (US-463 surfaces this).

### 6. Cost spike / dependency overload
- Flip the relevant kill-switch (US-507): `grading`, `autolister`, `content_ai`,
  or `repricing` → graceful 503, no redeploy. Re-enable after.

### 7. Bad deploy
- `ROLLBACK.md` (Pages rollback / Coolify redeploy prior commit).

## Post-incident

Write a short post-mortem (timeline, root cause, fix, prevention) for SEV1/SEV2.
File follow-up work as new prd.json stories.

## Links

- Backups/restore: `BACKUPS.md` · Rollback: `ROLLBACK.md` · Migrations:
  `MIGRATIONS.md` · Uptime/alerting: `UPTIME_MONITORING.md` · Secrets:
  `KEY_ROTATION.md` · Scaling/degradation: `SCALING.md` · Security incidents +
  alert thresholds/drill: `docs/INCIDENT_RESPONSE.md`
