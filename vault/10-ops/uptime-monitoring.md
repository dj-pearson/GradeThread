---
title: Uptime monitoring
type: runbook
status: current
source_of_truth: vault
code_refs:
  - scripts/ops/uptime-cadence.mjs
  - scripts/ops/uptime-check.mjs
reviewed: 2026-08-22
tags: [ops, monitoring, alerting]
summary: The external checks, what they probe and where they alert.
---
# Uptime Monitoring, Alerting & Status Page (US-500)

Outages must page us and be visible to customers, so we find out before users
do. All three pieces are implemented in-repo:

## 1. External synthetic monitor — `.github/workflows/uptime.yml`

Runs `scripts/ops/uptime-check.mjs` every 10 minutes from GitHub-hosted
runners, which are **external to all production infrastructure** (Cloudflare
Pages, Coolify, self-hosted Supabase) — a total prod outage is still detected.

| Target | URL | Expect |
|---|---|---|
| SPA | `https://gradethread.com/` | 200 |
| Edge liveness | `https://functions.gradethread.com/health` | 200 |
| Edge readiness (DB) | `https://functions.gradethread.com/health/ready` | 200 (503 = DB/env down) |
| Supabase Auth | `https://api.gradethread.com/auth/v1/health` | 200 with anon key (non-5xx without) |

A failure is confirmed by a second check 30s later before alerting (no paging
on a single blip). On confirmed failure the run exits non-zero and alerts via:

- **`UPTIME_ALERT_WEBHOOK`** (repo Actions secret) — Slack-compatible webhook;
  point it at the same on-call channel as the edge service's
  `MONITOR_ALERT_WEBHOOK` so all alerts converge.
- **GitHub issue labeled `uptime`** — always-on fallback that needs zero
  secrets: opened on failure, commented while ongoing, auto-closed on
  recovery. Repo watchers get email/mobile notifications.

Manual run / drill: GitHub → Actions → **Uptime** → *Run workflow*.

> [!warning] Measured 2026-08-22: the cadence is ~17 minutes, not 10, and that
> breaks the SEV1 ack target
> This paragraph used to say GitHub cron is best-effort and "a run can start a
> few minutes late". Over **99 consecutive scheduled runs** (2026-08-21 to
> 2026-08-22) exactly **one** landed within 10 minutes of the previous one:
>
> | | interval |
> |---|---|
> | min | 9.8 min |
> | median | 17.2 min |
> | p90 | 24.4 min |
> | max | 43.0 min |
>
> Detection latency is a full interval of blindness plus the 30s confirm delay
> plus the run itself, so it is **~18 min at the median** against the **15-minute
> SEV1 ack target** in [[incident-response]]. The alert typically arrives after
> the deadline it feeds — not occasionally, typically.
>
> The 10-minute cadence stays as the launch baseline. What is no longer true is
> that it MEETS the target. Either the target moves or the vendor check below
> gets added; leaving both claims standing is the thing to avoid.
>
> **Re-measure rather than trusting these numbers** — GitHub's scheduler load
> moves: `node scripts/ops/uptime-cadence.mjs` (read-only, one `gh run list`).
> It exits non-zero while the target is unmet.

## 2. Status page — `gradethread.com/status`

`src/pages/status.tsx` (route `/status`, linked from the site footers) probes
Edge liveness, Edge readiness (database) and Supabase Auth **live from the
visitor's browser**, refreshing every 60s. Because checks are client-side, the
page stays accurate during an edge/Supabase outage with no manual updates —
its only shared dependency is Cloudflare Pages serving the SPA itself.

## 3. Thresholds, escalation & on-call

Defined in `vault/10-ops/incident-response.md` →
"Availability monitoring, thresholds & escalation": monitor inventory,
2-consecutive-failures threshold, severity mapping (SEV-1 = SPA/edge/DB down),
escalation ladder and the end-to-end alert drill.

## Remaining setup (launch checklist)

> [!todo] **MANUAL:** in GitHub repo settings → Secrets and variables → Actions, set
> `UPTIME_ALERT_WEBHOOK` (Slack incoming webhook for the on-call channel) and
> `SUPABASE_ANON_KEY` (lets the auth check assert a real 200 from GoTrue).
> Everyone on call must watch the repo with issue notifications on. Then run
> the failure drill in `vault/10-ops/incident-response.md` and tick it off in
> `vault/10-ops/launch-checklist.md`.

## Optional upgrade: 1-minute vendor checks + hosted status page

For tighter detection than GitHub's 10-minute best-effort cron, add a vendor
(Better Stack / UptimeRobot / Cloudflare Health Checks) pointing at the same
four URLs with the same expectations, alerting into the same channel, and
optionally a vendor-hosted status page (independent of Cloudflare Pages).
Record the vendor + status page URL here once live. The in-repo monitor stays
on as the zero-cost backstop.

## Related

- [[incident-response]] — where an alert escalates to
- [[launch-checklist]] — these checks must be live before launch
- [[moc-ops]]
