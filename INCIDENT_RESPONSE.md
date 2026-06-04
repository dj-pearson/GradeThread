# Incident Response & On-Call (US-506)

Per-scenario recovery runbooks + escalation, so incidents have a documented path.

## Severity levels

| Sev | Definition | Response | Examples |
|---|---|---|---|
| **SEV1** | Customer-facing outage or data-loss risk | Page on-call immediately; all-hands | Site/API down, DB unreachable, billing double-charging, data corruption |
| **SEV2** | Major degradation, money/grades at risk | Page on-call; fix same day | Grading failing, webhooks dropping, eBay publish broken, mass email failure |
| **SEV3** | Minor / contained | Ticket; fix next business day | One cron failing, elevated latency, single-tenant issue |

## On-call & escalation

> **MANUAL / LAUNCH-BLOCKER — fill in real contacts:**
> - Primary on-call: ______ (phone / PagerDuty)
> - Secondary / escalation: ______
> - Owner (final escalation): Pearson Media LLC — ______
>
> Alert channels feeding on-call: Sentry (`SENTRY_DSN`), `MONITOR_ALERT_WEBHOOK`
> (Slack/PagerDuty), and the uptime monitors (`UPTIME_MONITORING.md`). All three
> must point at the on-call channel before launch.

## Detection

- Synthetic monitors → `UPTIME_MONITORING.md`.
- App alarms → the error tracker (US-491) + metrics (US-508): `circuit.open`,
  `submissions.stuck`, `webhook.fail_open/closed`, `email.dead_lettered`,
  `integrity.anomaly`, `grading_monitor.alert_*`.

## Per-scenario runbooks

### 1. Database outage / unreachable
1. Confirm: `/health/ready` → 503; `circuit`/DB errors in the tracker.
2. Check the Postgres host (disk full? OOM? crashed?). Restart if safe.
3. If the volume/data is lost → restore from backup (`BACKUPS.md`; prefer PITR).
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
  `MIGRATIONS.md` · Monitoring: `UPTIME_MONITORING.md` · Secrets:
  `KEY_ROTATION.md` · Scaling/degradation: `SCALING.md`
