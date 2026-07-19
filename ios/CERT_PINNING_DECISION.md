# iOS Certificate Pinning — Decision (US-1150)

**Status: NO-GO for launch.** Rely on ATS + the documented compensating
controls below. Revisit only if cert management moves off auto-rotating
Let's Encrypt to a pinning-friendly setup (see "When to revisit").

_Decision owner: Pearson Media LLC · Last reviewed: 2026-06-21_

## Question

Should the iOS app pin the TLS public key(s) of `functions.gradethread.com`
(edge) and `api.gradethread.com` (Supabase/GoTrue/Storage) so a compromised or
mis-issued CA can't MITM auth tokens, StoreKit receipts, PII, and photos?

## Context (the shipping topology)

- All app traffic is HTTPS and **ATS is fully enforced** — no
  `NSAppTransportSecurity` exceptions in `ios/project.yml` / Info.plist. The
  only network surface is the bounded `EdgeNetwork.shared` `URLSession`
  (`Networking/EdgeNetwork.swift`) plus the Supabase SDK's session; neither
  installs a `URLSessionDelegate` auth-challenge handler today.
- Backend is **self-hosted Supabase on Coolify** behind Kong/Caddy, with TLS
  terminated by certificates that (per the deploy setup) are issued and
  **auto-renewed by Let's Encrypt (~90-day lifetime)**.
- There is no MDM/managed-device assumption; the app ships to the public App
  Store, so a bad pin can only be fixed by a new App Store build (days, plus
  user update lag) — there is **no server-side or remote way to relax a pin**
  once it's compiled in.

## Why NO-GO (for now)

1. **Let's Encrypt rotation makes static pinning a self-inflicted outage risk.**
   certbot/Caddy generate a **new key pair on most renewals** by default, so a
   pinned leaf SPKI breaks every ~90 days. Pinning the LE **intermediate**
   (e.g. R10/R11/E1) is outside our control and Let's Encrypt rotates/retires
   intermediates on their own schedule — a chain change would brick every
   installed app until an App Store update propagates. For a paid, financial
   app that is a worse availability outcome than the threat it mitigates.
2. **The threat is already largely covered.** ATS enforces TLS 1.2+, forward
   secrecy, and validates the chain against the system trust store. The
   residual threat pinning adds value against is a **CA compromise / mis-issuance**
   — real, but low-probability, and partially covered industry-wide by
   Certificate Transparency (mis-issued certs for our domains are publicly
   logged and detectable).
3. **No safe rollback.** Unlike a server flag, a compiled pin has no kill
   switch. Combined with (1), the expected cost (periodic outages + emergency
   releases) exceeds the expected benefit at our scale/stage.

## Compensating controls we DO rely on (launch)

- **ATS enforced, no exceptions** — keep it that way (a CI guard could assert no
  ATS exception keys ever land in the Info.plist; follow-up).
- **Token scrubbing** so a breadcrumb/log can't leak a bearer/apikey/signed-URL
  even if traffic were observed (`TelemetryScrubber`, US-662/690/990 — tested).
- **Short-lived signed Storage URLs** (≤900s) and per-user-folder RLS, so an
  intercepted URL has minimal blast radius.
- **Server-side StoreKit JWS verification** against Apple's Root CA-G3 — receipt
  integrity does **not** depend on transport pinning.
- **Certificate Transparency monitoring** (operator): subscribe to a CT-log
  monitor (e.g. crt.sh / Cloudflare) for `*.gradethread.com` so a mis-issued
  cert is detected out-of-band. Track in `vault/10-ops/uptime-monitoring.md`.

## When to revisit (the GO path, pre-designed)

Adopt **public-key (SPKI) pinning with a controlled, long-lived key** if/when:

- Cert management moves to a setup where **we control a stable key** we can keep
  across renewals (e.g. a long-lived key + reissued certs, or an internal CA),
  AND
- We can ship **2+ backup pins** (current + next-rotation) so a planned rotation
  never requires an app update, AND
- A **rotation runbook** lives in `vault/10-ops/key-rotation.md` and a **remote kill-switch**
  (a server-delivered flag that disables pinning) is in place to recover from a
  bad pin without an App Store round-trip.

Implementation sketch when GO: a `URLSessionDelegate.urlSession(_:didReceive:)`
on `EdgeNetwork` that, for our two hosts, compares the server leaf's
SubjectPublicKeyInfo SHA-256 against the backup pin set (pass-through for any
other host); pins injected at build time from Infisical alongside the existing
secrets; unit tests asserting a good pin passes and a wrong pin fails; OAuth
`ASWebAuthenticationSession` left unpinned (it presents Apple/Google/our web
origins we don't control). File follow-up stories for each bullet above.

## Outcome

No production code change for launch. This document is the deliverable;
`vault/10-ops/key-rotation.md` / `vault/10-ops/uptime-monitoring.md` get the CT-monitoring + (future)
pin-rotation runbook entries.
