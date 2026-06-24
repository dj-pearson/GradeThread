# Web Platform Security Audit — June 2026

Scope: deep review of the web platform's **authentication/authorization** and the
**AI-call abuse surface** (hard usage limits, bypass/spoof resistance), plus the
adjacent webhook, tenant-isolation, and SSRF surfaces. Four parallel audits
covered: edge auth & JWT, AI abuse & limits, frontend auth, and webhooks/public
endpoints/tenant isolation.

**Overall posture: strong.** JWT signatures are genuinely verified server-side,
identity context is unspoofable, admin/job/API-key gating is sound, per-account
AI quotas are atomic (no TOCTOU), and tenant isolation holds. The fixes below
close the concrete gaps that were found.

---

## Fixed in this change

### CRITICAL — SSRF via FlipDesk AI photo fetch
`lib/ai-extract.ts` `buildPhotoContent()` fetched caller-supplied `photo_urls`
(`POST /api/flipdesk/ai/extract`, any authenticated FlipDesk user) with a raw
`fetch`, no private-range check, default redirect following — reachable against
`169.254.169.254` cloud metadata and the internal network.
**Fix:** routed through `safeFetch()` (DNS-resolves + refuses private/loopback/
link-local/metadata ranges, re-validates every redirect hop, caps bytes).

### HIGH — Unbounded images per grade = AI-cost multiplier
The pipeline issues one Claude Vision call **per image** but a submission is
billed as a single grade. `grade.ts` and `api-v1.ts` enforced only *minimum*
images, no maximum and no de-dup, so one paid grade could fan out into dozens of
vision calls.
**Fix:** `MAX_IMAGES_PER_SUBMISSION` cap + duplicate-`image_type` rejection in
both submit endpoints, plus a defensive cap in `grading-pipeline.ts` so no future
write path can re-introduce the multiplier.

### MEDIUM — FlipDesk auth applied by per-path whitelist (two routers left open)
`/api/flipdesk/forecast` and `/api/flipdesk/photo-profiles` were mounted but
missing from the per-path `authMiddleware` whitelist (in-file comments wrongly
claimed coverage).
**Fix:** wired `authMiddleware` (+ `workspaceMiddleware` for forecast) onto both,
and added a build-time guard test (`tests/flipdesk-auth-coverage_test.ts`) that
fails if any `/api/flipdesk/*` router is mounted with **no** auth under its prefix
(unless explicitly allowlisted as public). This makes the whole class of mistake
fail the build instead of shipping.

### MEDIUM — Stored content/newsletter webhook URLs fetched without SSRF guard
Admin-configured `make_webhook_*` / newsletter webhook URLs were fetched
server-side with no validation.
**Fix:** `assertPublicUrl()` at **write** time (`content-settings.ts` PATCH +
test-fire) and at **delivery** time (`content-webhook.ts`, `newsletter-webhook.ts`),
plus `redirect: "manual"` on every delivery fetch (DNS can change after set).

### MEDIUM — Stored XSS via blog autosave bypassing the publish-time sanitizer
The public blog/cert SSR injects `body_html` verbatim, trusting publish-time
sanitization — but the autosave `PATCH /api/content/blog/:id` wrote `body_html`
**raw** and purged the SSR cache for already-published posts, so editing a live
post could persist `<script>`/`<img onerror>` and serve it.
**Fix:** `sanitizeHtml()` on `body_html` in the autosave PATCH and the draft
create, so the "body_html in the DB is always clean" invariant holds on every
write path (all AI-generation/publish paths already sanitized).

### MEDIUM — Global daily AI ceiling failed fully open on counter-store error
The last-line platform-wide spend cap allowed all calls if the counter store
errored, removing the only global volume bound during an outage.
**Fix:** degraded **process-local** fallback counter enforces the ceiling when the
shared store is unavailable (bounded ≈ ceiling × replicas instead of unbounded),
and emits an `ai.global_ceiling_counter_unavailable` metric.

### LOW — Legacy `/api/webhooks/ses` had no SNS signature verification
Duplicate of the verified `/api/email/ses-notifications`; a forged bounce could
suppress an arbitrary recipient (deliverability DoS) and the `SubscribeURL` was
fetched unguarded.
**Fix:** added fail-closed `verifySnsSignature` (mirrors the canonical receiver),
making the post-verification `SubscribeURL` fetch safe.

### LOW — Tenant-write hardening (defense-in-depth, US-268)
Three writes keyed on a derived id without a same-query owner filter (not
exploitable today, but one refactor from IDOR):
- `flipdesk-pricing.ts` apply — re-verify listing ownership via
  `inventory_items!inner(user_id)` before the price update.
- `relist-detect.ts` `ensureItemPhotoHashes` — scope the phash cache write by
  `inventory_item_id`.
- `workspace.ts` mfa-policy — key the write on `ownerId` (consistent with the
  read/audit), robust to a future gate change.

### LOW — Free Snap-to-Value rate
Free, uncertified Snap shared the generic 60/min grade limiter; the monthly-
unlimited "business" tier had no per-minute bound.
**Fix:** dedicated `rate_limit_snap_per_min` limiter (default 10/min) on
`/api/grade/snap`.

---

## Verified solid (no change needed)

- **JWT:** signature verified via `supabaseAdmin.auth.getUser(token)`; decode-only
  claims used solely for `aal`/`amr` on the already-verified token. No header/body
  source of `userId`, `workspaceOwnerId`, or admin role.
- **Admin:** single `/api/admin/*` chokepoint (authMiddleware → adminAuthMiddleware,
  DB-read role + AAL2 MFA); sensitive actions add scope + step-up.
- **Jobs/cron:** constant-time secret compare, fail-closed, replay-protected
  signed variant.
- **API keys:** HMAC-SHA256+pepper, indexed hash lookup, scope + `user_id` scoping.
- **CORS:** fixed allowlist, no credentials, no header reflection.
- **AI quotas:** `reserve_ai_action` / `reserve_snap` are atomic row-locking CAS
  (no TOCTOU); reservations/payment precede the billable call with refund-on-fail;
  keyed on JWT-derived subjects, never request body. Global concurrency semaphore
  wraps every Anthropic call.
- **Webhooks:** Stripe / eBay / Shopify / Depop / SNS all verify signatures over
  the raw body before side effects; idempotent replay protection.
- **Frontend:** no service-role/secret keys bundled (only anon/publishable/public);
  no `dangerouslySetInnerHTML` in `src/`; access control enforced server-side
  (guards are UX only); plan/grade/pricing never trusted client-side.

---

## Follow-ups — now implemented

### Free-tier multi-account abuse → per-IP daily Snap cap
Free Snap monthly caps are per-account, so farming many accounts multiplied free
vision calls. Added a per-IP **daily** ceiling on the free tier (`snap_ip_daily_cap`,
default 30), keyed on the Cloudflare-attested IP (un-spoofable; XFF untrusted in
prod), checked before the monthly reservation. *Note:* the "lower allowance for
unverified emails" idea turned out moot — the edge `authMiddleware` already
**blocks every unverified-email account** from all authenticated routes (US-366),
which is stronger than a reduced allowance.

### AI budget kill-switch latency → inline cached gate
Added `lib/ai-budget-gate.ts`: a cached (30s TTL) `isAiBudgetExhausted(feature)`
reading the same `ai_budget_status()` source the cron uses, fail-open on error.
Wired into every grading entry (`grade.ts` submit/pay/snap, `api-v1.ts`,
`flipdesk-grading.ts`) so a hard USD breach pauses grading within seconds, before
any charge — not at the cron interval. Also extends the grading kill-switch to the
public API + FlipDesk grading entries, which previously didn't check it. Admin
budget mutations clear the gate cache for immediate effect.

### Admin impersonation → server-side resume handoff (no refresh token in storage)
`/start` now mints a **second** one-time magic-link token for the admin; the
client stashes only that single-use, short-lived resume `token_hash` (never the
admin's long-lived refresh token). "Exit" redeems it via `verifyOtp` to restore
the admin session, falling back to a clean sign-out if it expired. An XSS during
impersonation can no longer lift a credential that mints admin sessions
indefinitely.

### Blog/cert SSR pages → nonce-based CSP (defense-in-depth)
Discovered that Cloudflare `_headers` (the enforcing CSP in `public/_headers`)
applies only to **static** assets, NOT to Pages **Function** responses — so the
dynamic SSR pages that render server-injected HTML (blog, cert, passport,
verified, condition-index, authors) shipped with **no CSP at all**, exactly the
XSS-sensitive surface. Added `functions/_shared/security-headers.ts` (per-response
nonce + tight CSP) and a `renderSsrResponse()` wrapper that stamps the nonce onto
each page's own inline scripts (GA config, JSON-LD) while a nonce-only `script-src`
(no `'unsafe-inline'`/`'unsafe-eval'`) blocks anything injected via `body_html`.
Wired into all six SSR functions; the iframe-embeddable cert variants
(embed/badge/slab) were deliberately left alone (a `frame-ancestors 'none'` CSP
would break embedding). Unit-tested in `src/test/ssr-csp.test.ts`.

## Status

All audit findings and follow-ups are now addressed. No open items.
