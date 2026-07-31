---
title: Ralph iOS working log
type: learning
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [agent, ralph, ios]
summary: iOS-specific gotchas accumulated by the loop; loaded on demand, not every iteration.
---

> [!info] Loaded on demand, not every iteration
> Split out of the main playbook so its bulk is not re-read every loop — read it
> only when the story touches iOS. That selective-loading pattern is the same
> one the vault index uses, and it predates the vault.
# Ralph Learnings — iOS (Swift)

Read this IN ADDITION to LEARNINGS.md when your story touches ios/. Split out of LEARNINGS.md so the ~314 lines of Swift-specific detail are not re-read on every non-iOS iteration.

## iOS (Swift)
- The eBay publish `/listings/validate` summary already carries MORE than iOS
  reads (quantity, bestOffer*, format/auction*, variations; plus sibling
  `warnings`/`recommendedCoverage`) — the iOS↔web composer gaps are missing UI,
  not missing server work. But its threshold/rate values are RESOLVED (often
  comp-derived), not the seller's override columns: seed an editable box from the
  `listings` override column (blank = "use the suggestion") and show the resolved
  value only as a PLACEHOLDER. Seeding the box with the resolved value pins a
  dynamic suggestion into the override column on the next save (US-1970; same
  trap as US-1512's promo rate). Corollary: after saveDraft, advance the seed
  baseline from what you just wrote (a pure `applying(edits)`) — a re-seed from a
  stale baseline silently reverts typed values on a push-failure retry (US-1006).
- The publish composer's dirty check REBUILDS its seed baseline on every render
  (`isDirty` calls `seeded*(summary:settings:)`), so any seeded value type
  carrying a fresh identity — `let id = UUID()` for a `ForEach` row — must
  EXCLUDE that id from `==` (US-1975 `ComposerVariant`). A synthesized Equatable
  latches the dirty ratchet permanently on first render: swipe-dismiss blocked
  and a "save your edits?" prompt on a composer nobody touched.
- An IMPLICIT save in the publish composer (US-1972 background autosave, or any
  future one) must pass `schedule: .unchanged` / skip entirely — persisting
  `scheduled_publish_at` ARMS the scheduled-publish worker, so a save the seller
  never confirmed puts the item live. Best Offer/promo/text carry no such
  autonomous side effect and are safe to bank. Corollary: an implicit save whose
  edits differ from what a full save would write must not bump the composer's
  `.id` (it re-seeds from the baseline and reverts the uncommitted control).
- The AutoLister picker is configured WITHOUT a `photoLibrary:` (US-1013: no
  permission prompt), so `PHPickerResult.assetIdentifier` — and therefore
  `creationDate()`'s PHAsset lookup — is ALWAYS nil. `loadObject(ofClass:
  UIImage.self)` drops EXIF too, so until US-2373 every imported photo was
  stamped `.now` and no photo in a library import ever had a real capture time.
  The fix that works without any permission: load the pick's DATA
  representation (`loadDataRepresentation`, picker set to `.current` so there's
  no transcode) and read `DateTimeOriginal` off it —
  `PHPickerResult.loadImageWithCaptureDate()` / `ImageCaptureDate`. Reach for
  that, not for library access, when a flow needs capture times.
- `PhotoCapture.capturedAt` is NON-optional and `AutoListerReviewModel.importPicks`
  fabricates `<real capture time> ?? .now`. That silently defeats every
  timeless-dump signal: a no-EXIF batch looks like ONE instantaneous EXIF burst,
  and time-gap clusters are deliberately EXEMPT from the mega-group guards
  (`maxAutoGroupPhotos`/`visualMergeOrdinalWindow`), so it grows unbounded and the
  filename-sequence + propose-groups paths never run. US-1909 tracks the
  fabricated ones in `timelessIds` and passes `capturedAt: nil` to
  `GroupablePhoto`. Any new iOS photo intake must preserve "the library gave no
  date" — don't collapse it into `.now` and assume grouping still works.
- The two intake draft stores are INDEPENDENT by design (US-1234): details-first
  `DetailsIntakeView` owns only `IntakeDraftStore`, photo-first `PhotoIntakeView`
  owns only `PhotoDraftStore`; the flows have separate entry points and never
  co-create both drafts for one item. Each already clears its OWN draft on
  save/discard. Do NOT make one flow cross-clear the other's store — a pending
  photo draft belongs to a SEPARATE still-unsaved photo-first session, so
  clearing it from a details-first save discards the user's captures. Locked in
  by `IntakeDraftCleanSlateTests`; an audit may re-flag this as a "desync bug" —
  it isn't.
- Adding a property to a `@Model` in `Persistence/Models/` does NOT need a
  `GradeThreadSchemaVN` bump — and adding one the naive way CRASHES launch. A
  `VersionedSchema.models` list resolves to the LIVE classes, so a V2 that
  re-lists the same (edited-in-place) classes hashes identically to V1 and
  SwiftData aborts on every device with "Duplicate version checksums" — exactly
  what US-1249 did. Pre-production there's no deployed store, so an additive
  change just rides `GradeThreadSchemaV1` (a fresh install creates it directly);
  `SchemaVersioningTests` only asserts the model-NAME set + plan consistency, so
  it stays green. A REAL new version requires first snapshotting the OLD shape as
  distinct nested types inside V1 (see the trap comment atop
  `Persistence/GradeThreadSchema.swift` — it's the authority, not this file).
  Additive optionals (US-1973's `LocalListing.quantity`) get an implicit nil
  default, so the existing `init` needs no change.
- Adding a field to a decode-only `struct` (e.g. `ValidateResponse`) silently
  breaks its SYNTHESIZED memberwise init at every construction site — tests and
  previews build these positionally (DraftsTests builds ValidateResponse). Swift
  doesn't compile on the Windows loop host, so it only fails on iOS CI. Give the
  struct an EXPLICIT init whose new params default to nil (US-1974), and grep
  `TypeName(` across GradeThread + GradeThreadTests before adding the field. Same
  for a custom `init(from:)`: declare `CodingKeys` explicitly (every peer in
  EbayPublishTypes.swift does) rather than relying on synthesis.
- Adding a DEFAULT-valued associated value to an existing enum case is fully
  backward-compatible: `case rateLimited(retryAfter: TimeInterval? = nil)` lets
  every bare `.rateLimited` CONSTRUCTION keep compiling (default fills in) AND
  every value-less `case .rateLimited:` MATCH still matches (ignoring the
  payload), and synthesized `Equatable` still derives. That's how US-1253
  carried the 429 `Retry-After` onto `EdgeAPIError.rateLimited` without touching
  the ~6 existing call/match sites — contrast the `.badRequest(detail:)` case in
  US-1255 where adding values would have broken dozens of matchers.
- `@SceneStorage` is keyed by string and SCENE-scoped (per iPad window): a child
  view and the shell can share per-scene state by declaring the SAME key (US-1157
  `shell.focusedItemId` — `ItemCanvasSceneHost` writes it, `MainShell` restores
  it). Value type must be a scalar / `RawRepresentable<String|Int>`; making
  `AppSection` restorable meant adding a `String` raw value (keep raws stable —
  they're persisted). Restore once per scene (guard a `@State` bool in `.task`).
- `BulkPricingStore.PriceMode` (Marketplaces/BulkPricing) now has a 4th case
  `.suggestFromComps` (US-1167 AC2): per-row comp-median prices fetched via the
  injected `CompsProviding` (`suggestFromComps()`), applied through the same
  `.set` floor in `apply()`. Adding ANOTHER PriceMode case breaks the exhaustive
  switches in `priceValue` + `priceInputError` + `priceActive`. The store takes
  an optional `comps:` init param (defaults to `CompsService()` built in the
  MainActor init body, like `CompsStore`) so tests inject a title-keyed fake.
- Adding a new `SyncWatermark.Table` case (US-1221 `.listings`) needs NO
  `currentSchemaVersion` bump: a never-set cursor reads nil → the first pull is a
  full fetch for that table automatically, then deltas. Bump the version ONLY
  when an EXISTING install must re-backfill an already-synced table. Server-side
  deletes never arrive via a watermark delta (it only returns surviving rows), so
  delete propagation is a separate concern — `SyncEngine.reconcileDeletesIfDue`
  (throttled id-only fetch) prunes locals absent from the server set, protecting
  pending-create + staged-upload ids (`protectedReconcileIds`).
- Two DIFFERENT decoders on iOS: the EdgeAPI decoder converts snake→camel
  (`.convertFromSnakeCase`), but the supabase-swift PostgREST client
  (`supabase.from(...).select(...).execute().value`) does NOT — decode its rows
  with EXPLICIT snake_case `CodingKeys` (see `RemoteMarketplaceConnection`,
  `ListingPerformanceRow`). Keep timestamp columns as `String` and parse at the
  display boundary (fractional seconds break the default ISO date strategy).
- The EdgeAPI decoder (`JSONDecoder.iso8601`) uses `keyDecodingStrategy =
  .convertFromSnakeCase`, which camelCases NESTED free-form jsonb keys too — so a
  passport `sku_class.garment_type` decodes as `garmentType`. When reading
  arbitrary jsonb from an EdgeAPI response into a `[String: …]` dict, look up both
  forms (`dict["garmentType"] ?? dict["garment_type"]`). Also keep edge timestamps
  as `String` (the edge emits fractional seconds, which the default `.iso8601`
  date strategy REJECTS) and format at the display boundary.
- Plan-gate UX is centralized (US-805): `EdgeAPI.interceptPlanSignals` decodes a
  402 `PlanGateError` body + the `X-Plan-Warning` header on EVERY response and
  publishes to `PlanGateNotifier.shared` (`nonisolated static let publish*`
  bridges hop to MainActor), which the shell renders via `.planGatePresentation()`
  (UpgradePromptView sheet + soft banner). So any call through `EdgeAPI.shared`
  gets the upgrade prompt for free. The eBay publish path uses its OWN client
  (`EbayPublishService`, not EdgeAPI), so it publishes to the notifier itself in
  the 402 branch — don't assume EdgeAPI's interceptor covers it. Soft-banner
  sensitivity = `AppPreferences.usageAlertThreshold` (50/80/95).
- Adding a case to `PublishOutcome` (EbayPublishTypes.swift) breaks every
  EXHAUSTIVE switch: `BulkActionExecutor` (×4: validate/push/end/price),
  `PublishDialog` (×2), and `DraftsBulkEditStore` + `DraftsLibraryStore`
  `publishSelected`. The `ReviseOutcome` switches (ItemCanvasView/
  PhotoManagerView) and the grading-result enum are SEPARATE — don't touch them.
  Edge plan-gate (plan-gate.ts) returns 402 with `{error:"CAP_REACHED"|
  "FEATURE_LOCKED", cap, used, limit, requiredPlan}`; parse it via `PlanGateBody`
  (US-820) and stop the bulk loop on `.planLimit` (every further publish 402s).
- SwiftData's `#Index` / `#Unique` macros are **iOS 18.0+** only (they carry
  `@available(iOS 18, *)`); they cannot live in a `@Model` body compiled for a
  lower deployment target. US-985 raised the floor to iOS 18 in `project.yml`
  (`deploymentTarget.iOS` + `IPHONEOS_DEPLOYMENT_TARGET`, two places) so the
  cache models can declare `#Index`. Note the models still use the iOS-17-era
  `@Attribute(.unique)` (NOT the `#Unique` macro) for the `id` uniqueness — the
  unique constraint already indexes `id`, so don't add a redundant `#Index([\.id])`.
  Adding `#Index` is an automatic lightweight migration (no SchemaMigrationPlan
  needed) and is non-destructive.
- `Money.cents(_:)` (Money/MoneyMath.swift) is the shared cents-normalization
  primitive — `NSDecimalRound .plain` to 2dp, returned as `Double`. Route ANY
  single money value through it at a boundary that must agree with the drift-free
  rollups to the cent (listing price before push, a profit estimate shown beside
  the Money tab). The Money tab rounds each sale's realized net via `Money.sum`
  over `SalePnL.net`; a composer estimate matches it only if its displayed net is
  `Money.cents(net)` — raw Double + `%.2f` can disagree on .xx5 boundaries
  (NSDecimalRound rounds half-away, printf rounds half-even). Keep
  `ListingProfit.estimate` itself raw (it mirrors the web `estimateListingProfit`
  field-for-field); round only at the display boundary (`netCents`/`feesCents`).
- A row price stored as a String that a user edits in a `.decimalPad` is in the
  user's LOCALE separator ("19,99" in de_DE) — parse it with
  `CurrencyFormatter().parse`, never `Double(_:)` (which is "."-only → nil → $0,
  silently skipping the "Price not set" check). The seeded/echoed string MUST
  also be locale-formatted (US-1236 `DraftEditRow.priceString`/`priceString2dp`
  go through a locale `NumberFormatter`, not `String(format:"%.2f")`) or the
  parse misreads a canonical "." seed as grouping (de_DE "19.99"→1999). Seed,
  bulk-write, and parse must all use the SAME locale convention to round-trip.
- Dynamic-Type-scale an SF Symbol glyph with `.scaledIconFont(size:weight:relativeTo:maxSize:)`
  (Accessibility/ScaledIconFont.swift) — NOT `.font(.system(size:))`, which pins
  the glyph to a fixed point size that ignores accessibility text settings. There
  is no `Font.system(size:relativeTo:)`; the modifier wraps `@ScaledMetric`. Pass
  `maxSize:` for glyphs inside a fixed-size frame so they grow but can't overflow
  it at AX5. Reuse it for interactive icon buttons; leave large decorative
  empty-state icons alone.
- The iOS app has NO checked-in `.xcodeproj` — it's generated by XcodeGen from
  `ios/project.yml`, whose `sources:` are directory paths (`GradeThread`,
  `GradeThreadTests`). New `.swift` files under those dirs are auto-included; do
  NOT hand-edit a pbxproj. Not buildable on Windows — gates on iOS CI.
- Edge 4xx error bodies are `{error, detail?, error_code?}`; iOS `EdgeAPIError.from`
  sets `.badRequest`'s `detail` to `detail ?? error ?? preview`. So a 409 like
  `{error:"ACTIVE_STRIPE_SUBSCRIPTION"}` (no `detail`) surfaces as
  `.badRequest(detail:"ACTIVE_STRIPE_SUBSCRIPTION")` — match on that string to
  branch (US-806 routes it to web billing). No dedicated EdgeAPIError case.
- `EdgeAPIError.from` DISCARDS the `error_code` discriminator for the generic 4xx
  cases (only workspace/email get typed cases), so a thrown EdgeAPIError can't
  tell self-referral (400) from already-referred (409) — both collapse to
  `.badRequest`. To branch on a domain `error_code` on iOS, call the raw
  `EdgeAPI.postForStatus(path:bodyData:)` (returns `(status, body)` without the
  retry/refresh loop) and decode the code yourself — don't add associated values
  to the shared enum's cases (dozens of `.badRequest(detail:)` call sites + the
  `case .badRequest(let detail)` matchers would break). US-1255 redeem.
- StoreKit native sub management (US-806): `.manageSubscriptionsSheet(isPresented:)`
  (SwiftUI, iOS 17+, target is 18) is the system cancel/auto-renew sheet — no
  scene plumbing needed; refresh billing in `.onChange(of:)` when it dismisses.
  Renewal date + auto-renew come from `Transaction.currentEntitlements` (filter
  `.autoRenewable`; `expirationDate` + `try? await transaction.subscriptionStatus`
  → `.renewalInfo.willAutoRenew`). Upgrade/downgrade is just buying another tier
  in the same group via the normal purchase path.
- iOS error→UI copy: reuse `FriendlyErrorCopy` (Telemetry/) — maps raw
  Supabase/URLError failures to friendly copy (offline/invalid-creds/
  email-not-confirmed/rate-limited/generic) + a `rawDetail` flattener for Sentry.
  Never surface `error.localizedDescription` on user-facing screens; log raw to
  `Telemetry.breadcrumb`/`event` at the call site instead.
- To memoize an expensive SwiftUI computed property (full filter/sort, facet
  derive) across `body` re-renders, store a PLAIN `final class` cache in `@State`
  (NOT `@Observable`/`ObservableObject` — those would re-invalidate the view).
  Mutating its internal memo during `body` is safe (doesn't schedule an update);
  key the slot on a cheap `Hasher`-built signature of the inputs (for `@Model`
  rows: `count` + each `id`+`updatedAt`). See `InventoryDerivation` (US-1017).
  Lighter variant for a plain lookup/series (no instrumentation needed): hold
  the result in `@State` and rebuild it in `.onChange(of: signature, initial:
  true) { … }`, where `signature` is a cheap `Hasher`-built `Int` over only the
  fields the derive reads. `initial: true` populates on first appearance. Used
  for MoneyView.titlesByItemId, DashboardView.trendPoints, ItemCanvasView
  measurements + the editable-field onChange key (US-967) — the last replaced a
  per-render `ItemDraft(from:)` (two `CurrencyFormatter` calls) with a raw-Double
  signature.
- Base URLs MUST be https: `AppConfig.validatedHTTPSURL` rejects non-https and
  the accessors fatal-error (US-1008). `ios/Scripts/check-ats.py` (runs in
  ios-ci.yml after `xcodegen generate`, also locally on Windows) fails on any ATS
  relaxation key in a plist/project.yml OR a non-https SUPABASE_URL/EDGE_API_URL
  in an xcconfig. xcconfig escapes `//` in URLs as `/$()/` — the script strips it.
- Offline writes go through `OfflineMutationQueue` (Persistence/, US-982):
  `shouldQueue(error)` = `FriendlyErrorCopy.isOffline` (queue ONLY true network
  failures, never 4xx/RLS — those replay forever); `enqueueCreate` injects a
  client `id` so the SyncEngine replay UPSERTs idempotently. Adding a
  `MutationKind` case means updating TWO exhaustive switches or the build breaks:
  `SyncEngine.apply` AND `PendingChangesView.title`. Creates carrying a client id
  must replay via `replayUpsert` (not `replayInsert`) for exactly-once.
- Offline-gating a network-only button (US-981): read `@Environment(NetworkMonitor.self)
  private var networkMonitor: NetworkMonitor?` (optional — nil in previews/tests), gate with
  `NetworkMonitor.isOffline(networkMonitor)` and show `OfflineNotice(intent:.blocked,detail:…)`
  (both in Networking/OfflineNotice.swift). Reading `.isConnected` from `body` re-enables the
  button automatically on reconnect (no stream needed). NetworkMonitor is injected once at
  ContentView root, so every sheet/canvas under MainShell inherits it. DON'T gate offline-queue
  paths (Add Expense, item create/edit, photo upload) — those durably queue (US-982); use
  `intent:.queued` and leave the button enabled.
- Action feedback convention: FlipDesk `@MainActor @Observable` stores expose
  `actionError: String?` (view shows an alert) + `actionBanner: String?` (view
  shows a transient brandNavy capsule overlay via `.task(id: banner)` 2.5s
  auto-dismiss). Reuse this pair for new success/error feedback instead of a new
  toast type. `HapticFeedback` is a same-module `@MainActor` enum — call its
  `.success()/.warning()/.error()` straight from a store method (no import); the
  XCTest host instantiates the UIKit generators harmlessly.
- Full-screen "couldn't load" / `.failed` states use the shared `ErrorStateView`
  (Components/, US-971): `ContentUnavailableView` + a `.brandSecondary` "Try again"
  that shows its own spinner; the parent store clears the error by moving its
  phase off `.failed`. Optional `secondaryTitle`/`secondaryAction` (e.g. "Back").
  Pass `retry:` with an EXPLICIT label — a bare trailing closure binds to the
  optional `secondaryAction`, not `retry`, and won't compile.
- Keyboard dismissal for `.decimalPad`/`.numberPad` fields (no Return key) uses
  the shared `.keyboardDoneToolbar()` modifier (Components/KeyboardToolbar.swift,
  US-969) — resigns first responder via UIApplication.sendAction, so it's
  field-agnostic (no `@FocusState` to thread). Apply it ONCE per screen at the
  Form/List/ScrollView root: SwiftUI AGGREGATES `.keyboard`-placement toolbars
  across the responder hierarchy, so applying on multiple fields (or both a
  parent and child) renders DUPLICATE "Done" buttons. A `.decimalPad` field
  inside a SwiftUI `.alert` can't take a keyboard toolbar — it's already
  dismissable via the alert's buttons, so skip it. Pair scrollable forms with
  `.scrollDismissesKeyboard(.interactively)`.
- A SwiftData `#Predicate` comparing an OPTIONAL column to a value needs both
  sides optional, or the macro's `==` can't type-match: bind the target as
  `let target: String? = value` then `#Predicate { $0.optCol == target }` (not a
  bare non-optional literal). See `mergeDisputes` (US-819, SyncMergeActor).
- supabase-swift `.update(payload)` with an `Encodable` struct OMITS nil optional
  fields (synthesized Codable uses `encodeIfPresent`), so a nil never clears a
  column and an all-nil body is a no-op. To clear/restore a column to NULL, give
  the payload a custom `encode(to:)` that `encodeNil(forKey:)` for that field
  (see `SourceStore.setArchived`/`updateSource`, US-814).
- To filter a PostgREST column IS NULL, use `.is("col", value: nil)` — the
  supabase-swift 2.x signature is `func is(_:String, value: Bool?)` and `nil`
  emits `is.null` (verified against source; US-1271 `FulfillmentService`). For
  IS NOT NULL pass `value: true`/`false` semantics don't apply — use `.not("is",
  ...)` if ever needed. Place `.is` in the filter chain before `.order`/`.limit`.
- A "clear prior default, then write the new one" pair on a table with a
  single-default partial UNIQUE index MUST be atomic, or a failed write leaves
  zero defaults (the clear can't follow the write — the index rejects a 2nd
  is_default=true row). Fix = one plpgsql RPC (clear + insert/update in the
  request transaction; a write error rolls the clear back). SECURITY INVOKER so
  RLS still scopes it. US-1265 `create/update_listing_template` (00317). Call
  via `.rpc(name, params:).execute()` then decode `res.data`. PostgREST resolves
  an RPC OVERLOAD by the exact SET of argument-name keys you send — `create_*`
  takes no `p_id`, so send a struct WITHOUT it (an extra/missing key picks the
  wrong overload or 404s); params have no SQL defaults, so encode nil optionals
  as explicit JSON null (custom `encode`, not `encodeIfPresent`).
- Money-tab financial analytics (US-812: inventory-aging, time-on-market,
  cash-flow, per-item P&L) live in PURE `Money/MoneyAnalyticsRollup.swift`
  (unit-tested, no view math); ROI-by-source reuses `SourceROIRollup` (shared
  with `AnalyticsView`). The Money tab and the Home→Analytics tab are SEPARATE
  surfaces that both render rollups over the same `@Query` arrays — extend the
  rollup, don't duplicate the arithmetic in a view.
- In-flow grade-credit top-up (US-809): both grading stores own a shared
  `CreditTopUpFlow` (`Grading/CreditTopUpFlow.swift`, `@Observable @MainActor`) —
  a poll/re-validate machine that, after an inline `CreditPackSheet` purchase,
  polls `PaywallStore.liveBillingFetcher()?.credits` with bounded backoff until
  the async grant (`/appstore/verify` → `grant_appstore_credits`) lifts the
  balance > baseline, then re-validates so submit unblocks. `fetchBalance`/`sleep`
  are injected (no-op sleep in tests) and `revalidate` is passed per-call, so the
  machine is unit-tested with no StoreKit/Supabase (CreditTopUpFlowTests). Funnel
  events: `grade.credits_blocked` → `grade.credits_topup_started` →
  `grade.credits_topup_{granted,timeout}` → existing submit events. It NEVER
  submits (only unblocks the button) so no double-grant.
- SyncEngine's offline-queue SwiftData work (snapshot/delete/markFailed/markStuck/
  counts) runs OFF-MAIN on `PendingMutationActor` (a `@ModelActor`, US-1165) — it
  no longer wraps each touch in `await MainActor.run { ModelContext(container) }`.
  Mirror `SyncMergeActor`: own one reused private context, return only `Sendable`
  snapshots, hop to `@MainActor` only to publish status counts. Reads see writes
  from the view/main context because each `@ModelActor` fetch hits the shared store.
- `InventoryFilterCriteria` has a hand-written tolerant `Codable` (decodeIfPresent
  per field). Add new saved-filter fields the same way — synthesized Codable
  would throw on legacy blobs missing the key, and `SavedFilterStore.load` uses
  `try?` so one decode failure silently wipes ALL saved views.
- SwiftUI swallows a present that fires while another is dismissing: setting a
  `.alert`/`.fullScreenCover` trigger in the SAME pass that dismisses the prior
  one is dropped. When walking a QUEUE (US-1273 ShareInbox batches), don't
  recurse to the next item synchronously after presenting an error — resume the
  drain from the dismiss handler (alert `isPresented` binding `set:`/cover
  `onDisappear`) so each item gets its own present.
- iPad `NavigationSplitView` (ContentView.swift `SidebarSplitView`): a section
  that renders its whole UI + its own in-view nav in ONE content-column
  NavigationStack (Money/Marketplaces/Settings) leaves a dead "Make a selection"
  detail pane in the 3-column layout. Fix = branch `body` on
  `AppSection.ownsContentNavigation`: TWO-column split (`sidebar`+`detail:`) for
  those, with the section view as the detail stack root (bound to its per-section
  path, carrying the deep-link `navigationDestination`s); 3-column only for
  list→detail sections (Home/Inventory). You can't hide just the detail column of
  a 3-column split (`columnVisibility .doubleColumn` hides the SIDEBAR), so use
  the 2-vs-3 conditional — SwiftUI rebuilds the split view on cross-boundary
  switches but the sidebar selection + NavigationPaths live in `AppRouter` so
  they survive.


## iOS hermetic UI tests (US-1153)
- Launch-arg hooks live in `GradeThread/Testing/UITestSupport.swift` — every flag
  is gated behind `-uitest` (no-op in production via `ProcessInfo.arguments`):
  `-uitest-reset-auth` (wipe keychain in `GradeThreadApp.init` BEFORE any
  `SupabaseShared.client` access → cold sign-out), `-uitest-paywall`
  (`ProtectedRouteShell` presents `PaywallView(userId:)` directly — its live
  billing/catalog fetchers fail-soft to nil/[] offline, and StoreKit prices come
  from the scheme's `.storekit` config so the paywall renders hermetically),
  `-uitest-mock-grading` (`GradingService` returns canned JSON via `GradingMock`,
  decoded through the SAME `.convertFromSnakeCase` decoder so the wire shape can't
  drift). Stable selectors already exist from US-1173 (`login.*`,
  `paywall.product.*`, `capture.shutter`).
- The UI-test scheme attaches the StoreKit config via XcodeGen
  `schemes.<name>.run.storeKitConfiguration: GradeThread.storekit` (path relative
  to `ios/`). Skip the fastlane-only `ScreenshotUITests` in the test action with a
  per-target `skippedTests:` entry. The CI `ui-test` job is separate +
  `continue-on-error: true` (non-blocking until proven stable).



## iOS App Intents / Siri / widgets (US-1134)
- App Intents live in `ios/GradeThread/Intents/`; one `AppShortcutsProvider`
  (`GradeThreadAppShortcuts`) auto-registers them for Siri/Spotlight — no
  Info.plist/entitlement needed. Navigation intents set `openAppWhenRun = true`
  + `@MainActor perform()` and reuse `DeepLinkRouter.post(_:)` (the same bus as
  push + the widget), gated on signed-in by ContentView; value-returning intents
  (`openAppWhenRun = false`) read `WidgetSnapshotStore.read()`. Keep spoken-copy
  formatting in a PURE helper (`SoldTodaySummary`) so it unit-tests with no Siri
  runtime. Lock Screen accessory widgets just add `.accessory{Rectangular,Inline,
  Circular}` to `supportedFamilies` + family-switch views; StandBy = the
  `.systemSmall` family with `@Environment(\.showsWidgetContainerBackground)`
  false → render a full-bleed treatment.



## iOS pipeline auto-advance (US-815)
- Status auto-advance + the prep checklist are PURE in `ios/GradeThread/
  Inventory/ItemWorkflow.swift` (`ItemWorkflow.resolveStatus`/`earnedStatus`/
  `rank` mirror web `src/lib/workflow.ts`; `ItemPrepChecklist` derives the
  rows). ItemCanvasView wires them: `.task(id: prepAdvanceSignature)` reacts to
  completed work (measurements/photos syncing in) + `save()` applies
  `resolveStatus` to the draft. Forward-only; never regresses a terminal/
  side-track status. US-827 (measurements→aspects) shares the measured-status
  write — REUSE `resolveStatus`, don't reimplement. The checklist deep-links by
  wrapping `Form` in a `ScrollViewReader` and tagging sections `.id(Step.x)`.



## Related

- [[ralph-learnings]] — the always-read playbook
- [[shipped-but-unwired]] — iOS title-sync is one of the unwired modules
