---
title: Code review — 2026-07-04 deep dive
type: reference
status: archived
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [audit, code-review, snapshot]
summary: Nine-domain deep-dive review; all six executive-summary criticals since closed, the lower tier untriaged.
---

> [!warning] Archived 2026-07-19 — and only PARTLY triaged
> **As-of date: 2026-07-04.** This is a snapshot; do not read it as current state.
>
> **The six executive-summary criticals are all CLOSED.** Each was verified by
> reading the cited code on 2026-07-19, and each has a shipped story: mobile
> billing fraud (US-1614/1615/1618/1619/1620), viewer privilege escalation
> (US-1616, US-1928), cross-account query cache (US-1617), iOS upload data-loss
> (US-1621), grading auto-finalize gap (US-1622), dead eBay endpoints (US-1623).
>
> **The remaining ~87 findings were NOT verified.** The ~9 web P1s, ~20 P2s, the
> edge/DB P2s and the P3 tail are of unknown status. Tracked by **US-2089** —
> that story exists so archiving this document does not retire real work.
>
> The 93 unchecked boxes below carry **no signal**: nothing was ticked as work
> shipped, so an unchecked box means "nobody updated the doc", not "still open".

# GradeThread — Deep-Dive Code Review & Action Plan

> [!info] Triage status (US-2089, updated 2026-07-19)
> **2 of 93 boxes are ticked.** Both were the edge/DB P2s US-2089 names
> explicitly, and both turned out to be ALREADY FIXED by later stories — the
> boxes were never ticked when the work shipped, which is why they carried no
> signal either way.
>
> An unchecked box in this note means **NOT YET TRIAGED**, not **still open**.
> Do not read the 91 remaining as a backlog of live defects; read them as
> unverified. That distinction is the whole reason US-2089 exists.


**Date:** 2026-07-04
**Scope:** Web frontend, edge service, database/RLS, durable jobs, iOS app (core + features)
**Method:** Nine parallel domain reviewers, each reading source directly and quoting evidence; high-severity claims independently re-verified against the code. Findings deduped against the existing audit docs (`SECURITY_AUDIT_2026-06.md`, `ios/IOS_DEEP_DIVE_AUDIT_2026-07-01.md`, `ios/IOS_PRODUCTION_READINESS_REMAINING.md`, `IOS_APP_REVIEW_AUDIT_2026-06-30.md`) — only **new** findings are listed.

> Severity key: **P0** = active security hole / money loss / data-loss right now · **P1** = functional bug real users hit (several with money/privacy/fraud impact) · **P2** = correctness bug with clear user impact · **P3** = hardening / edge-case / quality.
> Every item cites `file:line` and a concrete failure scenario so it can be picked up and fixed without re-deriving the analysis.

---

## Executive summary

**No P0 cross-tenant read/write path was found** — the edge service's tenant-scoping discipline (the highest-stakes surface) held up under a route-by-route audit, and the Stripe rails, magic-byte upload validation, SSR escaping, cron auth, and grading rounding-lockstep are all mature and defensively engineered.

The risk is concentrated in **newer surfaces that never inherited the hardening the core earned**:

1. **Mobile billing (App Store / Google Play) is exploitable for fraud and revenue loss.** Six P1s: a Google Play subscription token can entitle unlimited accounts; Play subs never lapse server-side; refunded Apple credit-packs are never clawed back; and `billing_source` state management double-bills or locks out cross-processor customers. These are the sharpest findings in the review.
2. **Intra-workspace privilege escalation.** A read-only `viewer` workspace member can move money, publish listings, and drain AI budget — the `workspaceRole` is computed but never enforced on FlipDesk write routes.
3. **Same-device cross-account data exposure (web).** The TanStack Query cache is never cleared on sign-out and dozens of per-user query keys omit the user id, so the next person to sign in on a shared browser sees the previous user's finances, submissions, and disputes for up to 5 minutes.
4. **Silent data-loss on iOS.** The photo upload queue is in-memory only and the crash-recovery draft is dropped at enqueue time, so a mid-batch app kill permanently loses a seller's photos.
5. **A grading-integrity gap.** Post-composite provenance confidence boosts can auto-finalize (publish a certificate for) a grade whose effective confidence fell below the human-review threshold.
6. **Ten eBay endpoints are dead for real users** — missing from the per-path auth whitelist, so they 401 unconditionally including for signed-in sellers.

### Finding counts

| Domain | P1 | P2 | P3 |
|---|---|---|---|
| Payments / billing / webhooks | 6 | 2 | 5 |
| Web data-flow & UI | 9¹ | ~20 | ~12 |
| Edge tenant isolation | 1 | 2 | 11 |
| Grading engine | 1 | 3 | 4 |
| Database RLS & durable jobs | 1 | 2 | 2 |
| iOS core (auth/net/persistence) | 1 | 4 | 2 |
| iOS feature flows | 1 | 7 | 4 |
| Web auth / client security | 1¹ | 1 | 1 |
| Uploads / storage / SSR | 0 | 2 | 3 |

¹ The sign-out/query-cache exposure was found independently by both the auth and web-UI reviewers; it is counted once and listed under **Critical** below.

---

## 🔴 Critical — fix before launch (fraud, revenue loss, cross-account exposure, data-loss)

These are the P1s whose blast radius is money, fraud, PII exposure, or permanent data-loss. Ordered by how cleanly they can be exploited.

- [ ] **C1 · Google Play subscription token entitles unlimited accounts** — `services/edge-functions/src/lib/google-play/verify.ts:206-233`. Unlike the App Store path, the Play subscription verify only checks the token is valid with Google, then entitles *whoever is calling*. No `obfuscatedExternalAccountId` binding and no uniqueness claim (`users.google_purchase_token` has no unique constraint). One purchase → share the `purchaseToken` → N accounts all get Business, re-verifiable monthly. **Fix:** stamp `obfuscatedExternalAccountId = userId` at purchase, require it to match the caller, add a unique claim so a token maps to exactly one user.
- [ ] **C2 · Apple credit-pack REFUND/REVOKE never claws back credits** — `services/edge-functions/src/routes/appstore.ts:233-238`, `src/lib/appstore/notifications.ts:29-31`. The consumable branch only ever grants; there's no Apple analog of Stripe's `clawbackCreditPack`, and `DecodedTransactionLite` doesn't carry `revocationDate` so `/verify` will even grant an already-refunded transaction. Buy `credits_100` → refund → keep the credits, repeatable. **Fix:** handle `revoke` for consumables (RPC keyed on `transactionId`, clamped like `revoke_grade_credits`); check `revocationDate` in `verifyTransaction`.
- [ ] **C3 · FlipDesk write/spend routes never enforce `workspaceRole` — a read-only viewer can move money** — `services/edge-functions/src/middleware/workspace.ts:121` (`requireWorkspaceRole` exists but is never called). Sharpest at `flipdesk-consignment.ts:287` (`POST /payouts` = a real Stripe transfer of the owner's funds), also `grade.ts:684` (`/pay/:id` drains owner credits), `flipdesk-autolister.ts:1899` (`/publish-batch` publishes owner inventory live). A `viewer` sends `X-Workspace-Owner: <ownerId>` and acts. **Fix:** apply `requireWorkspaceRole(...)` at the `main.ts` mounts (admin for payouts/disconnect, listing_manager for publish/reprice/CRUD); add a `viewer` 403 to `grade.ts` `/pay`, `/snap`, `/dispute`.
- [ ] **C4 · Same-device cross-account data exposure — query cache not cleared on sign-out** — `src/hooks/use-auth.ts:184-186`, `src/main.tsx:39`. Sign-out is SPA navigation (no reload), only Zustand is reset, and dozens of per-user query keys omit the user id (`["finances-dashboard",period]`, `["dashboard-submissions"]`, `["my-disputes"]`, `["ebay_payouts"]`, `["api-keys"]`, …). With `staleTime: 5min`, user B is served user A's finances/submissions/disputes **without a refetch**. **Fix:** `queryClient.clear()` in the `SIGNED_OUT` branch of `onAuthStateChange`; add `user.id` to every per-user key.
- [ ] **C5 · `billing_source` one-way ratchet double-bills / locks out cross-processor customers** — `services/edge-functions/src/routes/webhooks.ts:548-587` never sets `billing_source='stripe'`. Consequences: (a) the Google Play "active Stripe" precedence gate never fires → an active Stripe subscriber buying on Android is **double-billed** (`google-play/verify.ts:206-211`); (b) a former iOS subscriber who moves to Stripe stays flagged `appstore` → every plan change returns `409`, the UI hides cancel/change, and the Apple expiry sweep can force-lapse a paying Stripe customer to Free. **Fix:** set `billing_source:'stripe'` in `handleSubscriptionChange` (at least on `customer.subscription.created`); match the Apple null-tolerant predicate in the Play gate.
- [ ] **C6 · Google Play subscriptions never lapse server-side** — `services/edge-functions/src/routes/google-play.ts:19-20`, `src/lib/appstore/expiry-sweep.ts:71` (Apple-scoped). No RTDN webhook, no expiry sweep for `googleplay`. Buy one month, cancel in Play → entitlement is effectively perpetual; refunds never reconciled. **Fix:** implement the RTDN Pub/Sub webhook with an idempotency claim; interim, extend the expiry sweep to `billing_source='googleplay'`.
- [ ] **C7 · App Store webhook failure permanently loses the event** — `services/edge-functions/src/routes/appstore.ts:216-257`. The idempotency claim is taken before side-effects, but a handler throw isn't caught, the claim is never released, and Apple's retry hits `"duplicate"` → 200 no-op. A transient DB blip during a REFUND/EXPIRED = user keeps paid entitlement. **Fix:** wrap dispatch in the same transient-release / dead-letter policy the Stripe route uses (`failIfDbError` + `releaseWebhookEvent`).
- [ ] **C8 · iOS photo upload queue is in-memory only → permanent photo loss on mid-batch kill** — `ios/GradeThread/Upload/PhotoUploadStore.swift:13`, `Capture/PhotoIntakeView.swift:830-838`. The queue is a plain dict; the crash-recovery draft is cleared the moment tasks *enqueue* (not upload); durable mutations are only written on failure paths; nothing rescans at launch; the foreground upload takes no background-task assertion. Background the app mid-batch → iOS jetsams → item exists with few/no photos, no draft, no retry. **Fix:** persist queued tasks and re-enqueue at launch (or write the `LocalPendingMutation` at enqueue time; replay is already idempotent by deterministic `photo_id`), and wrap the serial drain in `beginBackgroundTask`.
- [ ] **C9 · Grading auto-finalizes a certificate for a below-threshold-confidence grade** — `services/edge-functions/src/lib/grading-pipeline.ts:1476-1490, 1632-1653`. The review gate is computed once inside `compositeGrade`; the pipeline then shaves confidence for a verification discrepancy (without re-checking the 0.75 gate) and later *adds* provenance boosts back. Net: a grade whose effective confidence is 0.70 and whose verification found a contradiction can be boosted to 0.90 and published with no human review. Violates the skill's "confidence < 0.75 → human review" and "never raise confidence post-composite" contract. **Fix:** re-derive `needs_human_review ||= confidence_score < reviewConfidenceThreshold()` after *all* post-composite adjustments; make any confidence-lowering event a floor the boosts can't cross.

---

## Web — data-flow & UI correctness

### P1
- [ ] **Workspace-scoped queries not owner-keyed → previous tenant's data on switch** — `src/hooks/use-automations.ts:84`, `use-repricing.ts:57,70`, `use-google-sheets.ts:61`, most of `use-ebay.ts`. `switchWorkspace` only sets Zustand; no invalidation. A member switching workspaces sees (and can mutate) the prior workspace's automation rules and repricing nudges. **Fix:** key on `activeWorkspaceOwnerId ?? user.id` and/or invalidate in `switchWorkspace`.
- [ ] **Bulk submission has no synchronous double-submit guard → double charge** — `src/pages/bulk-submission.tsx:287-291`. `disabled={isSubmitting}` only applies next render; `new-submission.tsx` fixed this with `submitLockRef` (US-774) but bulk never got it. Two clicks in one frame POST every row twice. **Fix:** add the same synchronous ref lock.
- [ ] **`compressImage` double-applies EXIF orientation → sideways garment photos** — `src/lib/image-utils.ts:423-480`. `loadImage` decodes via a plain `<img>` (browsers already bake in orientation), then the manual transform rotates again. Hits every surface via `compressImage`. **Fix:** delete the manual transform, or decode with `createImageBitmap(file,{imageOrientation:"none"})`.
- [ ] **PhotoUpload loses staged photos when stepping back from Review; edits clobber the parent list** — `src/pages/new-submission.tsx:822-861` + `components/submission/photo-upload.tsx:326-360`. Photos live only in child state and are never passed back down; "Back" remounts empty while Continue stays enabled; the retake remount re-seeds the original photos over replacements. **Fix:** lift slot state to the parent (controlled), or keep the component mounted and hide via CSS.
- [ ] **Detail-page realtime invalidates a phantom key → `pending_review` never updates** — `src/hooks/use-realtime-submission.ts:94` + `submission-detail.tsx`. The page uses `useState`, not `useQuery`, so `["submission",id]` matches nothing and the fallback poll excludes `pending_review`. The "we'll let you know the moment it's official" banner never resolves without a hard refresh. **Fix:** add an `onChange` callback (or convert to `useQuery`); include `pending_review` in the poll.
- [ ] **Auto-delist stamp cleared even when the extension hard-fails → double-sale risk** — `src/hooks/use-pending-delists.ts:74-91`. `delist-confirm` fires unconditionally even when `sendDelistToLister` resolved `{ok:false}`, so a still-live cross-listing drops off the queue and can sell twice; conversely the manual paths never clear and nag forever. **Fix:** confirm only on real success; add an explicit "mark done" for manual paths.
- [ ] **Inventory-detail writes never invalidate any query** — `src/pages/inventory-detail.tsx:285-296` and 4 other sites. No `useQueryClient` in the file; recording a sale leaves the FlipDesk pipeline showing "Listed" for up to 15 min. **Fix:** invalidate `["items_full"]`, `["inventory"]`, `["inventory-listings"]`.
- [ ] **Adding an inventory item invalidates nothing** — `src/pages/inventory-add.tsx:106-126`. New item missing from the cached list the user lands on → confusion / duplicate re-add. **Fix:** invalidate `["inventory"]`, `["inventory-brands"]`, `["items_full"]`.

### P2 (high-value subset — full list in the domain notes)
- [ ] **Stripe checkout/portal buttons re-enable before the redirect → duplicate Checkout sessions** — `src/hooks/use-billing-summary.ts:138-143`. Setting `location.href` resolves the mutation; the button re-enables in the seconds before navigation. **Fix:** latch a "redirecting" flag; keep disabled.
- [ ] **Billing page has no error state → failed summary renders skeletons forever** — `src/pages/billing.tsx:153-166`. **Fix:** handle `isError` with retry.
- [ ] **Submission-detail fetch: no cancellation + five swallowed Supabase errors** — `src/pages/submission-detail.tsx:304-393`. A→B navigation interleaves state; a transient error on a completed grade renders "Grade Report Pending" forever; the dispute fetch uses `.single()` which errors on the normal zero-dispute case. Same pattern in `inventory-detail.tsx`, `certificate.tsx`. **Fix:** cancellation flag + reset on id change + check every error; `.maybeSingle()` for disputes.
- [ ] **`linkInventoryItem` failure toast is dead code** — `src/pages/new-submission.tsx:518-534`. supabase-js returns `{error}`, doesn't throw; the item silently never links. **Fix:** read `{error}`.
- [ ] **Bulk submission fetches the auth token once before a long batch → mid-batch 401s** — `src/pages/bulk-submission.tsx:297-341`. Also unguarded `response.json()` on HTML 502s here and at `new-submission.tsx:620`. **Fix:** refresh per row / route through `edgeFetch`; guard `.json()`.
- [ ] **Grade/status sort only sorts the current page but is presented as global** — `submissions.tsx:257-312`, `inventory.tsx:216-236`. **Fix:** sort server-side.
- [ ] **Snap-to-Value uploads the raw uncompressed file and pushes a full data URI into router history state** — `src/pages/snap.tsx:36-43,176-186`. Large photos exceed the history-state cap and break the snap→certified bridge. **Fix:** validate+compress first.
- [ ] **eBay sync completion compares client clock to server timestamp, no failure path → permanent "syncing…" toast** — `src/pages/flipdesk/marketplaces.tsx:999-1036`.
- [ ] **Kanban drag optimistic update: no `cancelQueries`, whole-array rollback** — `src/pages/flipdesk/pipeline.tsx:352-376`.
- [ ] **Photo-reconcile commit counts failed uploads, orphans drafts, marks session committed on partial success** — `src/hooks/use-reconcile-commit.ts:72,190-244`.
- [ ] **`useUpdateBlogPost` caches the tag-less PATCH response → next save wipes tags** — `src/hooks/use-content.ts:198-200`.
- [ ] **`useBulkPublish` polls in an unbounded `for(;;)` with no unmount cancellation** — `src/hooks/use-autolister.ts:172-206`.
- [ ] **Admin content/changelog/sheet/Shopify hooks send a possibly-expired token, no 401 retry** — `use-content.ts`, `use-changelog.ts`, `use-sheet-import.ts`, `use-shopify.ts`.
- [ ] **Referrals redeem/campaign/leaderboard are `try/finally` with no `catch` → silent unhandled rejection** — `referrals.tsx:168-293`.
- [ ] **Self-imposed AI-cap semantics disagree across surfaces; non-numeric input saves as a hard `0` cap** — `use-plan-usage.ts:73` vs `billing.tsx:632-637`; `settings.tsx:469-473`.
- [ ] **Checkout-success toast/analytics/reconcile replay from bare URL params** — `billing.tsx:102-131` (bookmark re-fires the loop + inflates conversion metrics).
- [ ] **Offline intake queue replays duplicates (per-tab lock, no idempotency key)** — `src/lib/offline-queue.ts:87-99`.
- [ ] **Record Sale: bulk listing-deactivation error ignored** — `inventory-detail.tsx:416-426`.
- [ ] **Grade-completion realtime invalidates two phantom keys → dashboard never refreshes** — `use-realtime-submission.ts:44-45`.

### P3
- [ ] **Date-only defaults use `toISOString()` (UTC) → evening users record tomorrow's date; breaks tax-year boundary + payout matching** — `inventory-add.tsx:50-52`, `inventory-detail.tsx` (several), `submissions.tsx:165` (CSV export also omits the `superseded_at` filter). **Fix:** derive local Y/M/D (`toLocaleDateString("en-CA")`).
- [ ] **Dashboard inventory/passport queries swallow errors → wrong zero-state, no error UI** — `dashboard.tsx:334-387`; same in the disputes join fetches.
- [ ] **Auth profile-load failure nukes profile/workspaces and stamps the dedup window → paid user shows as free, retry suppressed** — `use-auth.ts:110-118`; settings forms can then save empty over real data.
- [ ] **Photo preview object URLs leak (revoked only on replace/remove, never on unmount)** — `photo-upload.tsx:413-493`.
- [ ] **Tax P&L summary sums raw floats → can disagree with printed rows by a cent** — `src/lib/tax-pnl-export.ts:145-228`.
- [ ] **Assorted stale-invalidation / swallowed-write gaps** — `use-google-sheets.ts:143`, `flipdesk/sources.tsx:157`, `use-workspace.ts:36`, `inventory.tsx:461`, `use-forecast.ts:33`, `settings.tsx:495`, plus CSV formula-injection (`=/+/-/@`) neutralization in `financial-export.tsx` and the submissions CSV escaper.

---

## Web — auth / client security

### P2
- [ ] **Auth `token_hash` / recovery tokens ride in the URL query string and reach GA/PostHog** — `src/pages/auth-confirm.tsx:50-52`, `reset-password.tsx:167`; GA `page_location` (`index.html:62-97`) and PostHog `$current_url` (`analytics.ts:92-99`) capture the full href. A still-valid single-use token lands in analytics before `verifyOtp` consumes it. **Fix:** `history.replaceState` to strip auth params before any pageview; add PostHog `before_send` / GA redaction for `/auth/*`.

### P3
- [ ] **Financial PDF export HTML-injects unescaped cells (self-XSS)** — `src/components/finances/financial-export.tsx:135-143` escapes only `itemTitle`; `platform`/`category` (marketplace-sourced) go in raw, then `document.write` into a same-origin window. **Fix:** `escapeHtml()` every cell (match `esc()` in `reconciliation.tsx:684`).

**Verified clean:** open-redirect (`sanitizeReturnTo()` applied at every callback), `dangerouslySetInnerHTML` (only the escaped JSON-in-script block), API-key handling (never persisted), session storage adapter, `onAuthStateChange` hydration guards, password-reset global session revoke, Sentry PII stripping.

---

## Edge — tenant isolation (US-268)

**No P0 cross-tenant path.** Scoping, webhook/OAuth tenant resolution, and cron auth all verified clean. (The P1 role-enforcement gap is **C3** above.)

### P2
- [ ] **Per-grade checkout scoped to bare `userId` strands workspace-member submissions** — `payments.ts:612-624` (no `workspaceMiddleware` on `/api/payments/*`). Member submissions are `user_id = ownerId`, so `/per-grade` 404s. Strict scoping is what *prevents* injection here — the defect is a broken workspace flow. **Fix:** mount `workspaceMiddleware`, thread `ownerId` through the ownership check + `metadata.user_id` + webhook flip.
- [ ] **Account deletion orphans retained originals + dispute evidence (GPS-bearing PII survives)** — `account.ts:355-371` selects only `storage_path`, never `submission_images.original_storage_path` (EXIF/GPS deliberately intact) or `disputes.evidence_paths`. Returns `{deleted:true}` while the objects persist. **Fix:** include both in the caller-scoped `removeAll` sweep.

### P3 (hardening — verified not currently exploitable)
- [ ] `grade.ts:792` `/status/:id` uses `select("*")` → leaks `reviewed_by` to the tenant (whitelist columns).
- [ ] `lib/grade-billing.ts:252` `runPaymentPrecedence` marks paid by `.eq("id",…)` alone (all callers owner-verify first; add `.eq("user_id",…)` at the chokepoint).
- [ ] `notifications.ts:568` `/dispute-filed` — existence/status oracle + re-fires admin email every call (scope + `admin_alerted_at` guard).
- [ ] `notifications.ts:733` `/welcome` unauthenticated, takes `userId` from body — account-existence oracle (move behind auth).
- [ ] `flipdesk-ai.ts:364` inserts `ai_enrichment_log` before ownership check → cross-tenant UUID-existence oracle.
- [ ] `flipdesk-autolister.ts:1025/1183` use `${ownerId}/` not `${ownerId}/_staging/` (tighten).
- [ ] `flipdesk-listings.ts:287` `/cross-push` bare `.eq("id",…)` (add `.eq("user_id",ownerId)` — now free via `00146`).
- [ ] `flipdesk-images.ts:53` `/remove-bg` can write a sensitive `tag`/`certificate` derivative into the **public** bucket (block sensitive `photo_type`s).
- [ ] `flipdesk-auth-coverage_test.ts:35` deny-by-default guard is regex-scoped to `/api/flipdesk/*` only — a new router elsewhere that forgets auth ships uncaught (generalize the guard).

### Test-coverage gaps (US-268 mandates a rejection case per route)
- [ ] `workspace.ts` — **zero** cases (the role-authz surface **C3** most needs coverage and has none).
- [ ] `notifications.ts`, `verified.ts`, `passport.ts tags/:tagId/revoke` — no cross-tenant cases.

> Residual: a full line-by-line sweep of `flipdesk-ebay.ts` (8,546 lines) did not complete; its load-bearing helpers were cross-verified clean, but a targeted pass on the remaining bespoke handlers is recommended before launch.

---

## Payments / billing / webhooks

(6 of the P1s are **C1, C2, C5, C6, C7** above, plus the Google Play precedence bug folded into C5.)

### P2
- [ ] **Delayed App Store EXPIRED/REVOKE clobbers a since-created active Stripe subscription** — `appstore.ts:240-248` applies `computeUserUpdate` unconditionally. **Fix:** skip lapse actions when the user has a live Stripe sub (mirror the sweep's `lapseUser` guard).
- [ ] **Per-grade checkout: duplicate payment for the same submission silently kept (no refund, no alert)** — `payments.ts:25-31` + `webhooks.ts:1027-1040`. The tier-scoped idempotency key lets one submission mint up to 3 payable sessions; the second paid-flip is a 0-row no-op that throws nothing. **Fix:** auto-refund (or `pending_refunds` + alert) when a `per_grade` paid-flip matches 0 rows.

### P3
- [ ] **100%-discount pack checkout has `payment_intent=null`, defeating grant idempotency** — `payments.ts:546` + `00092_grant_credits_idempotent.sql:52`. Fall back to `session.id`.
- [ ] **Affiliate payout Stripe idempotency keys expire ~24h → a stuck payout retried later can double-transfer** — `lib/affiliate-payout.ts`. Also retries permanently-failing transfers forever; commission `amount` is float USD end-to-end. **Fix:** list transfers by `metadata.payout_id` before retry; add a retry cap.
- [ ] **SNS verification has no `Timestamp` freshness check; `SES_SNS_SKIP_VERIFICATION` is a silent prod kill-switch** — `lib/sns-verify.ts`, `email-sns.ts:43`. **Fix:** reject >~1h old; gate the skip flag on `!isProduction()`.
- [ ] **Admin `/charges/:id/refund` partial refunds carry no idempotency key** — `admin-billing.ts:807-815`.
- [ ] **Stripe subscription handlers trust event payloads → out-of-order delivery can transiently resurrect stale state** — `webhooks.ts` (mitigated by the reconciliation backstop).

**Verified clean:** Stripe webhook signature over the raw body; all grant/revoke/debit RPCs are `FOR UPDATE` row-locked and keyed; client→server price-id mapping (no client amounts); App Store JWS verification with pinned Root CA G3 + `appAccountToken` ownership; admin billing behind `billing:write` + AAL2 + step-up.

---

## Grading engine

(The P1 is **C9** above.)

### P2
- [ ] **Provenance boosts break min-of-caps composition (applied after caps, can exceed them)** — `grading-pipeline.ts:1632/1744/1851`. A peer-norm-capped 0.70 confidence gets boosted to 0.90 in the stored value, polluting the US-1557 calibration loop; `evaluateVerifiedCapture` also ignores `manipulation_suspected`. **Fix:** `min(conf + boost, capFloor)`.
- [ ] **Escalation re-grade silently drops optional images without the partial-image cap** — `grading-pipeline.ts:302-308`. A transient failure of the `defect` image on the escalated model ships a grade from an incomplete set with no cap and no forced review. **Fix:** OR `failedOptional` into `partialSuccess`.
- [ ] **Seller `brand` reaches the trusted prompt channel via baseline generation (indirect injection around the US-346 fence)** — `garment-baselines.ts:79-96`. `normalizeBaselineBrand` doesn't sanitize/fence; a crafted brand steers the generated brief, which is *cached* and injected as trusted into every future grade sharing that brand key. (Gated by `GRADING_BASELINES`, default off.) **Fix:** `sanitizeSellerText` before generation; validate/moderate the brief before caching.

### P3
- [ ] Pipeline failure handler refunds a submission whose grade report was already inserted → "refunded + graded" state nothing reconciles — `grading-pipeline.ts:2216-2241`.
- [ ] `finalizeGradeReview` ignores the finalize UPDATE's `{error}` and proceeds to go-live — `grading-pipeline.ts:774-786`.
- [ ] Peer-norm cohort includes non-finalized preliminary grades — `peer-norm.ts:230-238` (add `.not("finalized_at","is",null)`).
- [ ] Eval/dry-run composite legs silently include the live exemplar block, confounding measurements — `ai-grading.ts:1774-1780`, `grading-eval.ts:230-515`.

**Verified clean:** the four-site rounding lockstep holds (all `Math.round(total*10)/10`, weights 0.30/0.25/0.20/0.15/0.10); the frontend never recomputes shipped grades; AI-response parsing is well-clamped; threshold semantics are consistent; exemplar privacy is respected; prompt-version lifecycle (shadow→eval-gate→canary) is enforced.

---

## Database RLS & durable jobs

(The P1 is **the ten dead eBay endpoints** — folded into the summary; details below.)

### P1
- [ ] **Ten eBay endpoints 401 unconditionally (missing from the auth whitelist)** — `main.ts:331-361` vs `flipdesk-ebay.ts` (`analytics/account-health`, `compliance/*`, `finances/payouts*`, `catalog/match|adopt`, `promotions`). These have no `app.use(authMiddleware)` line, so `userId` is never set and the handlers fail closed to 401 — for signed-in users too. All are live SPA call sites. CI misses it because `flipdesk-auth-coverage_test.ts` only checks each router prefix has ≥1 auth line. **Fix:** add the `app.use` lines; longer-term invert the model (wildcard auth + explicit public exceptions) or make the guard diff declared paths vs the whitelist.

### P2
- [x] **Moderation withhold (US-484) bypassed via `public_grade_reports`** — ✅ **CLOSED** by migration `00356_public_cert_moderation_withhold.sql` (US-1654): the view now LEFT JOINs `submissions` and excludes `pending_review` plus flagged-unless-`approved`, mirroring `isCertificateWithheld` exactly. Verified against source 2026-07-19 (US-2089). Original finding: `00318_public_cert_coverage.sql:107-116`. The view gates only on `review_status`, never joining `submissions.flagged`/`moderation_status`, so a finalized-then-flagged certificate the edge endpoints correctly 404 stays readable via PostgREST — and the SPA's own `/cert/:id` reads the view directly, still rendering the withheld grade's score/tier/summary. **Fix:** add the flag predicate to the view (new migration, full column reproduction), or route the SPA through the withhold-aware edge endpoint.
- [x] **User `resume` endpoints reset live `running` jobs to `pending` with no staleness check → double-run** — ✅ **CLOSED** by US-1644: BOTH resume routes (generation `/batch/:id/resume` and publish `/publish-batch/:id/resume`) now return 409 while the batch heartbeat is fresh, and reset only `pending` jobs plus `running` jobs whose own heartbeat is stale. Verified against source 2026-07-19 (US-2089). Original finding: `flipdesk-autolister.ts:1511-1519, 2110-2117`. Resume while a worker is mid-generation → the item is regenerated concurrently (double `reserveAiAction` spend). **Fix:** restrict the reset with `.lt("updated_at", jobStaleBefore)` / refuse resume while the batch heartbeat is fresh.

### P3
- [ ] `ebay-publish-due`, `promoted-sync`, `leave-feedback`, `sync/performance` crons are invisible to the `cron_runs` ledger (no missed-run signal) — `main.ts:523-542`.
- [ ] New measure routes (`flipdesk-measure.ts:668,686`) have no `tenant-isolation_test.ts` cases (correctly scoped today; missing regression net).

**Verified clean:** the US-1108 migration triple on 00343–00352; new tables (`garment_baselines`, `measure_card_requests`, `measure_corrections`) are deny-all + registered in `rls-guard_test`; `SECURITY DEFINER` search_path pinning; the durable-jobs claim/heartbeat/reclaim contract (atomic two-step claims, capped attempts, per-slice heartbeats, partial≠completed); all 41 cron handlers call `requireJobSecret`; zero `.or()` on any UPDATE/DELETE.

---

## iOS — core (auth / networking / persistence / concurrency)

(The P1 is **C8** above.)

### P2
- [ ] **Share-imported photos bypass the compressor and upload at full resolution** — `ShareViewController.swift:133` → `ShareInboxConsumer.swift:6-8`. Original-dimension 3–10 MB JPEGs flow into an uploader tuned for ~700 KB PUTs → 6–20× slower, times out on weak cellular. **Fix:** run `PhotoCompressor`-equivalent downscaling in the extension (also resolves the P1 memory finding). *(Its sibling — the Share Extension decoding full-res images in memory → jetsam — is also P1; see the source notes.)*
- [ ] **Sign-out doesn't clear intake drafts (text + photos), recent searches, or saved filters → next account inherits them** — `ContentView.swift:105-156` sweep vs `IntakeDraftStore` / `PhotoDraftStore` / `RecentSearchStore` / `SavedFilterStore`. Contradicts the US-659/694/1493/1499 isolation posture (everything else *is* wiped). **Fix:** add the four `.clear()` calls to the `.signedOut` branch.
- [ ] **`signOut()` wipes the keychain *before* the SDK sign-out → likely skips the server-side refresh-token revoke even when online** — `Auth/AuthStore.swift:293-307`. `deleteAccount()` (line 325) has the correct order. **Fix:** call `signOut()` first (short timeout) then wipe. *(Worth a 10-min Mac test: sign out online, check GoTrue's `refresh_tokens` row.)*
- [ ] **Queued upload mutations persist an *absolute* tmp path → app update (container relocation) or tmp purge = terminal `missingLocalFile` loss** — `PhotoUploadService.swift:679,700` + `SyncEngine.swift:1430`. **Fix:** persist a path relative to the staging dir; prefer Application Support over purgeable `tmp/`.

### P3
- [ ] `EdgeAPI` response cache isn't tenant-keyed or flushed on sign-out/workspace-switch — `EdgeAPI.swift:384` (latent; no tenant-scoped endpoint is cached *today*).
- [ ] ShareExtension default slot assignment spills into measurement slots after US-1571 reordered the mirror — `ShareIntakeView.swift:32-53` (garment photos default into `measurement_*` types).

**Verified clean:** keychain flags + no tokens in UserDefaults/logs/URLs; `EdgeAPI` retry/backoff/401-refresh/429/timeout machinery; `Task.detached` justification + cancellable poll loops; file-protection classes on all caches.

---

## iOS — feature flows

(The P1 is **C8** above.)

### P2
- [ ] **Sensitive-slot capture race → a tag photo can be uploaded to the public bucket** — `PhotoIntakeView.swift:948-960` + `PhotoIntakeStore.swift:81-86`. Slot-strip taps aren't gated by `isCapturing`, and the capture reads `activeSlot` at completion time. Snap the *tag* (sensitive), tap "Front" before compress finishes → the tag is recorded as `front` and pushed to the **public** `item-photos` bucket, inverting US-979. **Fix:** pin `let slot = store.activeSlot` synchronously before the `Task`.
- [ ] **Reconciliation "Create item" is not idempotent (no client id) → duplicate inventory items on retry** — `ReconciliationService.swift:70-116`. Every other create path mints a client id and upserts; this one inserts. **Fix:** generate `id` client-side + upsert.
- [ ] **Successful publish: toolbar Close / swipe-dismiss skip `onPublished` → item stays "unpublished" locally** — `PublishDialog.swift:286-288` + `ItemCanvasView.swift:395-405`. Reintroduces the US-1513 desync post-success → seller may relist. **Fix:** call `onPublished(response)` from Close and the swipe path.
- [ ] **Cancellation/dispute decisions lack the US-1497 in-flight re-entry guard that returns/refunds got** — `PostSaleStore.swift:121-157`. Slow network → "Approve & cancel" fires twice for the same order. **Fix:** reuse the `decidingReturnIds` pattern keyed on `cancelId`/`paymentDisputeId`.
- [ ] **Publish composer inline price fix (US-1242) never persists** — `ListingDraftService.swift:105-171` (UPDATE branch drops `listing_price`) + `flipdesk-ebay.ts:8294` (validate unconditionally blocks, making the field unreachable). **Fix:** write `listing_price`/`target_price` in the UPDATE branch; fix the false "saved when you publish" copy.
- [ ] **24h stale-temp sweep deletes staged JPEGs that queued offline mutations still reference** — `PhotoUploadService.swift:762-774`. Capture offline (rural/flight), stay offline >24h → the sweep deletes the bytes → every queued upload lands stuck, unrecoverable. **Fix:** skip files referenced by any pending `.uploadPhoto` mutation.
- [ ] **Possible double-resume crash in `TagTextRecognizer`** — `Vision/TagTextRecognizer.swift:39-76`. When `perform` fails, Vision can invoke the completion handler *and* throw, resuming the same `CheckedContinuation` twice (process abort). On the tag-OCR fallback path of every intake. **Fix:** one-shot resume guard.

### P3
- [ ] Upload progress UI is dead plumbing (no session delegate; progress stays 0%) — `PhotoUploadService.swift:51-59,404-412`.
- [ ] `.accurate` OCR runs synchronously inside an `actor` method, blocking a cooperative-pool thread — `TagTextRecognizer.swift:70-76`.
- [ ] Disk-full capture is silently dropped (no task, no error, no telemetry) — `PhotoUploadService.swift:211,735-746`.
- [ ] `countOrphans` downloads every unmatched row to count them (use `count:.exact, head:true`) — `ReconciliationService.swift:33-43`.

**Verified clean:** Negotiation, grading-submission polling (cancel-on-dismiss), AutoLister give-up/Resume, `Money`/`CurrencyFormatter` (Decimal-summed, NaN-guarded, RFC-4180 CSV), CameraSession self-heal, PhotoCompressor memory handling, Speech/Intents/Automations/Team/Sales/Fulfillment.

---

## Suggested sequencing

1. **Week 1 — Critical (C1–C9).** Mobile-billing fraud/revenue (C1, C2, C5, C6, C7), the workspace-role gate (C3), the sign-out cache clear (C4), the iOS upload-queue persistence (C8), and the grading auto-finalize gate (C9). These are the launch-blockers.
2. **Week 1–2 — the ten dead eBay endpoints** (P1, `main.ts` whitelist) and the **moderation-withhold view bypass** (P2, one migration) — both are small, high-impact fixes.
3. **Week 2 — Web P1 cluster** (workspace query keys, double-submit guard, EXIF double-rotation, photo-step-back loss, realtime phantom keys, missing invalidations). Mostly localized, high user-visible payoff.
4. **Week 2–3 — iOS P2 cluster** (sensitive-slot race, idempotent reconciliation create, publish-dismiss desync, in-flight guards, offline-file survival).
5. **Ongoing — P2/P3 hardening and the test-coverage gaps** (workspace/notifications/verified tenant-isolation cases; the auth-coverage guard generalization; the `flipdesk-ebay.ts` targeted sweep).

## Verification notes

- Every finding cites `file:line` with quoted evidence; the Critical items and all P1s were independently re-verified against source. Items marked *medium/low confidence* (the iOS `signOut()` ordering, the `TagTextRecognizer` double-resume) depend on third-party SDK/framework behavior and are flagged with the specific check to run.
- Several findings note the codebase's *own* correct pattern to copy from (e.g. `use-consignors.ts` for user-keyed query keys, the Stripe route's dead-letter policy for the App Store webhook, `PhotoCompressor.compressBatch` for the Share Extension) — fixes should mirror those rather than invent new machinery.

## Related

- [[archive-semantics]] — the extract-open-findings rule this tested
- [[guards-that-cannot-fail]] — the defect class several findings shared
- [[INDEX]]
