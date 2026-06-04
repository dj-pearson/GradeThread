# Uptime Monitoring, Alerting & Status Page (US-500)

Outages must page us and be visible to customers, so we find out before users do.

## Synthetic monitors

Configure external uptime checks (e.g. UptimeRobot, Better Stack, Pingdom, or
Cloudflare Health Checks) against:

| Target | URL | Expect | Interval |
|---|---|---|---|
| SPA | `https://gradethread.com/` | 200, body contains the hero text | 1 min |
| Edge liveness | `https://functions.gradethread.com/health` | 200, JSON `status:ok` | 1 min |
| Edge readiness | `https://functions.gradethread.com/health/ready` | 200 (503 = degraded) | 1 min |
| Supabase | `https://api.gradethread.com/auth/v1/health` | 200 | 1 min |

`/health/ready` already probes the DB + critical env and returns 503 when a hard
dependency is down — point the readiness monitor at it so a DB outage pages even
while the process is "up".

## Alerting → on-call

- Route monitor alerts to a **real on-call channel** (PagerDuty/Opsgenie or a
  Slack channel with notifications), not just email.
- The edge app's own alarms (grading regression, stuck submissions, fail-open
  webhooks, breaker trips) flow through the error tracker (Sentry, `SENTRY_DSN`)
  and `MONITOR_ALERT_WEBHOOK` — wire both into the same on-call channel.
- Thresholds + escalation are defined in `INCIDENT_RESPONSE.md`.

## Status page

Stand up a public status page (Better Stack / Instatus / a static Cloudflare
Pages site) reflecting: SPA, Edge API, Grading, Payments, Database. Drive it from
the synthetic monitors above.

> **MANUAL / LAUNCH-BLOCKER:** create the monitors, connect them to the on-call
> channel, and publish the status page URL. Record the chosen vendor + the status
> page URL here once live.

## Verification

After setup: force a failure (stop the edge container briefly in staging) and
confirm an alert reaches the on-call channel and the status page flips the
component to "down".
