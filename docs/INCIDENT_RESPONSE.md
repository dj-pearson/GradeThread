# Incident Response Runbook

Internal playbook for handling a suspected or confirmed security incident
(breach, leaked secret, account compromise, data exposure) on GradeThread.
Availability incidents (outages) are covered in
[Availability monitoring, thresholds & escalation](#availability-monitoring-thresholds--escalation).

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

Escalation ladder (15 min per unacknowledged step for SEV-1):
1. On-call (Slack channel mention / GitHub issue assignee).
2. Pearson Media leadership (phone — see private contact sheet).
3. If user data may be affected, switch to the security flow above.

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
