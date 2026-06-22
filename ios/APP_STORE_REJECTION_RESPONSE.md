# App Store Rejection Response — Submission 4ecd2f79 (v1.0.1 / build 162)

Reviewed June 21, 2026 on iPhone 17 Pro Max + iPad Air (M3), iOS/iPadOS 26.5.
Two issues cited. Each has a **code hardening** change (in this branch) *and* an
**operator action** that is the most probable real root cause. Both rejections
trace to an edge/StoreKit dependency failing in the review environment and the
app surfacing a confusing dead-end instead of a recoverable state.

---

## Guideline 2.1(a) — error when opening "Verified Seller"

**Where:** Tools hub → "Verified seller" → `VerifiedView` → `GET /api/verified/profile`
(edge). On any failure the screen shows `ContentUnavailableView("Couldn't load
your profile")`. The iOS flow itself is correct — the error originates on the edge.

**Most probable root cause (OPERATOR — pick whichever matches):**
1. **Demo/review account email not confirmed.** The edge auth middleware
   (`services/edge-functions/src/middleware/auth.ts:38`) returns **403
   `email_unverified`** for any account whose `email_confirmed_at` is null. A
   review account created with email+password but never confirmed fails *every*
   authed edge feature (Verified is just the one the reviewer happened to open).
   → **Action:** confirm the demo account's email in Supabase (or have the
   reviewer use Sign in with Apple, which arrives pre-confirmed). Replace the
   `REVIEW_DEMO_*_PLACEHOLDER` credentials (see `APP_STORE_SUBMISSION.md` §step 1)
   with a real, **email-confirmed** seeded account.
2. **Prod DB behind migration `00305`.** `GET /profile` selects
   `verified_embed_in_listings` (added in `00305_verified_embed_in_listings.sql`).
   If prod hasn't applied 00305, the query 500s. → **Action:** verify prod is at
   `00305` (`EXPECTED_SCHEMA_VERSION`); if behind, apply via
   `scripts/apply-prod-migrations.sh` (DB before edge, per `DEPLOY.md`).

**Code hardening (this branch):** the `email_unverified` 403 now maps to a
distinct `EdgeAPIError.emailUnverified` with an actionable message ("Please
confirm your email to use this feature…") instead of the misleading "Your
session expired. Sign in again," and no longer burns a futile token refresh.

---

## Guideline 2.1(b) — paywall fails to load after "See plans & credits"

**Where:** Settings → Plan & credits → "See plans & credits" → `PaywallView` →
`PaywallStore.load()` → `Product.products(for: IAPCatalog.allIds)`.

**Most probable root cause (OPERATOR):** the In-App Purchases are not in a
reviewable state for the exact bundle ID, so StoreKit returns **zero products**
in the sandbox. → **Action (see `APP_STORE_SUBMISSION.md` §6):**
- Confirm the **Paid Applications Agreement** is active (Business section).
- Confirm all 10 IAPs (6 subscriptions in the `flipdesk_plans` group + 4
  consumable credit packs) exist for the bundle ID, are **not** in "Missing
  Metadata," and are **attached to the version under review**.
- Run the sandbox purchase round-trip before resubmitting.

Product IDs in `IAPProduct.swift`, `GradeThread.storekit`, and the server catalog
all match — there is no ID drift.

**Code hardening (this branch) — fixes two real client bugs:**
1. **Catalog fetch could hang the paywall.** `CatalogService` used
   `URLSession.shared` (60s timeout) while `load()` awaits it *before* StoreKit.
   A stalled catalog request left the paywall spinning. Now uses the bounded
   `EdgeNetwork.shared` (20s) so it fails fast.
2. **No failure state when StoreKit returns nothing.** `load()` always landed on
   `.ready`, rendering fallback-priced rows that dead-end with "this item is
   unavailable" on tap (the `.failed`/retry UI existed but was never reached).
   Now: if StoreKit resolves **0** products, `load()` sets `.failed` with a
   "Check your connection and try again" retry; a partial result still renders.

---

## Suggested reply to App Review

> Thanks for the detail. We identified that our review account's email was not
> confirmed, which blocked the authenticated "Verified Seller" feature, and that
> our In-App Purchases were not fully attached to the reviewed version, so they
> did not load in the sandbox. We have [confirmed the demo account / attached the
> IAPs / applied the pending migration] and hardened both screens to show a clear,
> recoverable retry instead of an error. A new build is attached.

(Edit the bracketed parts to match the operator actions actually taken.)

---

## Pre-resubmission broad sweep (proactive hardening)

After the two cited fixes, four read-only audits swept the iOS app for the same
bug *classes* (network hangs, stuck/dead-end load states, crashes, iPad, auth/IAP
completeness) so we don't bounce off review again. Crash-risk and iPad came back
clean (very defensive codebase; size-class NavigationSplitView, guarded camera,
ShareLink-based sharing). Fixes applied:

**Network hangs (UI stuck on a spinner ~60s — same class as the paywall reject):**
- `SupabaseShared.client` now uses a **bounded session (20s idle timeout)** — the
  SDK defaulted to `URLSession.shared` (60s). This was a *second* hang vector in
  the paywall (`refreshBilling()` reads the `users` row directly) and protects
  ~45 other direct-Supabase loading screens at the root. Realtime is unaffected
  (separate websocket transport + heartbeat).
- `GradedPhotoView` slab fetch, `DisclosureStore` defect-photo fetch →
  `EdgeNetwork.shared` (bounded) instead of `URLSession.shared`.
- `CachedThumbnail` loader and `PhotoSignedURLProvider` sessions → 20s idle
  timeout (these back every remote thumbnail / private-bucket image).

**Stuck / dead-end load states (screen with no recovery — the reject pattern):**
- `BulkPricingView` `.failed` had **no retry** (a true first-load dead-end) → now
  the standardized `ErrorStateView` with in-place retry.
- `EbayAccountsView` `.failed` → `ErrorStateView` (was a bare message).
- `DisclosureView` showed an **indefinite per-photo spinner** when a photo failed
  to load → now tracks failures and offers a per-row "Retry".
- `ListingPerformanceStore.load()` gained a re-entrancy guard (overlapping
  `.task` + `.refreshable` could show stale rows).

**Permissions safety net:** mirrored the camera/photo/Face ID `NS*UsageDescription`
strings into the committed `Info.plist`. The archive was already safe (release CI
runs `xcodegen generate`, and `project.yml` holds all keys), but this prevents a
manual archive that skips xcodegen from shipping without them and crashing.

