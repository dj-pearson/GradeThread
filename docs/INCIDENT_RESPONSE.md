# Incident Response Runbook

Internal playbook for handling a suspected or confirmed security incident
(breach, leaked secret, account compromise, data exposure) on GradeThread.

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

## Quarterly security review checklist

- [ ] `npm audit` + Deno deps reviewed; high/critical advisories resolved.
- [ ] gitleaks history scan clean; pre-commit hook active for the team.
- [ ] Admin/super_admin user list reviewed; stale access removed; MFA enrolled.
- [ ] RLS + tenant-isolation regression tests pass.
- [ ] Webhook signature secrets + `EDGE_ENCRYPTION_KEY` rotation cadence on track.
- [ ] Supabase auth policy (HIBP, password strength, lockout) still enabled.
- [ ] CSP / security headers still present and scoped correctly.
