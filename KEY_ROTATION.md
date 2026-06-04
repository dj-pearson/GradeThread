# Secrets Management & Rotation (US-505) + CI Secret Inventory (US-522)

All long-lived secrets must be rotatable on a documented cadence so a leak is
recoverable without downtime.

## FLIPDESK_INTERNAL_JOB_SECRET — zero-downtime rotation

This shared secret authenticates every `/api/jobs/*` cron. `verifyJobSecret`
(lib/job-auth.ts) already supports a **dual-secret overlap window**: it accepts
both `FLIPDESK_INTERNAL_JOB_SECRET` (primary) and
`FLIPDESK_INTERNAL_JOB_SECRET_OLD` (previous), so rotation never breaks an
in-flight scheduler.

1. Generate a new secret: `openssl rand -hex 32`.
2. Set `FLIPDESK_INTERNAL_JOB_SECRET_OLD` = current value (on the edge resource).
3. Set `FLIPDESK_INTERNAL_JOB_SECRET` = the new value; redeploy.
4. Update every Coolify Scheduled Task command to the new value (`COOLIFY.md`).
5. Once all crons use the new value (verify via task logs), remove
   `FLIPDESK_INTERNAL_JOB_SECRET_OLD`.

**Cadence:** every 90 days, or immediately on suspected leak.

## Provider keys

| Secret | Where | Rotation | Notes |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | edge | On leak / 1y | Roll in Stripe dashboard; update env; redeploy. |
| `STRIPE_WEBHOOK_SECRET` | edge | On endpoint change | Stripe lets you have multiple signing secrets during cutover. |
| `ANTHROPIC_API_KEY` | edge | 90d / on leak | Create new key, swap env, revoke old. |
| eBay `EBAY_CERT_ID` / app creds | edge | Per eBay policy | Re-consent not required for cert rotation; token refresh continues. |
| `EDGE_ENCRYPTION_KEY` (AES-GCM) | edge | **Special** | Rotating this requires re-encrypting stored tokens — see below. |
| `SUPABASE_SERVICE_ROLE_KEY` | edge | On leak | Rotate the JWT secret in Supabase; re-issue; update env. High blast radius — coordinate. |
| `SENTRY_DSN`, `POSTHOG_KEY` | both | As needed | Public-ish; low urgency. |
| `UNSUBSCRIBE_SECRET` | edge | On leak | Rotating invalidates outstanding unsubscribe links (acceptable). |

### EDGE_ENCRYPTION_KEY rotation (token re-encryption)

eBay tokens are AES-GCM encrypted with this key (AAD-bound to user_id). To
rotate: support a primary + previous key, decrypt-with-old / re-encrypt-with-new
on next token use (the refresh path already rewrites the ciphertext), then drop
the old key after all active connections have refreshed (≤ token TTL).

> **MANUAL:** implement the dual-key read path in `crypto-aes.ts` before the
> first EDGE_ENCRYPTION_KEY rotation, or schedule rotation during a maintenance
> window and force-reconnect eBay accounts.

## In-flight cron safety

Rotation must not break a running cron: the dual-secret window above covers the
job secret; provider-key swaps take effect on the next call (a cron mid-flight
finishes on the old key, the next tick uses the new one). Verified by rotating
in staging first.

## CI secret inventory (US-522)

| Secret (GitHub Actions) | Used by | Rotation |
|---|---|---|
| `APP_STORE_CONNECT_*` / signing certs | `ios-release.yml` | Per Apple cert expiry |
| Any deploy/registry tokens | deploy workflows | 90d |
| `GITHUB_TOKEN` | all (auto) | Per-run, ephemeral; workflows pinned to least privilege (`contents: read`) — US-522 |

- Secret scanning: `secret-scan.yml` (gitleaks) is the **hard CI gate**; the
  local `.githooks` gitleaks hook is best-effort only.
- Branch protection (once re-enabled post-sprint) must require the secret-scan +
  security jobs as status checks.

> **MANUAL:** review the repo's GitHub → Settings → Secrets list against this
> table quarterly; remove any unused secret.
