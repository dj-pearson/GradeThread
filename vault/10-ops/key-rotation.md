---
title: Key and secret rotation
aliases: [KEY_ROTATION, secret rotation, rotate secrets]
type: runbook
status: current
source_of_truth: vault
code_refs:
  - services/edge-functions/src/lib/crypto-aes.ts
reviewed: 2026-08-01
tags: [ops, security, secrets, rotation]
summary: How to rotate every secret the platform holds, including the keyed dual-key path for marketplace token encryption.
---
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
| `BACKUP_AGE_RECIPIENT` / `BACKUP_AGE_IDENTITY` | DB host (public half) / Infisical `prod` (private half) | **Special** — 1y / on leak | Backup encryption (US-2416). Rotating is safe; **losing the identity destroys every backup encrypted under it.** See below. |
| rclone `crypt` remote password + salt | DB host rclone config | On leak | Storage mirror encryption. Rotating means the existing mirror cannot be read — see below. |

### EDGE_ENCRYPTION_KEY rotation (token re-encryption)

eBay tokens are AES-GCM encrypted with this key (AAD-bound to user_id). To
rotate: support a primary + previous key, decrypt-with-old / re-encrypt-with-new
on next token use (the refresh path already rewrites the ciphertext), then drop
the old key after all active connections have refreshed (≤ token TTL).

> [!todo] **MANUAL:** implement the dual-key read path in `crypto-aes.ts` before the
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

> [!todo] **MANUAL:** review the repo's GitHub → Settings → Secrets list against this
> table quarterly; remove any unused secret.

## Ads Command Center — Google Ads & Apple Search Ads (US-1709)

Both integrations no-op when unset, so rotation is safe: unset the secret →
redeploy → the sync/apply cleanly skip until the new secret is in place.

### Google Ads (`GOOGLE_ADS_*`)
1. **Developer token** — regenerate in Google Ads → API Center (manager account).
   A new token starts at *Test* access (test accounts only) until Basic Access is
   re-approved — do NOT enable live apply until Basic Access is granted.
2. **OAuth client id/secret** — Google Cloud Console → Credentials → rotate the
   OAuth 2.0 client; update `GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET`.
3. **Refresh token** — re-run the offline-access consent flow for a user with Ads
   access; update `GOOGLE_ADS_REFRESH_TOKEN`. (An `invalid_grant` at runtime means
   the refresh token was revoked — re-consent.)
4. Update the values in **Coolify → Team Shared Variables**, redeploy the edge.

### Apple Search Ads (`APPLE_SEARCH_ADS_*`)
1. **`.p8` private key** — Search Ads UI → API certificates → create a new key,
   download the `.p8` ONCE. Update `APPLE_SEARCH_ADS_PRIVATE_KEY` (PEM, `\n`-escaped
   or literal) + `APPLE_SEARCH_ADS_KEY_ID`.
2. **Client id / team id** — rotate in the Search Ads API credentials if
   compromised; update `APPLE_SEARCH_ADS_CLIENT_ID` / `_TEAM_ID`.
3. The client secret is a short-lived ES256 JWT minted per token exchange — no
   separate rotation; rotating the `.p8` key rotates it implicitly.
4. Update **Coolify → Team Shared Variables**, redeploy the edge.

**Blast radius:** rotation only affects the Ads Command Center (sync/analysis/
apply); no user-facing feature depends on these secrets.

---

## ⚠️ Correction — `EDGE_ENCRYPTION_KEY` rotation (verified 2026-07-19)

**Both previous runbooks were wrong, in opposite directions, and either would
have caused an incident.** The authority is `crypto-aes.ts` (US-352), whose own
header documents the real procedure.

| Source | Claimed | Reality |
|---|---|---|
| `KEY_ROTATION.md` (root) | "**MANUAL:** implement the dual-key read path in `crypto-aes.ts` before the first rotation, or schedule a maintenance window and force-reconnect eBay accounts" | The dual-key path **already exists**. Following this meant an unnecessary outage and mass reconnection. |
| `docs/KEY_ROTATION.md` | Ship a transitional build; set `EDGE_ENCRYPTION_KEY_OLD` | `EDGE_ENCRYPTION_KEY_OLD` **does not exist anywhere in the codebase.** The real variable is `EDGE_ENCRYPTION_KEYS_OLD` (plural, `id:base64key` pairs). Setting the singular name is a silent no-op — old rows fail to decrypt and **every marketplace connection breaks mid-rotation**. |

### The actual procedure

Stored formats: `v2:<keyId>:<iv>:<ct>` (current, AAD-bound to `user_id`) and
`v1:<iv>:<ct>` (legacy, decrypt-only). No transitional build is needed — v2 and
the retired-key read path are already shipped.

| Variable | Meaning |
|---|---|
| `EDGE_ENCRYPTION_KEY` | base64 of 32 random bytes — the **active** key |
| `EDGE_ENCRYPTION_KEY_ID` | short label for the active key, default `k1` |
| `EDGE_ENCRYPTION_KEYS_OLD` | comma-separated `id:base64key` pairs of retired keys, kept **only** to decrypt not-yet-rotated rows |

1. Generate a new key: `openssl rand -base64 32`.
2. Move the current key into `EDGE_ENCRYPTION_KEYS_OLD` as `<oldId>:<oldB64>`;
   set `EDGE_ENCRYPTION_KEY=<newB64>` and `EDGE_ENCRYPTION_KEY_ID=<newId>`.
3. Deploy. New writes use the new key; old rows still decrypt via the retired
   set. The eBay refresh path re-encrypts on every refresh so rows migrate
   naturally — run a one-off decrypt→encrypt backfill to rotate the rest now.
4. Once no row references the old id, remove it from `EDGE_ENCRYPTION_KEYS_OLD`.

No maintenance window. No forced reconnection. No code change.

---

## Absorbed from `docs/KEY_ROTATION.md` (US-2049)

The per-key catalogue below came from `docs/KEY_ROTATION.md`, which covered
*which* secrets exist and how to roll each, while this file covered the
zero-downtime mechanics and the CI inventory. Its `EDGE_ENCRYPTION_KEY` section
is deliberately **omitted** — superseded by the verified procedure above.

How to rotate every secret the platform depends on. Rotate immediately if a key
is ever exposed (committed to git, pasted in a ticket, logged, leaked by a
vendor). The secret-scan CI (`.github/workflows/secret-scan.yml`) and the
pre-commit hook (`.githooks/pre-commit`) exist to prevent exposure in the first
place.

All server-side secrets live as **Coolify environment variables** on the
`gradethread-edge-functions` service unless noted. After changing any of them in
Coolify, **redeploy** so the container picks up the new value.

---

## `SUPABASE_SERVICE_ROLE_KEY` (full DB access, bypasses RLS)

Highest-blast-radius secret. Rotate via Supabase → Settings → API → "Reset" the
`service_role` key. Update `SUPABASE_SERVICE_ROLE_KEY` in Coolify and redeploy.
Note: rotating the JWT secret invalidates the anon key too (see below).

## Supabase anon key (`VITE_SUPABASE_ANON_KEY`)

Public by design (shipped in the frontend bundle) — low severity if exposed.
Only needs rotation if the underlying JWT secret is reset. After a reset,
rebuild + redeploy the Cloudflare Pages frontend with the new anon key.

## `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`

- Secret key: Stripe Dashboard → Developers → API keys → roll the key. Update
  Coolify, redeploy. Watch for in-flight requests during the brief overlap.
- Webhook secret: Stripe Dashboard → Webhooks → the endpoint → roll signing
  secret. Update `STRIPE_WEBHOOK_SECRET`, redeploy.

## `ANTHROPIC_API_KEY`

Anthropic Console → API keys → create new, update Coolify, redeploy, then revoke
the old key.

## eBay (`EBAY_CERT_ID`, `EBAY_VERIFICATION_TOKEN`) + other vendor keys

- `EBAY_CERT_ID`: regenerate in the eBay Developer portal; update + redeploy.
- `EBAY_VERIFICATION_TOKEN`: pick a new random string, update Coolify, then
  re-register it in eBay's Notification settings.
- `RESEND_API_KEY`, `OPENAI_API_KEY`, `REMOVE_BG_API_KEY`, `CLOUDFLARE_API_TOKEN`,
  R2 keys: regenerate in the respective vendor console, update Coolify, redeploy,
  revoke old.

## Shared job secrets (`FLIPDESK_INTERNAL_JOB_SECRET`, `CONTENT_INTERNAL_JOB_SECRET`, `CONTENT_WEBHOOK_SIGNING_SECRET`)

`openssl rand -hex 32` for a new value.

`FLIPDESK_INTERNAL_JOB_SECRET` and `CONTENT_INTERNAL_JOB_SECRET` support
**zero-downtime overlap rotation** via a matching `*_OLD` env var (US-360 /
US-487):

1. Set the new value as the primary env var in Coolify.
2. Move the previous value to `FLIPDESK_INTERNAL_JOB_SECRET_OLD` /
   `CONTENT_INTERNAL_JOB_SECRET_OLD` and redeploy — callers configured with
   either value keep working.
3. Update the caller (Make.com scenario / cron job) to the new secret.
4. Clear the `*_OLD` var and redeploy.

`CONTENT_WEBHOOK_SIGNING_SECRET` has no overlap var: update Coolify **and** the
downstream Make.com verifier at the same time, then redeploy.

The content scheduler also accepts a **signed timestamped request** instead of
the raw secret — `X-Internal-Job-Timestamp: <unix seconds>` plus
`X-Internal-Job-Signature: hex(HMAC-SHA256(secret, "v1:<ts>:<METHOD>:<path>"))`
(5-minute freshness window, single-use signatures, so replays are rejected).
Prefer this for new callers: the secret never leaves the caller.

---

## `extension.pem` — US-2284: leaked, and there is nothing to rotate

**This key WAS leaked.** Committed 2026-07-13 (`e1dbc4da`), untracked
2026-08-01, still in git history. Untracking does not un-leak it — anyone who
cloned in that window holds it.

> [!warning] This section used to say "generate a new signing key in the Chrome
> Web Store developer dashboard". **That control does not exist**, and the
> instruction cost the owner an evening looking for it. It is the reason
> [[priority-5-operator-queue]] now opens with a warning that an `OPERATOR:`
> criterion is not automatically correct.

`extension.pem` is produced **locally**, by Chrome's *Pack extension* button. It
signs a self-hosted `.crx` and derives an extension id from its public key. A
ZIP uploaded to the Web Store is signed with **Google's** key and given a Web
Store item id, so the local pem never enters the publish path — which is why the
dashboard has no rotation control for it. `scripts/package-extensions.mjs` ships
a plain `.zip` and never touches a pem.

### Why the leak is inert

Three things would each have made it serious. All three are negative — first
checked 2026-08-21, re-checked 2026-08-24:

| check | result |
|---|---|
| a `"key"` field in any manifest | none in `extension/`, `extension-condition/` or `extension-unified/`, so no shipping extension id derives from that keypair |
| an `update_url` in any manifest | none, so there is no self-hosted update channel a `.crx` signed with it could be pushed through |
| a pem in the packaging path | none — `package-extensions.mjs` emits a store ZIP |

**If any of those three stops being true, this key becomes live again.**

### Resolution: burned, not rotated, and no history rewrite

- Never pack with it again; delete any local copy so a future *Pack extension*
  cannot pick it up.
- **No history rewrite.** A BFG / `git-filter-repo` pass rewrites every open PR
  and invalidates every existing clone, to scrub a key that authorises nothing.
- The finding is allowlisted in `.gitleaks.toml`, scoped to that one commit
  **and** that one path, so re-committing a pem today still fails the scan. The
  full reasoning lives in the comment above the stanza.

**At publish time (US-1757):** let the Web Store assign the item id and do NOT
add a `key` field to the manifest. Adding one pins the published id to a locally
held keypair and recreates this exposure, for real.

The durable half was always the code half: file untracked, `*.pem` / `*.crx` /
`*.p12` / `*.keystore` / `*.jks` gitignored, and a weekly full-history sweep.

### Why the scan did not catch it for weeks

`secret-scan.yml` runs gitleaks in push/PR mode, which scans the commits in the
triggering event. Once a secret lands, every later run is green while the secret
sits in history. `secret-scan-history.yml` exists to ask the other question —
"is the repository clean?" rather than "is this change clean?" — and only that
one finds a leak nobody noticed landing.

## Backup encryption key (`BACKUP_AGE_*`) — US-2416

Backups leave the host encrypted with `age` under a **public** recipient, so the
DB host can encrypt but never decrypt. Full context in [[backups]].

**The asymmetry that makes this different from every other row in the table:**
rotating is cheap and nearly instant, but *losing* the identity is unrecoverable
and silent. Nothing breaks when the identity is lost. Backups keep running,
`/health` stays green, the bucket keeps filling. You find out at the only moment
it matters. So the check below is not paperwork.

### Rotation

1. `age-keygen -o new-identity.txt` on a trusted machine (not the DB host).
2. Store the new identity in Infisical `prod` as `BACKUP_AGE_IDENTITY`, **and**
   in the second offline home. Keep the OLD identity in both — see the window
   note below.
3. Change `BACKUP_AGE_RECIPIENT` in `/etc/cron.d/gradethread-backups` to the new
   public key. No redeploy, no restart; the next nightly picks it up.
4. Run one backup by hand and restore it into a scratch container with the NEW
   identity before walking away. An untested new key is the same failure as a
   lost one, delayed.

### The window nobody plans for

Offsite retention is **30 days**. For 30 days after a rotation the bucket holds
ciphertext under **both** keys, and the old objects are the older, more valuable
half of the recovery range.

> [!danger] Do not delete the old identity for at least 30 days after rotating
> Deleting it on rotation day silently destroys every backup older than that
> day's, which is most of the recovery window. Keep both identities until the
> R2 lifecycle rule has aged out the last object written under the old one, then
> delete the old identity and record the date here.
>
> `restore-postgres.sh` takes whichever identity you point `BACKUP_AGE_IDENTITY`
> at, so restoring an old object during the window just means using the old key.
> There is no dual-key read path and none is needed — unlike
> `EDGE_ENCRYPTION_KEY` above, nothing decrypts these automatically.

### Storage mirror (rclone crypt)

Rotating the crypt password or salt makes the **existing** mirror unreadable —
rclone will also treat every object as new and re-upload the whole volume. Treat
it as a re-seed, not a rotation: stand up a second crypt remote, sync fresh,
verify a sample decrypts, then retire the old prefix once its lifecycle window
has passed.

## After any rotation

- Confirm `/health` is green and run a smoke test of the affected flow.
- If the key was exposed, note it in the incident log (see
  `vault/10-ops/incident-response.md`, US-278).

## Related

- [[incident-response]] — a suspected key compromise is a SEV; start there
- [[data-retention]] — rotation and retention both touch stored user data
- [[env-reference]] — where each secret is set, per deployment surface
- [[runbook-copies]] — why the in-app copy of these procedures also needs updating
- [[INDEX]]
