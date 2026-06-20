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
- `deno check` with MULTIPLE roots can surface SPURIOUS errors: if you pass a
  root that doesn't import `lib/observability.ts` (the `declare module "hono"`
  augmentation that adds `correlationId` to ContextVariableMap) alongside
  `main.ts`, grade.ts fails with `c.get("correlationId")` not assignable. CI runs
  `deno check src/main.ts` ALONE — verify with the single-root form, not a
  multi-file invocation.
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
- The drip is split across pieces: analytics tables (00253: drip_enrollments/
  sends/attributions) record what the engine did; the editable step-graph
  DEFINITION lives in `drip_campaigns` (00255, service-role only, no user_id so
  rls-guard doesn't auto-discover it); the admin BUILDER (`src/pages/admin/
  drip.tsx` + builder routes in `admin-drip.ts`) edits/validates/simulates it; and
  the SENDING ENGINE is now wired (US-943, see below) — it reads
  `drip_campaigns.graph` + the pure evaluator in `lib/drip-graph.ts`
  (`planTick`/`simulateJourney`/`validateGraph`/`renderStep`).
- `lib/drip-graph.ts` is dependency-free (no supabase/env) so its test imports
  without the env dance; keep AI/supabase/email imports in the route file only.
- US-944 added the per-step A/B optimizer (`lib/drip-optimizer.ts`, also pure):
  epsilon-greedy weight shift toward the highest-CONVERTING arm (click is only a
  secondary tiebreak), exploration floor for losers, auto-retire of high-unsub
  arms. The optimizer is STATELESS per call — it must be fed the CUMULATIVE
  windowed ledger (`drip_sends`/`drip_attributions`), not per-round deltas, or a
  retired arm with 0 new traffic falls back below `minSample` and re-enters as a
  survivor (oscillates). `optimizeGraph` keys stats by 1-based ordinal =
  `drip_sends.step`. Conversion is attributed per (step,variant) by joining each
  send to its enrollment's attribution. `graph.autotuneEnabled` (optional, off by
  default) is the autonomous gate the future engine tick reads.

## system_settings seed gotcha
- A `system_settings` seed row's `value_type` must be one of `'number' | 'bool' |
  'string' | 'json'` (00208 check constraint) — `'boolean'` is REJECTED at apply
  time (`system_settings_value_type_check`), only caught by `verify:db`. Use `'bool'`.

## Newsletter per-recipient personalization (US-921)
- Per-recipient dynamic blocks: PURE `lib/newsletter-personalization.ts`
  (`personalizeIssueSections` = recap "your week" + tailored CTA prepended, then
  `substituteTokens` over the issue copy — unknown/missing `{{token}}` collapses to
  "" so "undefined" never renders; zero/null activity ⇒ evergreen CTA + no recap)
  + IMPURE `lib/newsletter-personalization-job.ts` (`resolveActivityBatch` =
  chunked `.in(user_id,…)` over users/submissions/listings/sales/inventory_items,
  O(chunks) not N+1; `resolvePersonalizationForBatch` folds the per-issue
  `newsletter_issues.personalize` toggle (00287) AND `newsletter_personalization_*`
  settings). Wired into EVERY send path: `deliverIssueRecipient` (new optional
  `personalization` param → dispatch cron + A/B start/finalize) and the console
  `/send` inline loop. No AI is re-run per user (O(1) AI per issue).

## Newsletter program (US-930 console)
- The autonomous newsletter has NO dedicated issue/engine table before US-930 —
  US-931's `email_subscribers` + `newsletter_analytics` RPC was analytics only.
  US-930 (migration 00279) added the durable substrate the engine stories
  (US-918 copywriter, etc.) populate: `newsletter_issues` (full lifecycle enum
  draft→ready_for_qa→awaiting_review→approved→sending→sent + `blocked`) and
  `newsletter_issue_recipients` (per-issue resolved/skipped-with-reason ledger).
  Both service-role-only (in rls-guard SERVICE_ROLE_ONLY); cols are created_by/
  approved_by/subscriber_user_id (NOT `user_id`) since it's an operator surface.
- Pure lifecycle/render/QA/schedule helpers live in `lib/newsletter-issue.ts`
  (no supabase/env → unit-testable): `canTransition`/`isEditable`/`runIssueQa`/
  `renderNewsletterHtml`/`nextScheduledRun`. The console route
  (`routes/admin-newsletter.ts`, /api/admin/newsletter/{program,issues/*}) owns
  the DB/email side. Master controls: pause = `newsletter_send_paused` setting,
  approval = `newsletter_require_approval` setting, kill-switch = the `newsletter`
  feature flag (FeatureKey). Approve/reject/send/program-toggles are super_admin +
  requireStepUp + audited; send routes each recipient through coordinateMarketingSend.
- `supabaseAdmin.from("newsletter_issues").select(cols).maybeSingle()` returns
  `data` typed as `GenericStringError` (unknown table to the generated Database
  type) → `data as NewsletterIssueRow` fails `deno check`; cast through
  `as unknown as NewsletterIssueRow` (same `tsc -b never` trap on the web side).

## Newsletter pre-send QA gate (US-924)
- The autonomous guardrail gate is split: PURE `lib/newsletter-qa.ts`
  (`runGuardrailQa` structural/compliance checks over issue+rendered ctx +
  `computeSpamScore`/`findPlaceholders`/`isAbsoluteLink` + `decideGateOutcome`
  routing) + `lib/newsletter-ai-editor.ts` (cheap-model brand-voice/factual pass;
  pure `parseEditorResult`/`buildEditor*`, impure `runAiEditorPass`) glued by the
  impure `lib/newsletter-qa-job.ts` (`runIssueGuardrailGate` renders → scans →
  AI → `decideGateOutcome` → persists qa_results + status + ops alert). Reusable
  from the console route AND the sibling autonomous engine.
- `newsletter-ai-editor.ts` DYNAMIC-imports ai-config.ts/ai-feature-context.ts
  inside `runAiEditorPass` (both chain into lib/supabase.ts → throw on unset
  SUPABASE_URL) so the pure parser/prompt builders unit-test with no env dance.
- Fail-safe: AI editor model error ⇒ `ran:false` ⇒ gate routes to
  `awaiting_review` (never auto-approve an unverified issue). Outcome: hard QA/AI
  fail → blocked+alert; inconclusive OR `newsletter_require_approval` →
  awaiting_review; else approved. Thresholds are settings keys (seeded 00284):
  `newsletter_qa_{spam_score_max,subject_max_length,preheader_max_length,
  require_preference_center,ai_editor_enabled,link_check_enabled}`.

## Newsletter kickoff trigger (US-923)
- The ONE external touchpoint is `POST /api/newsletter/scheduler/tick`
  (routes/newsletter-scheduler.ts) — own auth (NEWSLETTER_INTERNAL_JOB_SECRET /
  signed / admin JWT), job-lock "newsletter-kickoff", records cron_runs itself
  (in CRON_REGISTRY, NOT under /api/jobs). Each tick: create (cadence-gated via
  pure `kickoffDue` in newsletter-webhook.ts) → advance gateable issues through
  `runIssueGuardrailGate` → `runNewsletterDispatch`. It SUPERSEDES the standalone
  `/api/jobs/newsletter-dispatch` cron (calls the same dispatcher) — don't run both
  or issue.sent can fire from the cron path unnoticed.
- Issue assembly now lives in `lib/newsletter-assembler.ts` (`assembleNextIssue` +
  `NEWSLETTER_ISSUE_COLS`), shared by the console build-next button AND the kickoff
  tick — edit the assembler, not the route, so they never drift.
- US-922 made `assembleNextIssue` the FULL autonomous orchestrator (no longer a bare
  scaffold): changelog→topic→copy→imagery→render→finalize, persisting status
  `ready_for_qa`. Idempotent per `newsletter_issues.period_key` (partial UNIQUE, 00286)
  + resumable via the `build_steps` jsonb ledger (reuses done copy/imagery on a retry
  so AI isn't re-spent). "What's new" = recent `content_history_index` rows minus every
  prior issue's `featured_content_ids` (no dedicated changelog table). Copy =
  `lib/newsletter-copy.ts` (pure builders/parse + impure `generateNewsletterCopy` that
  NEVER throws — degrades to `evergreenCopy` so AC3 "lean evergreen" holds). Config =
  `lib/newsletter-settings.ts` singleton (reads the seeded `newsletter_assembler_*` keys).
- Lifecycle webhook (`lib/newsletter-webhook.ts`): HMAC-signed
  (NEWSLETTER_WEBHOOK_SIGNING_SECRET, X-Newsletter-Signature), retried 0/5/30s,
  per-attempt logged to `newsletter_webhook_log`, target = settings key
  `newsletter_make_webhook_url` (empty = disabled). Mirrors content-webhook.ts.

## Newsletter self-tuning (US-928)
- Closed loop = PURE `lib/newsletter-tuning.ts` (catalog + `computeWeights`
  [CTR-first winner, exploration floor, unsub-ceiling PAUSE→weight 0] +
  `selectWeightedKey` [FNV, never picks a 0-weight key] + `recommendSendHour`)
  feeding the analysis pass `lib/newsletter-tuning-job.ts` (DB) → settings stores
  `newsletter_{topic_weights,subject_style_weights,send_hour_stats,tuning_recommendations}`
  (migration 00281). Cron `/api/jobs/newsletter-tuning` (job-secret, recorded by
  the /api/jobs middleware). `build-next` reads the stores to bias topic/style/
  send-hour and STAMPS `newsletter_issues.{pillar,angle,subject_style,send_hour}`
  (00281) so the next pass can attribute engagement. Console card + GET
  `/api/admin/newsletter/tuning` for transparency; override via settings registry.
- Engagement source = `newsletter_issue_recipients.{opened_at,clicked_at,
  unsubscribed_at}` (00281). Pixel/unsub POPULATION is a sibling; the column home
  + aggregation are this story's substrate (cold start ⇒ uniform weights, correct).

## Newsletter subject A/B test (US-927)
- PURE logic = `lib/newsletter-ab.ts` (normalizeVariants/planHoldout/assignVariant
  [FNV]/aggregateVariantStats/selectAbWinner [min-sample → fallback default]/
  isMeasurementWindowElapsed). Two-phase send in `lib/newsletter-ab-job.ts`:
  `startAbTest` (console `/send` branches here when issue has ≥2 `subject_variants`
  + `newsletter_ab_test_enabled`) sends the holdout with variants assigned + leaves
  status `sending`/ab_phase `testing`; the `newsletter-ab-finalize` cron (or console
  POST `/issues/:id/ab/finalize`) picks the winner from holdout opens/clicks and
  sends it to the remainder → status `sent`/ab_phase `completed`. Variant + holdout
  flag live on `newsletter_issue_recipients` (NOT campaign_recipients — that's the
  growth-broadcast surface). Idempotent via upsert onConflict (issue_id,email) +
  the ab_phase gate. Operator override: POST `/ab/winner` sets ab_winner_source
  'operator' which finalize honors over auto-selection (migration 00282).

## Durable broadcast send (US-925)
- The US-627 growth broadcast EMAIL channel is now durable: `dispatchCampaign`
  (admin-growth.ts) routes each email through `sendCampaignEmailDurable` →
  `coordinateMarketingSend` (consent + suppression + email_deliveries outbox),
  NOT `sendBroadcastEmail` (which fired an un-retried SMTP send). Audience =
  segment `iterateSegmentUsers` UNION confirmed `email_subscribers` deduped by
  email (pure `partitionExtraSubscribers`, lib/broadcast-audience.ts). The send
  is bounded per tick by `marketing_send_batch_limit` (SES warmup); overflow
  stays `status='sending'` and `handleGrowthDispatchCron` resumes it
  (`dispatchCampaign(id,{resume:true})`). Idempotency = the `done` set now treats
  campaign_recipients rows 'sent' OR 'skipped' as terminal. Click/open tracking
  uses the campaign_recipients row id as token → public `/api/campaign-track/{o,c}`
  (sibling of /api/drip-track, mirrors routes/drip-tracking.ts). No migration —
  campaign_recipients already had opened_at/clicked_at.

## Marketing send coordinator (US-934)
- Any NEW marketing email must route through `coordinateMarketingSend`
  (lib/marketing-coordinator.ts) — the single chokepoint for consent (US-911),
  suppression (US-914), the per-recipient daily cap, quiet hours, and the
  drip-precedence pause. Don't re-implement those gates per sender. Pass a
  fully-rendered `html` (layout + unsubscribe + tracking already applied); a
  capped/paused send is DEFERRED to the email_deliveries outbox, not dropped.
  Pure decision lives in `lib/marketing-frequency.ts` (no supabase → test it
  directly). The drip records its sends via `recordMarketingSend` so the cap
  counts cross-program. Cap/quiet-hours config = settings registry keys
  `marketing_frequency_cap_per_day` / `marketing_quiet_hours` (seeded 00276).
  Transactional mail must NOT route through it (never capped).

## Trial-conversion drip ENGINE (US-943)
- The autonomous sending loop IS now wired: `POST /api/drip/tick` (routes/drip.ts,
  mounted at /api/drip with its OWN auth — DRIP_INTERNAL_JOB_SECRET / signed
  request / admin JWT — NOT under any /api/* JWT group). It enrolls trialists,
  evaluates active enrollments via the PURE `planTick` (drip-graph.ts), sends the
  ONE due step per enrollment per tick (catch-up safe, frequent-safe), and exits
  on conversion/completion/opt-out. Job-locked ("drip-tick"), self-gates on
  `drip_enrollments.next_evaluation_at` (00267). Records to cron_runs as
  "drip-tick" (added to CRON_REGISTRY). Honors the campaign kill via
  `isFeatureEnabled("trial_conversion_drip")`.
- `drip_sends.step` is the 1-based index of the step in `graph.steps` (matches the
  optimizer's ordinal) — NOT the path position. The engine stamps it that way.
- /api/drip/tick is NOT under /api/jobs/*, so the cron_runs MIDDLEWARE doesn't
  record it; the handler calls `recordCronRun({jobName:"drip-tick", …})` itself.

## Trial-conversion drip DURABLE/TRACKED send (US-938)
- The engine no longer calls `deliverEmail` directly — it uses
  `sendDripStepEmail` (email.ts): wraps the rendered fragment in `emailLayout`
  (CAN-SPAM postal + one-click unsubscribe footer), applies the open/click
  tracking rewriter (`applyEmailTracking`, email-tracking.ts), and on a live SMTP
  failure enqueues to `email_deliveries` (category `drip:<campaign>:<step>`) so
  the US-498 retry cron does backoff + dead-letter. delivered||enqueued ⇒ "sent".
- Per-(enrollment, step) idempotency = a UNIQUE index on `drip_sends
  (enrollment_id, step)` (00272) + `upsertSend` (onConflict that pair). Skips are
  recorded on the SAME row via `skip_reason` (sent_at stays null → not counted as
  sent → planTick re-evaluates next tick). A SEND reserves the row (sent_at null)
  to mint the tracking token (= drip_sends.id), then stamps sent_at.
- The dispatch gate is the PURE `evaluateSendGate` (drip-graph.ts): consent
  (opt-out) / no-address / suppression EXIT the journey; frequency-cap / QA-gate
  failure only SKIP (retry next tick). The engine resolves the booleans
  (isEmailSuppressed, lastSentMs vs FREQUENCY_GAP_MS, qaCheckEmail) and feeds them
  in — keep the policy pure so the AC6 "suppressed/opted-out is not sent" test
  needs no DB.
- Open/click pixels are PUBLIC + unauthenticated → mounted at `/api/drip-track`
  (a SIBLING of /api/drip, NOT nested) so the drip job-auth `/*` middleware never
  applies. A `Uint8Array<ArrayBufferLike>` is not a valid `BodyInit` under Deno's
  strict lib — back the pixel `Response` with a concrete `ArrayBuffer` (`.buffer.slice(...)`).

## Trial-conversion drip INCENTIVE (US-942)
- The conversion incentive is config-gated on `graph.incentive` (DripIncentive,
  off by default — validated in drip-graph.ts). The `{{incentive}}` token has NO
  hardcoded fallback anymore: renderStep injects it ONLY when step.incentiveEnabled
  AND a resolved RenderableIncentive is passed; otherwise empty (value-only email).
- Server-side eligibility is `isIncentiveEligible` (drip-graph.ts, pure):
  win_back phase + step.incentiveEnabled + !converted. In-trial steps NEVER
  surface a code even if their toggle is on (AC: never expose outside win-back).
- `lib/drip-incentive.ts` (Stripe-touching) resolves the live coupon → label +
  enforces the maxPercentOff guardrail; engine calls it ONCE per tick. On an
  eligible send the engine stamps `users.pending_drip_coupon(+_expires_at)` (00268,
  mirrors pending_referral_coupon) so payments.ts flipdesk/subscribe pre-applies
  it as `discounts:[{coupon}]`, and flips `drip_enrollments.incentive_enabled`
  (the existing incentiveSplit analytics + attribution pick it up). Webhook
  clears the pending coupon on subscription.created.

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

## DB schema ownership gotchas
- `grade_reports` has NO `user_id` column — ownership flows through
  `submissions.user_id` (`grade_reports.submission_id → submissions.id`). A
  migration/backfill that does `grade_reports.user_id` fails with `column
  gr.user_id does not exist`; JOIN submissions instead. (`listings`/`sales` DID
  gain `user_id` in 00146, so those are fine to scope directly.)

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
