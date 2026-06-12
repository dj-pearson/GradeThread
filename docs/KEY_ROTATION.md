# Key & Secret Rotation Runbook

How to rotate every secret the platform depends on. Rotate immediately if a key
is ever exposed (committed to git, pasted in a ticket, logged, leaked by a
vendor). The secret-scan CI (`.github/workflows/secret-scan.yml`) and the
pre-commit hook (`.githooks/pre-commit`) exist to prevent exposure in the first
place.

All server-side secrets live as **Coolify environment variables** on the
`gradethread-edge-functions` service unless noted. After changing any of them in
Coolify, **redeploy** so the container picks up the new value.

---

## `EDGE_ENCRYPTION_KEY` (AES-256-GCM, marketplace OAuth tokens)

This key encrypts `marketplace_connections.access_token_encrypted` /
`refresh_token_encrypted` (see `services/edge-functions/src/lib/crypto-aes.ts`).
Stored values are tagged with a version prefix: `v1:<iv>:<ciphertext>`.

Rotating it is **not** a simple swap — existing rows were encrypted with the old
key and must be re-encrypted, or every marketplace connection breaks.

**Procedure (zero-downtime, dual-key):**

1. Generate the new key: `openssl rand -base64 32`.
2. Ship a transitional build of `crypto-aes.ts` that:
   - encrypts with the **new** key under a new `v2:` prefix, and
   - on decrypt, selects the key by prefix: `v2:` → new key, `v1:` → old key
     (read from a temporary `EDGE_ENCRYPTION_KEY_OLD` env var).
3. Set `EDGE_ENCRYPTION_KEY` = new key and `EDGE_ENCRYPTION_KEY_OLD` = old key in
   Coolify; redeploy.
4. Run a one-off re-encrypt script: for every `marketplace_connections` row,
   `decryptToken()` (auto-picks old/new by prefix) then `encryptToken()` (writes
   `v2:`). Idempotent — safe to re-run.
5. Once all rows are `v2:`, remove `EDGE_ENCRYPTION_KEY_OLD` and the `v1:`
   decrypt branch; redeploy.

If you must rotate in an emergency and can accept breakage: set the new key and
have every user re-connect their marketplace (the OAuth flow re-issues tokens).

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

## After any rotation

- Confirm `/health` is green and run a smoke test of the affected flow.
- If the key was exposed, note it in the incident log (see
  `docs/INCIDENT_RESPONSE.md`, US-278).
