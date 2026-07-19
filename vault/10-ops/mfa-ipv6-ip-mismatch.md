---
title: MFA IPv6 address mismatch
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [ops, security, mfa, incident]
summary: Why admin writes 403 under IPv6 and the Kong XFF normalisation fix.
---
# Runbook — MFA "Challenge and verify IP addresses mismatch" (IPv6)

**Symptom.** Enrolling in 2FA, verifying a TOTP code, or doing an admin **step-up**
fails with GoTrue returning HTTP **422** `{ code: "mfa_ip_address_mismatch",
message: "Challenge and verify IP addresses mismatch." }` on
`POST /auth/v1/factors/:id/verify`.

**Downstream symptom.** Admin actions that require a fresh step-up
(`POST /api/admin/grading/review/:id/approve`, `/adjust`, role changes, refunds,
prompt activation, account deletion) return **403 `STEP_UP_REQUIRED`** and never
succeed, because the step-up MFA verify above can't complete. GET admin routes
still return 200 (they don't require step-up) — that asymmetry is the tell.

## Root cause

GoTrue (self-hosted, `api.gradethread.com` → Kong) binds every MFA **challenge**
to the client IP that created it and rejects the **verify** when the verifying
request egresses from a **different** IP:

```go
// supabase/auth internal/api/mfa.go — validateChallenge / verifyPhoneFactor
currentIP := utilities.GetIPAddress(r)          // FIRST entry of X-Forwarded-For
if challenge.VerifiedAt != nil || challenge.IPAddress != currentIP {
    return ...ErrorCodeMFAIPAddressMismatch, "Challenge and verify IP addresses mismatch."
}
```

`GetIPAddress` takes the **first (leftmost)** `X-Forwarded-For` entry (the
original client IP). The check is **hardcoded — there is no env var to disable
it** (`GOTRUE_SB_FORWARDED_FOR_ENABLED` only changes *how* the IP is read, not
*whether* it's compared).

With **IPv6**, the `challenge` POST and the `verify` POST can leave the client
from **different source addresses**:
- RFC 4941 privacy/temporary addresses rotate; outgoing connections prefer the
  newest one, so a new temp address minted between the two requests → mismatch.
- Dual-stack Happy Eyeballs may open a fresh connection for the verify and pick a
  different address family/source.

The two addresses almost always share the same **/64 prefix** (same subnet), so
masking the IP GoTrue sees to its /64 makes challenge-IP == verify-IP while still
binding MFA to the subnet.

## Fix (chosen): normalize the client IP GoTrue sees to its IPv6 /64

Applied at the **proxy in front of the GoTrue container**. This repo does **not**
contain the self-hosted Supabase gateway config (it lives on Coolify), so this is
an ops change — it can't be applied or verified from the app repo.

Front-to-back path: **Cloudflare → Traefik (Coolify) → Kong (Supabase) → GoTrue.**
Kong is the last hop that sets `X-Forwarded-For` for GoTrue, so normalize there.

### Kong pre-function (recommended)

Add a `pre-function` (Kong `serverless-functions` plugin) to the **auth** service
/ route in the self-hosted `kong.yml`, so it runs only for `/auth/v1/*`. It masks
the leftmost `X-Forwarded-For` entry to /64 for IPv6 and leaves IPv4 untouched:

```yaml
plugins:
  - name: pre-function
    config:
      access:
        - |
          local xff = kong.request.get_header("X-Forwarded-For")
          if xff then
            local first = xff:match("^%s*([^,]+)") or xff
            if first:find(":", 1, true) then                 -- IPv6
              -- Expand "::" then keep the first 4 hextets (the /64), zero the rest.
              local left, right = first:match("^(.-)::(.*)$")
              local groups = {}
              if left then
                for g in (left .. ":"):gmatch("([^:]*):") do groups[#groups+1] = g end
                local tail = {}
                for g in (right .. ":"):gmatch("([^:]*):") do tail[#tail+1] = g end
                while #groups + #tail < 8 do groups[#groups+1] = "0" end
                for _, g in ipairs(tail) do groups[#groups+1] = g end
              else
                for g in (first .. ":"):gmatch("([^:]*):") do groups[#groups+1] = g end
              end
              local prefix = string.format("%s:%s:%s:%s::",
                groups[1] ~= "" and groups[1] or "0", groups[2] or "0",
                groups[3] or "0", groups[4] or "0")
              kong.service.request.set_header("X-Forwarded-For", prefix)
            end
          end
```

> Test this on the server before trusting it — pure-Lua IPv6 `::` expansion is
> fiddly. Verify with a request carrying a compressed address (e.g.
> `2601:abc::dead:beef`) that the rewritten header is `2601:abc:0:0::`.

### Verify the fix

1. Sign in as an admin from an IPv6 client, open **Settings → Two-Factor** (or the
   admin step-up dialog) and complete a TOTP verify — expect **200**, not 422.
2. Confirm the /64 mask is stable: re-run several times over a minute so a privacy
   address rotates; all should still verify.
3. Retry the admin **Approve** on a flagged grade — expect it to succeed after the
   step-up (no more `STEP_UP_REQUIRED` loop).
4. Sanity: `GET /api/admin/grading/review-queue` still 200s (unchanged).

## Fallbacks (if /64 masking is impractical)

- **Pin XFF to a constant for `/auth/v1/factors/*` only.** Same Kong hook, but
  `set_header("X-Forwarded-For", "203.0.113.1")` (any fixed value) on the factors
  routes. Fully removes MFA IP binding (challenge always == verify). TOTP secret +
  AAL2 + step-up recency are still enforced, so the security loss is limited to
  the IP-pinning defense-in-depth layer.
- **Drop the `AAAA` record for `api.gradethread.com`.** Clients reach GoTrue over
  IPv4 only, so the source IP is stable. Blunt — removes IPv6 for *all* Supabase
  auth/DB traffic on that host.

## Client-side resilience (already shipped, in-repo)

`src/lib/mfa.ts` `challengeAndVerifyTotp()` re-runs challenge→verify as one tight
unit and **retries on `mfa_ip_address_mismatch`** (a fresh challenge re-stamps the
IP immediately before the verify, so the retry reuses the warmed keep-alive
connection and usually shares the source IP). After retries it surfaces a clear,
actionable message instead of GoTrue's raw string. Used by every MFA verify site
(`admin-mfa-gate.tsx` enroll/challenge/step-up, `mfa-card.tsx` enroll/elevate).

This makes the transient case self-heal and degrades gracefully, but the
**proxy-side /64 normalization above is the guaranteed fix** — a client whose
network alternates IPs on every connection can still exhaust the retries.
