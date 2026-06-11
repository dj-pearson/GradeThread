// One-shot: append US-804..US-828 (iOS Standalone + Aspect Autofill epics) to prd.json.
import { readFileSync, writeFileSync } from "node:fs";

const EPIC_IOS = "[EPIC: iOS Standalone 2026-06-11]";
const EPIC_ASPECT = "[EPIC: Aspect Autofill 2026-06-11]";

const stories = [
  {
    id: "US-804",
    title: "iOS onboarding plan selection (post-signup paywall step)",
    description:
      "As a new iOS user, after signing up I should be offered a plan immediately instead of silently landing on the free tier. Today the paywall (Billing/PaywallView.swift, StoreKit 2, fully built) is only discoverable via Settings -> Plan section; OnboardingView never mentions plans and LoginView hands off straight to MainShell. Add a final onboarding step (or post-first-sign-in sheet) presenting the subscription tiers + credit packs with a clear 'Continue with Free' path. Purchases go through the existing PaywallStore/StoreKitService -> POST /api/payments/appstore/verify flow — no new billing plumbing.",
    acceptanceCriteria: [
      "Onboarding flow ends with a plan-selection step that reuses PaywallView/PaywallStore (no duplicated product list); 'Continue with Free' is always visible and never blocks entry to the app",
      "The step is shown exactly once per fresh account (persisted flag, e.g. UserDefaults keyed by user id); existing signed-in users are not re-prompted",
      "A successful purchase during onboarding refreshes the billing snapshot before entering MainShell so PlanSection immediately shows the new tier",
      "Telemetry events fire for shown/purchased/skipped (gated by Telemetry.isAnalyticsEnabled)",
      "Unit tests cover the show-once gating logic; ios CI build + tests pass"
    ],
    priority: 804,
    passes: false,
    notes: `${EPIC_IOS} From 2026-06-11 iOS standalone audit. Verified: PaywallView.swift + PaywallStore.swift + StoreKitService.swift exist and work; onboarding (Onboarding/OnboardingView.swift) has no plan step; no paywall prompt anywhere outside Settings.`
  },
  {
    id: "US-805",
    title: "iOS plan-limit handling: 402 upgrade prompt + X-Plan-Warning soft banner",
    description:
      "As an iOS user hitting a plan cap, I should get an upgrade prompt instead of a raw error. The edge plan-gate (services/edge-functions/src/lib/plan-gate.ts) returns 402 PAYMENT_REQUIRED with a JSON body (plan, capacity, recommendation) on hard caps and sets an X-Plan-Warning response header at 80% soft-warn. Grep-verified: the iOS app handles NEITHER (no X-Plan-Warning or 402-specific handling anywhere under ios/). Add a centralized interceptor in the shared edge client (Networking/EdgeAPI) that (a) on 402 surfaces an UpgradePromptView sheet showing current usage, the recommended tier, and a button into PaywallView; (b) on X-Plan-Warning shows a non-blocking banner/toast.",
    acceptanceCriteria: [
      "EdgeAPI (or equivalent shared client) decodes the 402 plan-gate body into a typed PlanGateError and publishes it; all flipdesk/grading/AI calls get this behavior without per-call wiring",
      "UpgradePromptView shows the limit hit (e.g. 'Free plan includes 3 grades/month'), current usage, recommended tier, and opens PaywallView; dismissable without dead-ending the original flow",
      "X-Plan-Warning header produces a one-per-session soft banner with a 'See plans' affordance",
      "Settings gains the usage-alert threshold picker (50/80/95%) mirroring web US-209, persisted to UserDefaults and applied to the soft banner",
      "Unit tests cover 402 decode + threshold logic; ios CI passes"
    ],
    priority: 805,
    passes: false,
    notes: `${EPIC_IOS} From 2026-06-11 iOS standalone audit. Grep-verified absence of X-Plan-Warning / 402 handling in ios/. Server already emits everything needed — this is client-only except confirming the 402 body shape matches what plan-gate.ts sends.`
  },
  {
    id: "US-806",
    title: "iOS native subscription management for App Store-billed subs",
    description:
      "As an iOS subscriber, I must be able to manage (cancel/upgrade/downgrade/restore) my subscription inside the app. Today Settings' 'Manage plan & billing' opens https://gradethread.com/dashboard/billing in Safari — for an app selling IAP subscriptions, steering to web management is an App Review risk, and for App Store-billed users the web Stripe portal can't manage their sub at all. Grep-verified: AppStore.showManageSubscriptions / manageSubscriptionsSheet are used nowhere. Build: (1) for billing_source=appstore users, a 'Manage subscription' action that calls AppStore.showManageSubscriptions(in:) (handles cancel/auto-renew natively) plus upgrade/downgrade by purchasing a different product in the same subscription group via existing StoreKitService; (2) for billing_source=stripe users, keep the explicit 'billed on the web' card with a Safari link (permitted since the purchase originated on web), including inside the 409 ACTIVE_STRIPE_SUBSCRIPTION error dialog which currently dead-ends.",
    acceptanceCriteria: [
      "PaywallView/PlanSection show a management card for appstore-billed users: renewal date, auto-renew state (from Transaction.currentEntitlements + server snapshot), 'Manage subscription' opening the native StoreKit manage-subscriptions sheet",
      "Upgrade/downgrade buys the target product in the same subscription group through StoreKitService and reports the JWS to /api/payments/appstore/verify; UI refreshes the billing snapshot after",
      "Stripe-billed users see the managed-on-web card with a SafariView link; the 409 cancel-stripe-first response from /appstore/verify now presents that link instead of a bare error",
      "Settings no longer routes appstore-billed users to web billing for management",
      "Unit tests for the billing_source branching; ios CI passes"
    ],
    priority: 806,
    passes: false,
    notes: `${EPIC_IOS} From 2026-06-11 iOS standalone audit. NOTE for implementer: StoreKit 2 DOES expose AppStore.showManageSubscriptions(in:) and upgrade/downgrade-within-group via purchase — no server pause/cancel RPC needed for appstore subs (the App Store Server Notification webhook at /api/webhooks/appstore already reconciles the resulting state changes).`
  },
  {
    id: "US-807",
    title: "Web billing App Store awareness + symmetric purchase precedence",
    description:
      "As a user who subscribed via the iOS app, the web billing page must recognize that and not sell me a second subscription. Grep-verified: zero references to billing_source or appstore anywhere under src/ — billing.tsx will happily start a Stripe checkout for an appstore-billed user (double billing), and the server-side /api/payments/flipdesk/subscribe has no appstore precedence check (precedence.ts only guards the reverse direction, appstore-blocked-by-stripe). Add: billing-summary returns billing_source + appstore fields; web shows a 'Your subscription is managed in the iOS app' card (hide plan-change/pause/cancel CTAs, keep credit packs + per-grade purchases which are additive); /flipdesk/subscribe and /flipdesk/downgrade return 409 when an active appstore subscription exists.",
    acceptanceCriteria: [
      "GET /api/payments/billing-summary includes billing_source and appstore_product_id (when set)",
      "billing.tsx renders the appstore-managed card for billing_source='appstore' with active/trialing/past_due status; subscription CTAs hidden, credit-pack and per-grade purchase remain available",
      "POST /api/payments/flipdesk/subscribe and the downgrade endpoint reject with 409 + machine-readable code when subscription_status is active/trialing/past_due AND billing_source='appstore' (mirror of lib/appstore/precedence.ts)",
      "Edge unit tests cover the new precedence branch; web build + existing billing tests pass"
    ],
    priority: 807,
    passes: false,
    notes: `${EPIC_IOS} From 2026-06-11 iOS standalone audit. Server columns already exist (migration 00104: billing_source, appstore_original_transaction_id, appstore_product_id) — this is read-path + guard work only.`
  },
  {
    id: "US-808",
    title: "Single-source IAP catalog: server-served product map + price-drift guard",
    description:
      "As the billing owner, I need one canonical product catalog instead of three drifting copies: iOS hardcodes fallback prices in Billing/IAPProduct.swift (e.g. 10 credits $24.99), the edge has PRODUCT_MAP in lib/appstore/products.ts, and Stripe prices live in Stripe config. iOS already shows live StoreKit prices when products load, but tier/credit mappings and fallback display prices can drift silently. Serve the canonical catalog (product ids, tier, interval, credits granted, reference USD price) from the edge (extend billing-summary or a /api/payments/catalog endpoint), have iOS consume it for mapping/fallback display, and add a drift test asserting edge PRODUCT_MAP, iOS IAPProduct, and the catalog agree.",
    acceptanceCriteria: [
      "Edge exposes the canonical catalog derived from lib/appstore/products.ts (no second copy server-side)",
      "iOS fetches + caches the catalog; IAPProduct hardcoded entries become the offline fallback only, with a comment pointing at the canonical source",
      "A test (edge deno test or node script in verify lane) fails when iOS IAPProduct.swift product ids/credits diverge from PRODUCT_MAP (parse the Swift file or a shared fixture both sides import)",
      "Reference prices for credit packs and tiers match the web Stripe display prices or the divergence is explicitly documented in the catalog",
      "npm run verify (web+edge lanes) passes"
    ],
    priority: 808,
    passes: false,
    notes: `${EPIC_IOS} From 2026-06-11 iOS standalone audit. Apple controls real IAP prices in App Store Connect — the catalog's USD prices are reference/fallback only; the story is about id/credits/tier mapping integrity, not price authority.`
  },
  {
    id: "US-809",
    title: "iOS in-flow credit purchase when grading is blocked",
    description:
      "As an iOS user submitting items for grading with no remaining included grades and zero credit balance, I should be able to buy credits right there and continue — today BulkGradeSheet shows a creditsBanner when validation.limitExceeded but offers no purchase path (user must find Settings -> Plan -> paywall, buy, come back). Web equivalent falls back to one-time Stripe checkout. Wire the grading flow (BulkGradeSheet and any single-item grade sheet on ItemCanvas) to open the paywall's credit-pack section inline, then poll the refreshed grade_credit_balance (grant lands via /appstore/verify -> grant_appstore_credits RPC) and re-run validation so the user can submit without leaving the sheet.",
    acceptanceCriteria: [
      "creditsBanner (and the single-item equivalent) gains a 'Buy credits' button presenting the credit-pack purchase UI (reuse PaywallStore consumables section) without dismissing the grading sheet",
      "After a successful purchase the sheet polls the billing snapshot (bounded retries with backoff, handles verify latency) until grade_credit_balance reflects the grant, then re-validates and enables submit",
      "Failure/timeout paths leave the sheet usable with a retry affordance; no double-grant (server RPC is already idempotent by transaction id)",
      "Telemetry events for blocked->purchased->submitted funnel",
      "Unit tests for the poll/re-validate state machine; ios CI passes"
    ],
    priority: 809,
    passes: false,
    notes: `${EPIC_IOS} From 2026-06-11 iOS standalone audit. Verified BulkGradeSheet.swift exists with phases load/ready/submitting/done + creditsBanner on limitExceeded; server grant path (appstore_processed_transactions + grant_appstore_credits) already idempotent.`
  },
  {
    id: "US-810",
    title: "iOS email-confirmation UX: detect unconfirmed sign-in + resend",
    description:
      "As a new iOS user who signed up but hasn't clicked the confirmation email, signing in currently surfaces a raw server error with no guidance. LoginView shows 'Check your email to confirm' only immediately post-signup; there is no resend path and no specific handling of the unconfirmed-email auth error. Add: detect the Supabase 'email not confirmed' error on sign-in, show purpose-built copy, and offer a 'Resend confirmation email' button (supabase.auth.resend) with success/cooldown states.",
    acceptanceCriteria: [
      "Sign-in with an unconfirmed account shows dedicated guidance (not the raw error string) including the address the mail was sent to",
      "Resend button calls the Supabase resend API, shows success confirmation, and rate-limits itself client-side (e.g. 60s cooldown)",
      "Confirmation links continue to deep-link back into the app via the existing universal-link handler (AuthStore) — verified by the existing flow, no regression",
      "Unit test for the error-classification helper; ios CI passes"
    ],
    priority: 810,
    passes: false,
    notes: `${EPIC_IOS} From 2026-06-11 iOS standalone audit (LoginView.swift:217-219 shows post-signup copy only; no resend anywhere).`
  },
  {
    id: "US-811",
    title: "App Store subscription expiry sweep (server scheduled task)",
    description:
      "As the platform, I must not leave an appstore-billed user on a paid plan forever if Apple's server notification is lost. Entitlement state currently changes only via POST /api/webhooks/appstore or client /appstore/verify calls; if both are missed after expiry, users stay active indefinitely. Add a scheduled sweep (same pattern as the existing token-refresh/repricing scheduled tasks) that finds users with billing_source='appstore' and subscription_status IN ('active','trialing') whose flipdesk_period_end passed more than a grace window ago (e.g. 72h), and lapses them to free/canceled, writing a flipdesk_subscription_events audit row. Optionally (preferred if App Store Server API credentials are configured) verify current status against Apple before lapsing.",
    acceptanceCriteria: [
      "New edge endpoint or job module performs the sweep, callable by the scheduler (mirror an existing scheduled-task route's auth pattern)",
      "Only rows matching billing_source='appstore' + stale flipdesk_period_end beyond the grace window are touched; Stripe-billed users are never modified",
      "Each lapse writes users.flipdesk_plan='free', subscription_status='canceled', and an audit event namespaced 'appstore:sweep:'",
      "Idempotent: re-running produces no duplicate events or changes",
      "Deno tests cover the selection predicate + idempotency; deploy doc (LAUNCH_CHECKLIST scheduled tasks list) gains the new task entry"
    ],
    priority: 811,
    passes: false,
    notes: `${EPIC_IOS} From 2026-06-11 iOS standalone audit. Apple retries notifications, so this is a backstop — keep the grace window generous and log loudly when the sweep actually lapses someone.`
  },
  {
    id: "US-812",
    title: "iOS Money tab analytics parity (charts + per-item P&L)",
    description:
      "As a reseller on iOS, I want the financial analytics the web /finances page has. Web renders six panels (cash-flow breakdown, time-on-market, ROI by grade and by source, grade-price correlation, inventory-aging breakdown) plus a per-item profit table; iOS MoneyView has KPI tiles, ONE 6-month revenue bar chart, and expenses. Add Swift Charts panels computed from local SwiftData via pure rollup functions (follow the DashboardRollup.compute pattern — pure + unit-tested), and a per-item P&L list (sale price, fees, cost basis, profit, ROI) reachable from Money.",
    acceptanceCriteria: [
      "Money tab gains at least: inventory-aging histogram, ROI by source, time-on-market, and cash-flow (revenue vs expenses vs cost-basis) panels using Swift Charts",
      "Per-item profit list with sortable profit/ROI, fed by sales + items already synced locally",
      "All aggregations live in pure, unit-tested rollup functions (no view-layer math)",
      "Empty/loading states for users with no sales; charts respect the currency preference (US-648)",
      "ios CI build + tests pass"
    ],
    priority: 812,
    passes: false,
    notes: `${EPIC_IOS} From 2026-06-11 parity audit. Grade-price correlation panel is optional (needs graded+sold overlap to be meaningful) — include if the rollup is cheap, otherwise note it out.`
  },
  {
    id: "US-813",
    title: "iOS inventory pipeline (kanban) stage view",
    description:
      "As a reseller on iOS, I want the visual pipeline view web has at /dashboard/flipdesk (FlipdeskPipelinePage): columns for sourced -> cataloged -> measured -> photographed -> comped -> drafted -> listed -> sold. iOS InventoryListView offers list/card + a status filter but no stage board. Add a pipeline mode: horizontally scrollable status columns with item cards, tap to open the item canvas, and a move-to-stage action (context menu or drag) doing an optimistic status write with revert-on-failure (reuse the BulkActionExecutor optimistic-write pattern).",
    acceptanceCriteria: [
      "Inventory tab gains a view-mode toggle (list/board); board renders one column per pipeline status with per-column counts",
      "Items can be moved between stages (context-menu 'Move to...' at minimum; drag is a bonus) with optimistic local update + server write + revert and toast on failure",
      "Column order matches FLIPDESK_PIPELINE in src/lib/constants.ts; statuses with zero items still render (empty state)",
      "Board performs acceptably with 500+ items (lazy per-column loading or LazyHStack/LazyVStack)",
      "Unit tests for the stage-move reducer; ios CI passes"
    ],
    priority: 813,
    passes: false,
    notes: `${EPIC_IOS} From 2026-06-11 parity audit.`
  },
  {
    id: "US-814",
    title: "iOS sources management surface",
    description:
      "As a reseller on iOS, I need to manage my sourcing locations. Web has /dashboard/flipdesk/sources (full CRUD + per-source stats). iOS has SourceStore (create via the intake form only) and grep-verified no SourcesView/SourceListView — sources can be created but never listed, renamed, or archived, and there's no per-source spend/profit view. Add a Sources screen (entry from Settings -> Data and/or Inventory filters): list with item counts + total spent, create/edit/archive, and tap-through to a filtered inventory list.",
    acceptanceCriteria: [
      "SourcesView lists sources with name, type, item count, and total acquisition spend; create/edit/archive supported (reuse SourceStore, extend as needed)",
      "Archiving a source keeps historical items intact and hides it from intake pickers",
      "Tapping a source opens inventory filtered to it",
      "RLS-safe: all queries via the user JWT client scoped to the signed-in user",
      "ios CI passes"
    ],
    priority: 814,
    passes: false,
    notes: `${EPIC_IOS} From 2026-06-11 parity audit. Grep-verified: no sources list/edit UI exists in ios/.`
  },
  {
    id: "US-815",
    title: "iOS prep checklist on item canvas + 'measured' status wiring",
    description:
      "As a reseller on iOS, I want a prep checklist per item so I know what's left before listing. Pipeline statuses (measured, photographed, comped, drafted) exist in the DB enum but iOS never sets 'measured' and has no prep UI (grep-verified: no PrepView). Add a prep section to ItemCanvasView derived from item state — required photos present, measurements present, comps fetched, AI-enriched, grade attached (optional), draft created — with each row deep-linking to the relevant action, and auto-advance item status as steps complete (saving measurements sets status to 'measured' when appropriate).",
    acceptanceCriteria: [
      "ItemCanvasView shows a prep checklist computed from actual item data (no manually-ticked booleans), each incomplete row navigating to the action that completes it",
      "Saving measurements on an item whose status is earlier in the pipeline advances status to 'measured'; adding required photos advances to 'photographed' (never regresses a later status)",
      "Status advancement logic is a pure, unit-tested function",
      "Checklist states render correctly for fully-prepped and brand-new items",
      "ios CI passes"
    ],
    priority: 815,
    passes: false,
    notes: `${EPIC_IOS} From 2026-06-11 parity audit. Web /flipdesk/prep is the reference. Coordinate with US-827 (measurements->aspects) which also touches the measured-status write.`
  },
  {
    id: "US-816",
    title: "iOS price suggestions surface (comps-based bulk repricing aid)",
    description:
      "As a reseller on iOS, I want the bulk price-suggestions list web has at /dashboard/analytics/suggestions: items lacking a price (or stale-priced) with a suggested price from eBay comps and one-tap apply. iOS already has per-item comps on the item canvas (Comps/* via /api/flipdesk/ebay/category/suggest + /api/flipdesk/ebay/comps) but no aggregate surface — grep-verified no PriceSuggestion view. This was deferred from the 2026-06-01 parity push (roadmap item #2). Build a Suggestions screen (entry from Money or Inventory) listing candidate items with suggested price (median comp), confidence context (comp count, low/high), and Apply/Dismiss per row.",
    acceptanceCriteria: [
      "Suggestions list shows items with no target_price or listed long ago, each with suggested median price + comp count, reusing the existing comps endpoints (server app-token, no user eBay connection required)",
      "Apply writes target_price (and listing price via existing draft service when a draft exists) optimistically with revert-on-failure; Dismiss hides the row for that session",
      "Comps fetches are batched/serialized to respect rate limits with progress UI",
      "Empty state when everything is priced",
      "ios CI passes"
    ],
    priority: 816,
    passes: false,
    notes: `${EPIC_IOS} From 2026-06-11 parity audit; explicitly deferred in the 2026-06-01 roadmap ('Standalone bulk Price-Suggestions list deferred').`
  },
  {
    id: "US-817",
    title: "iOS payout CSV import for reconciliation",
    description:
      "As a reseller on iOS, I want to import an eBay payout CSV and reconcile it against sales like web /dashboard/flipdesk/reconciliation does (payout_imports table + matching). iOS has PayoutReconciliationView/Store/Service under Money/ — audit indicates it is read/match-view only with no CSV import entry point. First verify exactly what PayoutReconciliationService supports; then add the missing piece: a file importer (CSV via fileImporter), upload/parse through the same edge endpoint web uses, and surface match results + unmatched queue with the existing reconciliation UI.",
    acceptanceCriteria: [
      "Documented (in the story notes on completion) what the pre-existing iOS reconciliation surface did and didn't support",
      "Money -> Reconciliation gains an 'Import payout CSV' action using SwiftUI fileImporter; the file is sent through the SAME edge import endpoint the web uses (no client-side-only parsing divergence)",
      "Import result shows matched/unmatched counts; unmatched rows land in the existing review UI",
      "Errors (bad CSV, wrong columns) produce actionable messages, not silent failures",
      "ios CI passes"
    ],
    priority: 817,
    passes: false,
    notes: `${EPIC_IOS} From 2026-06-11 parity audit. PayoutReconciliation{View,Store,Service,Types}.swift exist under Money/ — verify before building; the gap is believed to be the import entry point only.`
  },
  {
    id: "US-818",
    title: "iOS settings completeness: change password, legal links, grading guide",
    description:
      "As an iOS user, Settings should cover account security and the informational surfaces web has. Gaps: (1) no change-password — the app only offers email reset via web Safari; add an in-app change-password form (current session reauth + supabase.auth.updateUser); (2) no legal section — add Privacy Policy / Terms links (SafariView to gradethread.com/privacy, /terms) which App Review expects to find; (3) no grading education — add a 'How grading works' link or lightweight in-app explainer (the 5 factors + tiers from src/lib/constants.ts are stable copy).",
    acceptanceCriteria: [
      "Settings -> Account gains Change Password (new password + confirm, min-length validation matching signup, success/error states) using the authenticated Supabase session",
      "Settings gains a Legal section linking Privacy Policy and Terms via SafariView",
      "Settings (or Help section) links 'How grading works' — either SafariView to the web guide or a native sheet rendering the 5 grading factors + tier scale",
      "All new rows are accessibility-labeled; ios CI passes"
    ],
    priority: 818,
    passes: false,
    notes: `${EPIC_IOS} From 2026-06-11 parity audit. Usage-alert thresholds intentionally live in US-805 (they're part of the plan-warning UX), not here.`
  },
  {
    id: "US-819",
    title: "iOS disputes visibility from the grades list",
    description:
      "As a user who disputed a grade on iOS, I should see dispute status without spelunking. DisputeSheet.swift exists but is only reachable from the grade report inside the item canvas; the grades list (Grading/GradesListView.swift) shows no dispute affordance or status, unlike web submissions which surface dispute state per row. Add: dispute status badge on grade rows that have an open/resolved dispute, and make GradeReportView's dispute entry discoverable from the grades list flow.",
    acceptanceCriteria: [
      "GradesListView rows show a dispute badge (open/under review/resolved) when a dispute exists for that submission",
      "Navigating from the grades list to a report exposes the same dispute affordance available from the item canvas",
      "Dispute state syncs into the local store with the existing sync mechanism (no per-row N+1 fetches)",
      "ios CI passes"
    ],
    priority: 819,
    passes: false,
    notes: `${EPIC_IOS} From 2026-06-11 parity audit.`
  },
  {
    id: "US-820",
    title: "iOS AutoLister drafts bulk edit",
    description:
      "As a reseller on iOS using AutoLister, I want to bulk-edit generated drafts before publishing (web composer supports bulk operations). The iOS drafts library (AutoLister/Drafts/*) lists drafts and allows single-item editing via the composer, but has no multi-select or bulk field apply. Add multi-select to the drafts list with bulk actions: set/adjust price (absolute or percent), set eBay condition, apply a listing template (US-674 template service already exists on iOS), and bulk publish hand-off to the existing sequential publish pipeline.",
    acceptanceCriteria: [
      "Drafts list supports multi-select with a bulk action bar (matches the Inventory multi-select interaction pattern)",
      "Bulk price (absolute or +/-%), bulk condition, and bulk template-apply write through ListingDraftService per draft with progress + per-item failure reporting (no all-or-nothing silent failure)",
      "Bulk publish enqueues selected ready drafts through the existing publish path, honoring plan gating (402 handling per US-805)",
      "Pure helpers for the bulk mutations are unit-tested; ios CI passes"
    ],
    priority: 820,
    passes: false,
    notes: `${EPIC_IOS} From 2026-06-11 parity audit. Verify current Drafts/* capabilities first — the generation pipeline itself (AutoListerGenerator -> batch endpoints) is fully wired; only bulk editing is missing.`
  },
  {
    id: "US-821",
    title: "Canonical attribute capture: extend AI extract to the full listing field set",
    description:
      "As a seller, ONE AI pass over my photos should capture everything an eBay listing will ever need, so changing category later never re-runs AI. Today ai-extract.ts extracts only title/brand/style/size/color/material/item_category/condition_notes/description (+conditional measurements + a best-effort eBay aspects block), and several extracted values are dropped: condition_summary and ebay_category_query are never persisted. Common required/recommended clothing aspects are NOT captured as durable fields: Department, Size Type, Sleeve Length, Neckline, Pattern, Fit, Closure, Features, Garment Care, Country of Manufacture, Vintage, Theme, MPN/Style Code (currently conflated with style). Extend the single extract call's tool schema to return a canonical attributes object covering these, add inventory_items.attributes (jsonb) to persist it (plus condition_summary and ebay_category_query), and extend the iOS AIExtract review UI to show/accept the new fields. Category-agnostic canonical keys — the per-category eBay aspect mapping happens downstream (US-822).",
    acceptanceCriteria: [
      "Migration adds inventory_items.attributes jsonb (canonical key -> value/values) + persists condition_summary and ebay_category_query columns or keys; types/database.ts and iOS models updated",
      "ai-extract.ts tool schema + prompt extended with the canonical attribute set (department, size_type, sleeve_length, neckline, pattern, fit, closure, features[], garment_care, country_of_manufacture, vintage, theme, mpn) with per-field confidence + source, still in the SAME single extract call (no added AI invocation; token-budget note in the prompt file)",
      "Apply path (web + iOS ItemUpdate) persists accepted attribute values into inventory_items.attributes and records them in ai_field_sources",
      "iOS AIExtractView groups the new attributes in the review screen (collapsible 'Listing details' section) without overwhelming the core fields",
      "Edge unit tests cover schema decode + persistence mapping; existing extract behavior for the original 9 fields is regression-tested"
    ],
    priority: 821,
    passes: false,
    notes: `${EPIC_ASPECT} From 2026-06-11 photo-AI audit. Verified dropped today: condition_summary (display-only), ebay_category_query (used transiently), conflicts. Keep attributes canonical (lowercase snake keys) — NOT eBay aspect names; US-822 owns the mapping.`
  },
  {
    id: "US-822",
    title: "Single-source canonical-attribute -> eBay-aspect mapping registry",
    description:
      "As a developer, there must be exactly one definition of how item fields map to eBay aspect names. Today deriveAspectsFromItem() is hand-duplicated in THREE places: edge (flipdesk-ebay.ts ~L3140), web (src/lib/ebay-prefill.ts), and iOS prefill behavior — each covering only brand/size/color/material/style/department/size-type. Build a registry in the edge service (data-driven: canonical attribute key -> ordered aspect-name candidates -> mode handling, with per-vertical branches keyed by item_category) covering ALL canonical attributes from US-821, and make web + iOS consume it instead of their local copies: either served via an endpoint (cacheable, versioned) or emitted as a generated JSON artifact both clients vendor with a CI sync-guard (same pattern as the SEO public-routes guard).",
    acceptanceCriteria: [
      "Registry module in services/edge-functions/src/lib/ (pure data + a resolve function) maps every US-821 canonical attribute to eBay aspect-name candidates incl. synonyms (Material/Fabric Type/Outer Shell Material; Color/Colour; measurement aspects) with vertical-specific entries for clothing vs shoes vs other item_category values",
      "Edge deriveAspectsFromItem() is rewritten on top of the registry; behavior for the existing 7 mappings is regression-tested",
      "Web ebay-prefill.ts and iOS prefill consume the registry (endpoint or generated artifact); a CI guard fails when a vendored copy drifts from the registry",
      "Aspects already present (user-set) are never overwritten by derived values (preserve existing precedence)",
      "Deno + vitest tests for the resolver; npm run verify passes"
    ],
    priority: 822,
    passes: false,
    notes: `${EPIC_ASPECT} From 2026-06-11 aspects audit. The three-copy duplication is verified (edge flipdesk-ebay.ts deriveAspectsFromItem, src/lib/ebay-prefill.ts header comment admits the mirror). Depends on US-821 for the new attribute keys but the registry refactor of existing fields can land first.`
  },
  {
    id: "US-823",
    title: "Aspect value normalization layer (synonyms + size expansion)",
    description:
      "As a seller, my stored values should auto-match eBay's SELECTION_ONLY allowed values instead of being silently omitted. Current matching (edge flipdesk-ebay.ts) is case-insensitive + trailing-'s' plural strip only — so size 'M' never matches allowed value 'Medium', 'Poly' never matches 'Polyester', and the aspect falls back to manual entry or a publish blocker. Add a normalization module: curated synonym tables for sizes (S/M/L/XL <-> Small/Medium/..., numeric ranges), materials, colors, departments (Men/Men's/Mens), size types, plus a conservative token-based fallback; integrate into deriveAspectsFromItem (server), the web composer prefill preview, and iOS. When normalization rewrites a value, the UI shows it ('M -> will be sent as \"Medium\"'); when no confident match exists, leave the aspect unfilled for manual entry (never guess).",
    acceptanceCriteria: [
      "normalizeAspectValue(canonicalValue, aspectSpec) returns a matched allowed value or null, with curated tables for size, material, color, department, size_type and a token/affix fallback that only fires on unambiguous single candidates",
      "Wired into the registry resolver (US-822) so server publish-time derivation, web composer prefill, and iOS prefill all use it",
      "Composer (web) shows the normalized value with original in a hint when a rewrite occurred",
      "Unit tests against realistic eBay allowedValues fixtures (clothing Size, Department, Material, Size Type) covering match, rewrite, ambiguity-refusal, and null cases",
      "No normalization ever fires for FREE_TEXT aspects (original value passes through)"
    ],
    priority: 823,
    passes: false,
    notes: `${EPIC_ASPECT} From 2026-06-11 aspects audit. Conservative by design: a wrong auto-mapped aspect is worse than an empty one. Depends on US-822 registry plumbing.`
  },
  {
    id: "US-824",
    title: "Category change = deterministic aspect refill, no AI re-run, no silent loss",
    description:
      "As a seller changing the eBay category on a draft, the app must refetch that category's required/optional aspects and refill them from data I already have — zero AI calls, zero silent data loss. Web composer already does most of this (refetch via useEbayCategoryAspects, drop-invalid-preserve-valid, deriveAspectsFromItem prefill); iOS SpecificsEditorModel.swift currently CLEARS all aspect values when the category changes (~L86) and only refills via the manual 'Fill with AI' button — exactly the re-run this epic eliminates. Implement shared behavior on both clients: preserve still-valid values, remap canonical attributes (US-821) through the registry+normalization (US-822/823) into the new category's aspects, always carry cross-category universals (Brand, Color, Material) when valid, and show a confirm-before-discard summary for values that don't carry over. Also prefetch the current category's aspect spec when the specifics editor opens (iOS currently fetches lazily).",
    acceptanceCriteria: [
      "iOS SpecificsEditorModel category change: fetch new aspect spec (cached table), keep values valid in the new spec, deterministically derive missing aspects from inventory fields + attributes, and present a 'these N values don't apply to the new category' confirmation before dropping anything",
      "Web composer gains the same confirm-before-discard affordance (today invalid values are dropped silently) and derives from the new attributes store, not just the 7 legacy columns",
      "Explicitly verified: no AI endpoint is called on category change on either client (assert in tests / no network call to /ai/ routes)",
      "Specifics editor prefetches aspects for the item's current ebay_category_id on open (iOS); category picker interaction feels instant on cached categories",
      "Unit tests for the remap function (keep/remap/drop classification); ios CI + web tests pass"
    ],
    priority: 824,
    passes: false,
    notes: `${EPIC_ASPECT} From 2026-06-11 aspects audit. iOS clearing behavior verified at SpecificsEditorModel.swift L78-88. This story is the heart of the user's no-re-run-AI goal.`
  },
  {
    id: "US-825",
    title: "Aspect provenance badges + pre-publish required-aspect check",
    description:
      "As a seller, I should see which item specifics came from AI, which were derived from my item fields, which I typed, and which REQUIRED ones are still empty — before hitting publish. Today nothing distinguishes sources, and missing required aspects only surface as publish-time blockers from assemblePublishContext. Add per-aspect provenance (ai_extracted | inventory_derived | manual | unfilled — computable from ai_field_sources + derivation bookkeeping, or stored alongside the aspect map), render badges in the web composer and iOS specifics editor, and surface a pre-publish checklist: required aspects for the chosen category with fill-state, so the publish button can show '2 required specifics missing' inline instead of failing later.",
    acceptanceCriteria: [
      "Aspect maps gain provenance metadata (schema decision documented: parallel jsonb keyed by aspect name is acceptable) written by AI generation, deterministic derivation, and manual edits",
      "Web composer + iOS specifics editor render source badges and visually group required-but-unfilled aspects at the top",
      "Pre-publish state (both clients) shows required-aspect completeness for the selected category BEFORE calling publish, using the cached aspect spec (no new AI calls); publish remains server-validated as today",
      "assemblePublishContext blocker messages and the client checklist agree (same required-aspect source of truth)",
      "Tests cover provenance writes from each path; npm run verify + ios CI pass"
    ],
    priority: 825,
    passes: false,
    notes: `${EPIC_ASPECT} From 2026-06-11 aspects audit. Server blockers already exist (assemblePublishContext L3382-3390) — this story is about surfacing them early + provenance, not new validation.`
  },
  {
    id: "US-826",
    title: "iOS capture: high-value attribute confirm chips + guaranteed one-call eBay prep",
    description:
      "As an iOS user finishing photo capture, the AI review screen should let me confirm the attributes eBay almost always requires but AI can only infer — Department (Men/Women/Unisex/Kids), Size Type (Regular/Petite/Tall/Plus/Big & Tall), Vintage (yes/no), and a condition tier — as one-tap chips pre-selected from the AI's guess. Also guarantee the one-call eBay prep actually runs at capture: the extract endpoint only resolves category + aspects when item_id is passed and persists ebay_category_id + ebay_aspects; verify the iOS intake path always passes item_id, and if the eBay block partially fails (category resolved but aspects fetch failed), persist what succeeded and mark the item for deterministic refill later — never a full AI re-run.",
    acceptanceCriteria: [
      "AIExtractView shows confirm chips for department, size_type, vintage, and condition tier, pre-selected from AI suggestions (US-821 attributes), writable in one tap; accepted values persist to inventory_items.attributes",
      "Audited + guaranteed: every iOS intake path (photo-first, details-first with photos, AutoLister, ShareInbox) passes item_id to /api/flipdesk/ai/extract so one-call eBay prep runs; gaps found are fixed",
      "Partial eBay-prep failure persists the resolved pieces (e.g. category id without aspects) and flags the item so the specifics editor deterministically derives/refetches on next open — verified no code path re-invokes AI for this",
      "Chips respect the existing accept/reject review model (ai_field_sources records accepted=true/false)",
      "ios CI passes; edge test covers partial-failure persistence"
    ],
    priority: 826,
    passes: false,
    notes: `${EPIC_ASPECT} From 2026-06-11 photo-AI audit. Depends on US-821 (attributes store + extended schema). The one-call prep mechanism already exists in flipdesk-ai.ts (two-pass extract -> suggestCategories -> getCategoryAspects -> extractEbayAspects); this story hardens when it runs and what survives failure.`
  },
  {
    id: "US-827",
    title: "Measurements -> eBay aspects + listing description block + measured status",
    description:
      "As a seller who captured garment measurements (iOS measurement photo slots + AI brand-spec measurements land in inventory_items.measurements jsonb), those numbers should flow into the listing: (1) map measurement keys (chest, waist, inseam, sleeve, length, rise, ...) to the category's measurement aspects (e.g. Inseam, Chest Size, Sleeve Length) via the US-822 registry with unit formatting; (2) auto-append a formatted measurements block to the generated/edited listing description at draft build (buyers expect flat-lay measurements; respects the inches/cm preference from US-648); (3) set item status to 'measured' when measurements are saved (status exists in the enum but iOS never sets it).",
    acceptanceCriteria: [
      "Registry entries map canonical measurement keys to eBay measurement aspect names (per-category candidates); values formatted with units and filled only when the aspect exists in the category spec",
      "Draft description assembly (edge ai-listing/draft path + composer regeneration on both clients) appends a clean measurements section when measurements exist and the user hasn't deleted it; never duplicated on re-save",
      "Saving measurements advances item status to 'measured' per the US-815 non-regressing advancement rule (coordinate; whichever lands second wires into the shared helper)",
      "Unit tests for measurement formatting (in/cm), aspect mapping, and description idempotency",
      "npm run verify + ios CI pass"
    ],
    priority: 827,
    passes: false,
    notes: `${EPIC_ASPECT} From 2026-06-11 photo-AI audit. Measurements are captured + persisted today (PhotoSlotType measurement_* slots; ai-extract conditional brand-spec measurements) but go nowhere downstream.`
  },
  {
    id: "US-828",
    title: "AutoLister aspect reconciliation at generation time (nothing silently dropped)",
    description:
      "As a seller using AutoLister, AI-generated item specifics must be validated against the resolved category's actual aspect spec when they're generated — not discovered broken at publish. Today generateListingFields() can invent aspect names; extractEbayAspects() refines when the category is known, but on second-pass failure the fallback only filters first-pass aspects BY NAME (values for SELECTION_ONLY aspects may still be invalid), and invalid values surface only as publish-time omissions/blockers. Add: after category resolution, validate every generated aspect name AND value against the cached spec; route near-miss values through the US-823 normalizer; anything still unmatched is kept visibly as needs-review on the draft (web + iOS drafts UI) rather than silently dropped, and publish-time derivation logs + surfaces any aspect it omits.",
    acceptanceCriteria: [
      "Generation path (flipdesk-autolister/ai-listing) validates aspects against the category spec: valid pass through, near-misses normalized (US-823), unmatched stored with a needs_review marker on the draft",
      "Web composer/drafts and iOS drafts editor surface needs-review aspects distinctly (count badge on the draft row + highlighted rows in the editor)",
      "assemblePublishContext logs every aspect it omits for value-validation reasons and includes them in the publish response diagnostics so clients can surface 'X was not sent'",
      "SELECTION_ONLY value validation is fixture-tested (valid, normalizable, unmatched)",
      "deno tests + npm run verify pass"
    ],
    priority: 828,
    passes: false,
    notes: `${EPIC_ASPECT} From 2026-06-11 aspects audit. Existing second-pass refine (ai-listing.ts extractEbayAspects + merge L724, fallback L732-742) stays — this story closes the validation holes around it. Depends on US-823.`
  }
];

const path = "prd.json";
const prd = JSON.parse(readFileSync(path, "utf8"));
const existing = new Set(prd.userStories.map((s) => s.id));
const dupes = stories.filter((s) => existing.has(s.id));
if (dupes.length) {
  console.error("Refusing: duplicate ids", dupes.map((s) => s.id));
  process.exit(1);
}
prd.userStories.push(...stories);
writeFileSync(path, JSON.stringify(prd, null, 2) + "\n");
console.log(`Appended ${stories.length} stories (US-804..US-828). Total: ${prd.userStories.length}`);
