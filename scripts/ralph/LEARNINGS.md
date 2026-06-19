# Ralph Learnings — durable gotchas playbook

Read every iteration. Keep it SMALL (target < 150 lines). One terse bullet per
durable, non-obvious trap. Prune anything stale. This is cheap persistent
memory — not a progress log (the harness records progress separately).

## Build / verify
- `npm run build` does NOT run vitest — it only typechecks + builds. Run
  `npm test` separately or you ship a red `main`.
- Two web tests are red on clean `main` independent of your change (verified by
  stashing): `seo/__tests__/not-found.test.ts` (missing SPA-shell rule for
  /dashboard) and `prerender/__tests__/prerender.test.ts` (expects
  `dist/how-it-works/index.html`, but that route isn't prerendered — fails even
  after a fresh build). Don't chase either as your regression.
- `src/lib/concurrency.test.ts` ("slow item does not stall the other lanes") is
  timing-flaky under full-suite load (e.g. right after a build) — it passes when
  re-run in isolation (`npx vitest run src/lib/concurrency.test.ts`). Not a
  regression; re-run alone to confirm before chasing.
- `npx tsc --noEmit` is NOT enough — the build runs `tsc -b` (project refs),
  which is stricter and catches casts `--noEmit` lets slide (e.g.
  `x as Record<string,unknown>` on a typed interface needs
  `x as unknown as Record<…>`). Always confirm with `npm run build:locked`.
- Use `npm run build:locked`, never bare `npm run build`, when another loop may
  run concurrently (shared cross-loop build lock; see `docs/AGENT_COHABITATION.md`).
- `npm run build` does NOT apply migrations. After any SQL change run
  `npm run verify:db` (throwaway Supabase in Docker) — broken migrations
  otherwise only fail in CI after you've committed.
- Verify quietly: pipe build/test to a log and only read the tail on failure;
  don't ingest passing logs into context.
- A build `error TS2307: Cannot find module 'X'` where X (e.g. `three`,
  `@types/three`) IS already in `package.json` means `node_modules` is stale (a
  co-running loop committed a new dep without installing). It is NOT your
  regression — `npx tsc --noEmit` passes while `tsc -b`/`build:locked` fails on
  it. Run `npm install` to sync, then rebuild.
- An edge unit test that imports any lib which pulls in `lib/supabase.ts`
  (`supabaseAdmin`) crashes at import: `SUPABASE_URL is not set`. Fix like
  `ops-jobs_test.ts`: `Deno.env.set("SUPABASE_URL", …)` + `SUPABASE_SERVICE_ROLE_KEY`
  FIRST, then `const { fn } = await import("../lib/x.ts")` (dynamic, after the env
  set) — a static top-of-file import still runs before the env lines.

## Architecture / routing
- Two hosts, easy to confuse: Supabase/Kong = `api.gradethread.com` (Supabase
  routes only); Hono edge = `functions.gradethread.com` (ALL `/api/*` routes).
  Hitting `/api/*` on `api.*` silently 404s.
- Edge service uses the **service-role client which BYPASSES RLS**. Every query
  on a multi-tenant table MUST be tenant-scoped
  (`.eq("user_id", c.get("workspaceOwnerId") ?? c.get("userId"))`) or via an
  already-ownership-verified parent row. Never update/delete/select-by-id from a
  request-body id without confirming ownership. See
  `services/edge-functions/src/tests/tenant-isolation_test.ts`.

## Plan-gate from a background worker
- `requireFlipdesk` only reads `c.get` and (on block/warn) `c.json`/`c.header`.
  To reuse the IDENTICAL plan/capacity gate from a worker with no HTTP request
  (e.g. US-955 auto-publish), build a 1-line stub Context whose `json` captures
  the body, pass `userId`, and treat a non-null return as "blocked" — the 402
  body carries `used`/`limit` for partial-fit math. See `evaluateGate` in
  `flipdesk-autolister.ts`. Don't reimplement the matrix logic.

## Trial-conversion drip (US-945/946)
- The drip is split across THREE pieces and the SENDING ENGINE IS NOT WIRED YET:
  analytics tables (00253: drip_enrollments/sends/attributions) record what the
  engine did; the editable step-graph DEFINITION lives in `drip_campaigns`
  (00255, service-role only, no user_id so rls-guard doesn't auto-discover it);
  the admin BUILDER (`src/pages/admin/drip.tsx` + builder routes in
  `admin-drip.ts`) edits/validates/simulates it. There is NO tick/cron loop that
  actually sends — a future engine story reads `drip_campaigns.graph` + the pure
  evaluator in `lib/drip-graph.ts` (`simulateJourney`/`validateGraph`/`renderStep`).
- `lib/drip-graph.ts` is dependency-free (no supabase/env) so its test imports
  without the env dance; keep AI/supabase/email imports in the route file only.

## Sync provenance epic (US-1076…1086)
- The `listings.listing_origin` enum column is now PERSISTED (US-1077, migration
  00232): NOT NULL, default `'gradethread'`, backfilled. You may now
  `select("listing_origin")`. All insert paths stamp it (eBay import/pull +
  ebay-sku-match + sold-before-sync ⇒ `'ebay'`; every GT surface ⇒
  `'gradethread'`). `deriveListingOrigin()` still works as the canonical resolver
  — it returns the stored marker when valid, else derives from
  `batch_id`/`synced_to_ebay_at` (⇒ gradethread) / eBay `platform_listing_id`
  (⇒ ebay) — so pass the column in its signals and it wins outright.
- `listings.source_of_truth` (US-148 pin) is deprecated (US-1078); new sync code
  must not read it — provenance drives precedence now.
- US-1081 wired the eBay→FlipDesk drift path in `doListingsPull` (flipdesk-ebay.ts):
  for GT-originated matched offers it deletes editable eBay-owned keys from the
  listing `patch` (GT stays source of truth) and records/clears
  `listings.platform_fields.sync_drift` via a separate per-listing update. That
  survives because the bulk `pendingListing` upsert never carries
  `platform_fields`. The frontend badge/indicator lives in
  `GradethreadListingCard` (item.tsx) + `src/lib/listing-origin.ts`; re-push reuses
  the `/revise` endpoint, which now clears `sync_drift` on success.

## iOS (Swift)
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
- `InventoryFilterCriteria` has a hand-written tolerant `Codable` (decodeIfPresent
  per field). Add new saved-filter fields the same way — synthesized Codable
  would throw on legacy blobs missing the key, and `SavedFilterStore.load` uses
  `try?` so one decode failure silently wipes ALL saved views.

## Frontend conventions
- Adding a non-optional field to `ItemFullRow` (src/types/database.ts) breaks two
  full-literal test factories that `tsc -b` enforces: `src/lib/__tests__/
  flipdesk-lifecycle.test.ts` and `src/lib/item-filter.test.ts` (grep
  `sale_cancelled_at:` to find every literal). Update them or the build fails.
  Also mirror the new column into `LISTINGS_COLUMNS` in `listings.tsx` (explicit
  projection) — `useItemsFull` uses `select("*")` so the kanban gets it free, but
  the listings table won't.
- Date-filter comparisons must anchor on UTC: date-only DB columns
  (`purchase_date`, date `<input>` values) parse as UTC midnight, so parsing the
  bound as LOCAL midnight drifts by the TZ offset and same-day `eq` misses. See
  `dayStartMs` in `item-filter.ts`.
- shadcn: don't hand-edit `src/components/ui/*`. Toasts via `sonner`, not shadcn
  toast. Icons from `lucide-react` only. Named exports + `@/` imports.
- New public static page → register in `src/lib/seo/public-routes.ts` AND
  `src/prerender/entry-server.tsx`, or the prerender sync-guard test fails.
- `react-helmet-async` v3 renders no SSR head; add structured data via `<SEO
  jsonLd=…>` AND mirror it in `src/lib/seo/head-builder.ts` `jsonLdForRoute()`.
- Unified Inventory surface (US-958): `/dashboard/flipdesk/inventory` hosts the
  table/grid/kanban/prep views as `?mode=` toggles (one route). `?mode=` is the
  view toggle; `?view=` is ALREADY the saved-view loader (listings/pipeline read
  it, apply the saved filter, then strip the param) — don't conflate them.
  Shared cross-view state: search `?q=` + sort `?sort=` (via `useUrlParamState`),
  filter `?filter=`, selection via the `useInventorySelection` store (NOT URL —
  select-all can be thousands of ids), status counts via
  `useInventoryStatusCounts`. listings/grid/pipeline/prep are mounted only by the
  `inventory.tsx` container (lazy) — not the router directly; the legacy
  /grid /pipeline /listings /prep + /inventory/{grid,kanban,prep} routes are
  `InventoryModeRedirect`s. listings' tab-change effect must skip clearing the
  shared selection on mount (else a view switch wipes it).

## Storage / uploads
- Server uploads: `validateImageUpload()` → `stripImageMetadata()` →
  `storage.upload()`. `submission-images` is PRIVATE (signed URLs ≤900s, never
  `getPublicUrl`); `item-photos` is the only public bucket.
- iOS sensitive-photo routing (US-979): `PhotoStorageBucket` is the single
  source of truth for which item_photos `photo_type`s are sensitive (tag/tag_2/
  certificate) → PRIVATE `submission-images` bucket with EMPTY `photo_url`;
  everything else → public `item-photos` with a public URL. `PhotoSlotType`
  `.isSensitive`/`.storageBucket` wrap it. ALL four iOS write paths must honor
  it: `PhotoUploadService`, `SyncEngine.replayUploadPhoto`, `PhotoRotateService`,
  and reconcile. Display sensitive photos via `ItemPhotoThumbnail` (resolves a
  signed URL through `PhotoSignedURLProvider`, TTL hard-capped ≤900s); AI extract
  must mint a signed URL for sensitive slots so the edge can read the label. The
  edge `ebayPublicPhotoUrl` helper in `flipdesk-ebay.ts` mirrors the sensitive
  set so private photos are skipped (not turned into a 404 item-photos URL).

## prd.json / Ralph workflow
- Never read or edit `prd.json` from inside an iteration — the harness selects
  the story (`current-story.json`) and flips `passes:true` for you.
- New stories use `prd.json.nextId` then bump it (NOT `max(id)+1` — done stories
  live in `prd.archive.json`, so that would reuse ids).
- Optional per-story fields the harness understands:
  - `"hard": true` → iteration runs on `$HARD_MODEL` (Opus). The default model
    is now Opus too, so this is a no-op unless `RALPH_DEFAULT_MODEL` is lowered.
  - `"model": "opus"|"sonnet"|"haiku"` → exact model for that story (overrides
    `hard`). Env `RALPH_FORCE_MODEL` overrides all stories for a one-off sweep.
  - `"relevantPaths": ["src/...", "..."]` → file/glob hints the agent reads
    first instead of sweeping the tree (see GRAPHIFY_PILOT for auto-populating).
