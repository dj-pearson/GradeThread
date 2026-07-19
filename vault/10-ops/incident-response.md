---
title: Incident response and on-call
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [ops, incident, oncall]
summary: Per-scenario engineering runbooks plus the SEV process, notification chain and monitoring thresholds.
---
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
3. If it's a cert/app-cred issue → rotate per `vault/10-ops/key-rotation.md`; permanent
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
  `vault/10-ops/key-rotation.md` · Scaling/degradation: `SCALING.md` · Security incidents +
  alert thresholds/drill: `docs/INCIDENT_RESPONSE.md`

---

## Absorbed from `docs/INCIDENT_RESPONSE.md` (US-2049)

The two copies were complementary, not duplicated. This file held the
**per-scenario engineering runbooks** (database outage, edge crash-loop, webhook
backlog, stranded grades, eBay token refresh, cost spike, bad deploy). The
`docs/` copy held the **incident process**: the first 60 minutes, the
notification chain, emergency contacts, monitoring thresholds and escalation,
and the quarterly security review. Both are needed and neither referenced the
other, so an operator reading one had no idea the other existed.

Internal playbook for handling a suspected or confirmed security incident
(breach, leaked secret, account compromise, data exposure) on GradeThread.
Availability incidents (outages) are covered in
[Availability monitoring, thresholds & escalation](#availability-monitoring-thresholds--escalation);
the **per-scenario recovery runbooks** (DB outage + restore, edge crash-loop,
webhook backlog, stuck submissions, eBay token mass-refresh failure) and the
**on-call roster** live in the repo-root
[INCIDENT_RESPONSE.md](../INCIDENT_RESPONSE.md) (US-506).

## Severity levels

| Sev | Definition | Examples | Response |
|---|---|---|---|
| **SEV-1** | Active breach or data exposure affecting users | Service-role key leaked, cross-tenant data access in prod, DB exfiltration | Drop everything; rotate immediately; notify leadership now |
| **SEV-2** | Exploitable vulnerability, no confirmed exploitation | Auth bypass found, exposed admin endpoint, valid secret in a public commit | Patch + rotate within 24h |
| **SEV-3** | Hardening gap, low/no immediate risk | Missing header, weak rate limit, dependency advisory | Schedule into the next work cycle |

## First 60 minutes (SEV-1 / SEV-2)

1. **Assign an incident lead.** One person coordinates; others execute.
2. **Contain.** Stop the bleeding before investigating:
   - Leaked secret → rotate it now ([KEY_ROTATION.md](KEY_ROTATION.md)).
   - Compromised user/admin account → force sign-out (invalidate sessions in
     Supabase), reset password, revoke MFA, demote role if needed.
   - Active exploit of an endpoint → disable/patch the route or take the edge
     service offline at Coolify if necessary.
3. **Preserve evidence.** Snapshot relevant logs (Coolify edge logs, Supabase
   logs, Cloudflare, Stripe events) before they roll off. Note timestamps.
4. **Assess blast radius.** Which users/tables/tokens were reachable? Was data
   actually accessed or only exposed?

## Containment specifics

- **Rotate keys:** follow [KEY_ROTATION.md](KEY_ROTATION.md). For a service-role
  or JWT-secret compromise, treat ALL derived tokens as burned.
- **Mass-revoke marketplace tokens:** if eBay/marketplace OAuth tokens may be
  compromised, in `marketplace_connections` set `is_active=false` and null the
  `access_token_encrypted` / `refresh_token_encrypted` columns for affected
  users (or all users for a SEV-1), then require re-connect. Rotating
  `EDGE_ENCRYPTION_KEY` alone does NOT invalidate the underlying eBay tokens —
  revoke at the source.
- **Stripe:** roll API + webhook signing keys; review recent events for fraud.
- **Sessions:** invalidate Supabase sessions; consider lowering `jwt_expiry`
  temporarily.

## Notification chain

1. Incident lead → Pearson Media leadership (immediately for SEV-1).
2. If user data was accessed: prepare user notification and assess legal /
   regulatory obligations (GDPR/CCPA breach-notification timelines).
3. Update the reporter (if externally reported) per [SECURITY.md](../SECURITY.md).

## Emergency contacts / consoles

- **Supabase** (self-hosted): Coolify dashboard + DB access.
- **Stripe:** Dashboard → Developers (keys, events, radar).
- **Cloudflare:** Pages + DNS + WAF for the domains.
- **eBay Developer:** app credentials + notification config.
- **Anthropic / OpenAI / Resend / remove.bg:** respective consoles for key rotation.

## After the incident

- Write a blameless post-mortem: timeline, root cause, blast radius, what
  contained it, and follow-up actions (link the PRs).
- File hardening follow-ups as user stories (the US-263→US-278 security set).
- Log any key exposure + rotation in the post-mortem.

## Availability monitoring, thresholds & escalation

US-500. What watches what, when it pages, and who responds.

### Monitor inventory

| Monitor | Source | Targets | Cadence |
|---|---|---|---|
| Synthetic uptime | `.github/workflows/uptime.yml` → `scripts/ops/uptime-check.mjs` (GitHub-hosted runners — external to all prod infra) | SPA `/`, edge `/health`, edge `/health/ready` (DB), Supabase `/auth/v1/health` | every 10 min |
| Public status page | `gradethread.com/status` — probes the same components live from the visitor's browser | edge liveness/readiness, Supabase Auth | on view + every 60s |
| In-app alarms | Edge service crons (grading monitor, stuck submissions, webhook dead-letter, integrity scan) → `MONITOR_ALERT_*` + Sentry | application-level health | per-cron schedule |

### Alert thresholds

- **Synthetic check:** one failed probe (10s timeout) is re-checked once after
  30s. **2 consecutive failures = confirmed outage** → alert fires. A single
  blip never pages.
- **Edge readiness 503** (`/health/ready`): the database or critical env is
  down even though the process is up — treat as an outage of the database
  component, not the edge process.
- **Flapping:** while an outage issue is open, subsequent failing runs comment
  on it (no new issue per run); recovery auto-closes it. Re-opened within
  24h twice → treat as SEV-2 instability even if each blip self-recovers.

### Alert channels

1. `UPTIME_ALERT_WEBHOOK` (GitHub Actions secret) → Slack-compatible on-call
   channel. Point it at the SAME destination as the edge service's
   `MONITOR_ALERT_WEBHOOK` so all alerts land in one place.
2. GitHub issue labeled `uptime` — always-on fallback (zero config): notifies
   repo watchers by email/mobile push. **Everyone on call must watch the repo
   with issue notifications enabled.**

### Severity & escalation

| Sev | Condition | Response time | Action |
|---|---|---|---|
| **SEV-1** | SPA or edge API confirmed down, or DB unreachable (`edge_ready` failing) | 15 min ack | Page incident lead now; restore service first (Coolify restart / Cloudflare rollback per `ROLLBACK.md`), diagnose second |
| **SEV-2** | Single non-critical component degraded (auth health flapping, readiness intermittently 503) or repeated self-recovering blips | 1 h ack | Investigate same day; check Coolify resource limits, Supabase logs |
| **SEV-3** | Latency elevated but all checks passing; monitor itself failing (Actions outage) | next business day | Schedule into the work cycle |

Escalation ladder (15 min per unacknowledged step for SEV-1; the on-call
roster + contact channels are defined in the repo-root
[INCIDENT_RESPONSE.md](../INCIDENT_RESPONSE.md) → "On-call & escalation"):
1. On-call (Slack channel mention / GitHub issue assignee).
2. Pearson Media leadership (phone — see private contact sheet).
3. If user data may be affected, switch to the security flow above.

Recovery procedures per failure mode (DB outage + restore via `BACKUPS.md`,
edge crash-loop, webhook backlog/dead-letter, stuck submissions, eBay token
mass-refresh failure) are the per-scenario runbooks in the repo-root
[INCIDENT_RESPONSE.md](../INCIDENT_RESPONSE.md).

During any SEV-1/SEV-2: confirm `gradethread.com/status` reflects the outage
(it probes components from the visitor's browser, so it stays accurate without
manual updates), and post user-facing notes there/socials if the outage
exceeds 30 min.

### Verifying the pipeline works

- Run the workflow manually: GitHub → Actions → "Uptime" → *Run workflow*.
- Force a failure end-to-end (staging/maintenance window): stop the edge
  container in Coolify, dispatch the workflow, confirm the webhook message
  arrives and an `uptime` issue opens; restart, re-dispatch, confirm the issue
  closes. Log the drill date in `LAUNCH_CHECKLIST.md`.

## Quarterly security review checklist

- [ ] `npm audit` + Deno deps reviewed; high/critical advisories resolved.
- [ ] gitleaks history scan clean; pre-commit hook active for the team.
- [ ] Admin/super_admin user list reviewed; stale access removed; MFA enrolled.
- [ ] RLS + tenant-isolation regression tests pass.
- [ ] Webhook signature secrets + `EDGE_ENCRYPTION_KEY` rotation cadence on track.
- [ ] Supabase auth policy (HIBP, password strength, lockout) still enabled.
- [ ] CSP / security headers still present and scoped correctly.

## Related

- [[key-rotation]] — a credential incident ends in rotation; use the verified procedure
- [[data-retention]] — a data-exposure incident has erasure/notification obligations
- [[dns-and-routing]] — "the API is down" is often the wrong host
- [[runbook-copies]] — the in-app runbooks operators actually read
- [[INDEX]]
