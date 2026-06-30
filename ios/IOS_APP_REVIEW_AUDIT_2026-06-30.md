# iOS App Review Deep-Dive Audit — 2026-06-30

Goal: find every lingering bug that could cause another App Store rejection. Eight
parallel read-only audits swept the app by bug-class. iOS CI is **green on `main`**,
so the defects App Review keeps finding are **runtime/UX bugs unit tests don't catch** —
exactly what this static-analysis sweep targets. Findings are bundled into
`prd.json` stories **US-1405…US-1412**.

Severity: **CRITICAL** = blocks review / charged-without-entitlement · **HIGH** =
reproducible dead-end or unreachable action · **MEDIUM/LOW** = robustness.

---

## US-1405 — StoreKit / IAP / Paywall (the 2.1(b) reject)
- **CRITICAL** `App.swift:59-66` — `Transaction.updates` listener started in ContentView's `.task` *after* an `await`, not at process launch → transactions resolved during launch (deferred / Ask-to-Buy / refund / interrupted) can be missed → **charged but not entitled**.
- **HIGH** `StoreKitService.swift:86-102,104-110` — `Product.products(for:)` has **no timeout** → StoreKit stall leaves the paywall on an infinite spinner (the exact 2.1(b) reject pattern).
- **MEDIUM** `StoreKitService.swift:115-117` — foreground consumable purchase reports to server once (no retry) then `finish()` unconditionally; a consumable is never redelivered → credits may never grant.
- **MEDIUM** `PaywallStore.swift:288-290` — post-purchase plan refreshed only from the lagging server `users` row → purchased tier still shows a buy button → confused re-purchase.
- **LOW** `GradeThread.storekit:51-53` — placeholder `_developerTeamID`, `_failTransactionsEnabled:false` → failure/Ask-to-Buy paths never locally tested.
- **Clean:** restore purchases, terms/privacy/manage-subscription links, `.verified`/`.unverified` handling, empty-products → recoverable retry, stripe-conflict routing.

## US-1406 — Auth: email-unverified actionable message everywhere (re-introduced 2.1 reject)
- **CRITICAL** `FriendlyErrorCopy.swift:120-129` + `DetailsIntakeView.swift:583` + `PhotoIntakeView.swift:934` — `EdgeAPIError.emailUnverified` is string-matched to `.emailNotConfirmed`, which returns the bare fallback → **"Couldn't save your item. Try again."** dead-end on the save path. Re-introduces the 2.1 reject in a new location (AI/grade paths surface it correctly).
- **HIGH** `EbayPublishService.swift:190-191,221-224` — every 403 → "session expired, sign in again," masking `email_unverified` & `workspace_access_revoked`.
- **MEDIUM** `AuthStore.swift:248-256` — `deleteAccount()` doesn't `AppleCredentialMonitor.clear()` (signOut does) → stale Apple id → later spurious logout.
- **MEDIUM** `LoginView.swift:81-93,269-272` — "Confirm email/Resend" card only in `.signIn` mode.
- **LOW** `AppleCredentialMonitor.swift:43-48` + `ContentView.swift:281-289` — transient `.notFound` treated as revoked → surprise logout; only sign out on `.revoked`.
- **Clean:** 401-refresh loop bounded, keychain, in-app account deletion (5.1.1(v)), Sign in with Apple + nonce.

## US-1407 — Network hangs / dead-end load states (SYSTEMIC)
Root: prior audit fixed `URLSession.shared` *call-sites* but missed the **default-argument form** `session: URLSession = .shared` (60s timeout) in ~11 services.
- **CRITICAL** `EbayCategorySpecificsView.swift:29-33` + `SpecificsEditorModel.swift:221` — `.failed` is a bare Label with **no retry**; `start()` fires once → stranded.
- **HIGH** default-arg `= .shared`: `EbayAspectsService:24`, `CompsService:37`, `ScoutService:28`, `ProspectService:23`, `RepricingService:42`, `EbayPublishService:14`.
- **MEDIUM** `GradingService:17`; AI services should use `aiSession`: `ListingCopyService:49`, `NegotiationDraftService:46`, `AnalyticsNarrativeService:53`. `ReconcileIntakeStore.sync():34` no re-entrancy guard.
- **LOW** missing re-entrancy guards: `CommunityInsightsStore:52`, `ProfileStore:51`, `PlanStore:59`, `ReferralsStore:54`, `RepricingRulesStore:33`.
- **Prevent regression:** add CI grep for `URLSession = .shared`.

## US-1408 — Camera viewfinder freeze after backgrounding/interruption
- **HIGH** `PhotoIntakeView.swift:103-143`, `BarcodeScanView.swift:32-33` — no `scenePhase` observer and no `AVCaptureSessionWasInterrupted/interruptionEnded/runtimeError` handling. iOS auto-stops the session on background/call/Control Center and doesn't resume; the view survives in `fullScreenCover` so `.task` doesn't re-fire → **permanently black viewfinder with a dead shutter**.
- **LOW** `GradedPhotoView.swift:218-224` — "Save to Photos" denied has no "Open Settings" button.
- **LOW** `TagPhotoQuality.swift:24-27` — stale comment (2048px vs actual 1600px).
- **Clean:** permission deny → explainer + Open Settings + library fallback, usage strings synced, EXIF strip, rotate fix, off-main downsample.

## US-1409 — Grading: drive pending-review/cert from server state, not raw confidence
Root: client re-derives "pending review" from confidence / missing cert URL.
- **HIGH** `GradeReportView.swift:22-46` + `GradingTypes.swift:117` — client treats `confidence<0.75` as pending; server auto-approve floor is 0.9. A human-**approved** `<0.75` grade is finalized with a real `certificate_id`, but the view shows "Pending human review" and **suppresses Share Certificate**.
- **HIGH** `LocalInventoryItem.swift:165-167` — `isGradePendingReview = graded && cert URL empty`; but finalized grades legitimately have a null cert (moderation-withheld US-484, or supersede-nulled) → shown "Pending review" **forever**, excluded from counts.
- **MEDIUM** `GradeRequestStore.swift:267-279` — optimistic stamp keys pending on cert-URL presence → just-completed certified grade flashes "pending."
- **LOW** `GradeRequestStore.swift:71,261` — comment "~2min" but `maxPolls=40` ≈ 5min.
- **Clean:** poll terminal-state ordering, submit/poll cancel on dismiss, decode tolerance, AIExtract upload-wait/OCR fallback. iOS displays server `overall_score` (no client rounding).

## US-1410 — Cold-launch deep-link / App Intent / onboarding route drops
- **HIGH** `ContentView.swift:209-215,242-259` + `GradeThreadAppIntents.swift:34,50` — App Intent posts a `DeepLinkRouter` route synchronously in `perform()` before `ContentView` subscribes; no replay → **"Snap to value" lands on a bare dashboard**. Apple tests App Shortcuts.
- **HIGH** `ContentView.swift:73-88,216-227` — deep links swallowed while the onboarding `fullScreenCover` is up; `consumeOnboardingFirstAction` clobbers the route → fresh-install widget/universal-link dead-ends.
- **MEDIUM** `ContentView.swift:643-660` — `sharedIntakeBatch` + `planStep` both `fullScreenCover` on `MainShell`; both set on a fresh sign-in → second silently fails to present.
- **MEDIUM** `GradeThreadWidget.swift:49-54` — `getSnapshot` shows fake `$312` placeholder financials to a real signed-out user.
- **MEDIUM** `ContentView.swift:869-880,889-967` — single `@SceneStorage("shell.focusedItemId")` shared across tabs → restore re-pushes item onto wrong section.
- **LOW** `ContentView.swift:1119-1121` (iPad blank-detail latent trap); `BackgroundRefreshService.swift:143-166` (budget never enforced).
- **Clean:** AASA/universal links, orientation, share-extension edge cases, multi-window manifest, warm-path deep-link queue.

## US-1411 — Accessibility (the class Apple rejects for)
- **HIGH** `AutoListerView.swift:218,222-262` — photo actions only via `.contextMenu` → **unreachable by VoiceOver/Switch Control**. Add `.accessibilityActions` (pattern in `EbayAccountsView.swift:181`).
- **HIGH** `EbaySyncModal.swift:100,148,184` — status glyphs fixed `.font(.system(size:48/44))` ignore Dynamic Type → use `scaledIconFont`.
- **HIGH** `EbaySyncModal.swift:98/146/176` — phase swaps with no VoiceOver announcement and no `.isModal` → add `A11yAnnounce` + `.isModal` (WCAG 4.1.3).
- **MEDIUM** sub-44pt tap targets: `MarketplacesView.swift:565-602`, `EbaySyncModal.swift:131/163/198`; fixed icon sizes `MarketplacesView.swift:193-198,399-404,431-436,481-483`, `EbayCategorySpecificsView.swift:285`; `RepricingRulesView.swift:129,187` (unlabeled toggle, no `.isButton`); `RuleEditorSheet.swift:101-109` (unlabeled field, clipping width).
- **LOW** `MoneyView.swift:429-437`, `RepricingView.swift:85-101`, `MoneyMath.swift:21` (NaN guard).
- **Clean:** marketplace OAuth (ASWebAuth cancel/fail, callback allowlist), publish (typed outcomes + retry), money math (guarded divisions, exact-Decimal, locale currency).

## US-1412 — Crash/robustness hardening
- **MEDIUM** `ReconcileIntakeService.swift:115` — `components.url!` after raw-interpolated path; the only force-unwrapped `components.url` in the app → `guard let` / `StorageURL.object`.
- **MEDIUM** release-config gate — `AppConfig.swift:13/26/35` `fatalError` on missing/placeholder `SUPABASE_URL`/`ANON_KEY`/`EDGE_API_URL` → **100% launch crash** on a misconfigured archive (the most likely real source of any reviewer "crashes on launch"). Add a CI/release assertion.
- **MEDIUM** `BackgroundRefreshService.swift:143-166` — declared `budgetSeconds=25` never enforced; race `engine.sync()` against a timeout.
- **LOW** `MoneyMath.swift:21` NaN guard; `TagPhotoQuality.swift:24-27` comment.
- **Crash sweep verdict:** the codebase is **defensively clean** — `Tolerant.swift` enum decode, `StorageURL` nil-safe, bounds checks everywhere, FP division → `.nan` (no traps), no `try!`/`as!`, correct SwiftData threading.

---

### Method note
Audits were static (no macOS toolchain in this environment). Items marked
Mac/simulator-gated (camera interruption, scene restoration, VoiceOver walk-through)
need a device/simulator pass to confirm the fix. The release-config gate (US-1412)
and the `URLSession = .shared` lint (US-1407) are CI-enforceable on any host.
