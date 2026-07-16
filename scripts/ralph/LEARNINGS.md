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
- If the build runs with NO `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` in the
  shell, the prerender step aborts (`supabase.ts` throws) and leaves `dist/` as
  the raw template (`<!--prerender:body-->`, two `<title>`s). That makes every
  dist-reading test fail together — `prerender/__tests__/prerender.test.ts` AND
  `src/test/responsive-images.test.ts` (landing logo). It's an env gap, not a
  code regression; a properly-env'd build prerenders and they pass.
- `src/lib/concurrency.test.ts` ("slow item does not stall the other lanes") is
  timing-flaky under full-suite load (e.g. right after a build) — it passes when
  re-run in isolation (`npx vitest run src/lib/concurrency.test.ts`). Not a
  regression; re-run alone to confirm before chasing.
- `src/pages/legal/__tests__/accessibility-axe.test.tsx` similarly times out
  (axe-core is slow, 5s per-test cap) under full-suite load but passes in
  isolation. Same drill: re-run alone before chasing.
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
  set) — a static top-of-file import still runs before the env lines. The FULL
  `deno test` suite MASKS a missing env dance (one shared process: an
  alphabetically-earlier test's `Deno.env.set` already ran and supabase.ts is
  evaluated once), so a file can pass in CI yet crash run ALONE — e.g.
  `listing-photo-budget_test.ts` does. Smoke a new edge test file BY ITSELF, and
  set env with `??`-defaults so you never clobber a real value.
- Adding a cron means FOUR edits or `cron-registry-drift_test.ts` fails: the
  `/api/jobs/*` route in main.ts, a CRON_REGISTRY entry (cron-runs.ts), AND the
  generated tables in COOLIFY.md + LAUNCH_CHECKLIST.md (`cron-registry` markers)
  + CRON_SETUP.md (`cron-setup` markers). `scripts/render-cron-{docs,setup}.ts`
  only PRINT to stdout — they don't write; splice the output between the markers
  yourself (the test compares VERBATIM). Both need SUPABASE_URL/
  SUPABASE_SERVICE_ROLE_KEY set or they die on the supabase.ts import.

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

## Email subscriber registry (US-912 / US-931)
- `email_subscribers` (00278) is the shared newsletter list (used by
  broadcast-audience union + newsletter_analytics). Its status set is
  pending/confirmed/unsubscribed/bounced/cleaned; only `confirmed` is emailable.
  Public double-opt-in capture = `routes/newsletter-subscribe.ts`
  (`/api/newsletter/{subscribe,confirm}`, unauthenticated, rate-limited in
  main.ts). `suppressEmail` (email-suppression.ts) mirrors a bounce/complaint
  onto the matching subscriber row, so suppression applies to leads identically
  to users. A trigger on public.users links a lead's row to the new account by
  email on signup (dedup by email).
- Two Hono routers can share a prefix (`/api/newsletter` + the more-specific
  `/api/newsletter/scheduler`) because `app.route` registers CONCRETE paths, not
  greedy prefixes — `/subscribe` + `/confirm` never shadow `/scheduler/*`.

## Marketing consent canonical key (US-911)
- ALL marketing-consent logic now lives in PURE `lib/email-consent.ts`: a master
  `notification_preferences.marketing.email` umbrella (every send gate reads it via
  `marketingConsentDenied(prefs, source)`) + per-source granular categories
  (`weekly_newsletter`). The no-login unsubscribe link writes the `marketing`
  umbrella (NOT the old `product_updates.email`, which the send gate never read —
  that was the US-911 bug; migration 00296 backfilled old opt-outs). `marketingOptedOutEmail`
  (drip-graph) + `marketingOptedOut` (admin-growth) delegate to it. Newsletter sends
  add the `weekly_newsletter` category check on top of the umbrella.
- Adding a key to `NotificationPreferences` (src/types/database.ts) REQUIRES adding
  it to `DEFAULT_NOTIFICATION_PREFERENCES` too — `withPreferenceDefaults` rebuilds the
  blob from DEFAULT's keys only, so a key absent from DEFAULT is SILENTLY DROPPED on
  a settings save (would wipe a recipient's opt-out).

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

## Newsletter copywriter (US-918 content-ai-email)
- `lib/content-ai-email.ts` is the canonical AI issue copywriter mirroring
  content-ai-blog.ts (impure: supabase + anthropic). The PURE prompt builders +
  validate/normalize/grounding live in `content-ai-prompts.ts`
  (`buildEmailIssue{System,User}Prompt`, `normalizeEmailIssue`/`parseEmailIssue`,
  `isGroundedEmailLink`, `EMAIL_LINK_ALLOWLIST`, version `email_issue_v1`) so the
  grounding negative test runs with no env. Grounding = a CTA link is kept only if
  it's an https gradethread.com URL on the evergreen allowlist OR appears verbatim
  in the changelog inputs — invented feature links are stripped.
- AC5 dedup-on-send is a DB TRIGGER (00289 `newsletter_issue_history_on_send`),
  not app code — fires on status→sent for EVERY send path (plain dispatch + A/B
  finalize), appends topic+summary to content_history_index. So
  `content_surface` enum gained `'email'`: `ALTER TYPE ... ADD VALUE IF NOT EXISTS`
  MUST sit OUTSIDE the migration's BEGIN/COMMIT (the value must be committed
  before the trigger fn that references `'email'::content_surface` is created +
  validated by check_function_bodies). The trigger's INSERT is wrapped in a
  plpgsql EXCEPTION block so history bookkeeping can never block a send.

## Newsletter topic bank (US-917)
- The assembler's educational angle now comes from the DB `email_topic_bank`
  (evergreen, reusable) via `selectEmailTopic` (newsletter-topic-bank-job.ts), NOT
  the static `NEWSLETTER_TOPICS` catalog — that catalog is only the FALLBACK (empty
  bank) + the tuning-attribution key map (`topicByPillarAngle`). Pure select/dedup/
  refill-parse logic = `newsletter-topic-bank.ts` (no env, unit-tested). Dedup =
  bank `last_used_at` + recently-sent issues (`topic_bank_id`/pillar+angle) +
  `content_history_index` email titles, within `newsletter_topic_dedup_window_days`.
  Refill cron = `/api/jobs/newsletter-topic-bank-refill` (Haiku, tops up below
  `newsletter_topic_bank_min` → target). The angle is marked used at SHELL INSERT
  (once per period), not on send. New (pillar,angle) pairs not in the tuning catalog
  are un-biased until they earn data — graceful, by design.

## Product changelog "What's New" (US-916)
- The assembler's "what's new" now has TWO sources, in priority order: the
  dedicated `changelog_entries` table (US-916, migration 00291; curated, audience-
  gated, only `status='published'` rows) THEN `content_history_index` fills the
  remaining slots. Pure policy in `lib/changelog.ts` (`audiencesForProduct` gates
  flipdesk-only news away from grading-only issues; `selectUnsentChangelog`);
  impure DB in `lib/changelog-job.ts`. Featured entries are stamped `featured_at`
  AFTER copy persists so they aren't re-sent. Auto-capture (`autoCaptureChangelogDrafts`,
  run weekly from the assembler + a manual admin trigger) drafts entries from
  recently published blog posts — DRAFTS only (`source='auto'`, idempotent via the
  `source_ref` unique index); an operator publishes them before they ever send.
- `changelog_entries` is service-role-only (no user_id; in rls-guard SERVICE_ROLE_ONLY).
  The string-concat `CHANGELOG_COLS` projection yields `GenericStringError`, so cast
  insert/update `data` through `as unknown as ChangelogRow` (same trap as newsletter_issues).
  Admin CRUD = `/api/admin/changelog`; public feed = `GET /api/changelog` (published only).

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

## Newsletter imagery (US-920)
- AI-image cost is invisible in the spend dashboard UNLESS the model is priced in
  `system_settings.ai_model_prices` AND you log token counts: `ai_spend`/
  `ai_budget_status` RPCs re-price from tokens × that table and IGNORE the stored
  `cost_usd`. So `recordAiCall` for gpt-image-1 (cost 0 via computeCostUsd) only
  surfaces $ after 00288 seeds `gpt-image-1` AND we log estimated image-output
  tokens (`estimateImageTokens`, lib/newsletter-imagery.ts).
- Email-safe imagery split: PURE `buildEmailImageHtml`/`brandedCardUrl`/
  `resolveImageFromUrl`/`estimateImageTokens` + impure `resolveIssueImage`
  (photo via openai-images → branded Satori card on failure, never throws).
  Branded card = an absolute URL to the public `/og/social/card` Pages Function
  (Satori), NOT rendered in the Deno edge (workers-og is CF-only). Assets tracked
  in `newsletter_issue_assets` (00288, cascade-deletes with the issue).

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
- SUPERSEDED by US-913: the US-925 rewriter (`applyEmailTracking`) is hardcoded to
  `/api/drip-track` + a row-id token, so broadcast opens/clicks hit `drip_sends`
  (no match) and `campaign_recipients` stayed un-stamped (dashboard always 0).
  Broadcasts now use SIGNED tokens via `applyMarketingEmailTracking`
  (lib/email-engagement-token.ts) → `/api/email/{o,c}/:token` (routes/
  email-engagement.ts), stamping campaign_recipients by (campaign_id,user_id,
  channel='email') through the `record_campaign_email_{open,click}` RPCs (00294).
  Click destination is INSIDE the signed body (no `?u=` open-redirect). Gated by
  the `marketing_email_tracking_enabled` no-track setting. The old
  `/api/campaign-track` + `applyEmailTracking` remain only for the drip path.

## Email transport / SES deliverability (US-915)
- `deliverEmail` (email.ts) now picks transport per send via pure
  `lib/email-transport.ts`: marketing → SES v2 HTTP API (`lib/ses-api.ts`,
  SigV4 via `aws4fetch` — already in deno.json import map) when AWS creds are
  set, else SMTP; transactional ALWAYS SMTP. SES API failure falls back to SMTP
  (never drops mail). `resolveIsMarketing` HARD-GUARDS `TRANSACTIONAL_CATEGORIES`
  so account mail can never use the marketing identity (AC6 test asserts this) —
  if you add a new transactional `send*Email`, add its category to that set.
- denomailer 1.6.0 `client.send` DOES accept `replyTo` + `headers` (used for the
  SES config-set `X-SES-CONFIGURATION-SET` + List-Unsubscribe headers on SMTP).
- Warmup ramp = pure `lib/email-warmup.ts` (daily caps in settings, seeded 00292,
  `marketing_warmup_*`, off by default) folded into the broadcast batch limit via
  `effectiveBatchLimit`. Runbook: `DELIVERABILITY.md`.

## SES suppression loop (US-914)
- `email_suppressions` already existed (US-1057, 00245) with a DIFFERENT shape;
  00293 migrates it to the US-914 enum (`hard_bounce|complaint|manual|
  unsubscribe_all`, NOT `bounce`) + adds `source`/`notes`. parseSesNotification
  now returns `hard_bounce` for permanent bounces. Canonical signature-verified
  ingest = public `POST /api/email/ses-notifications` (routes/email-sns.ts);
  the legacy `/api/webhooks/ses` stays for back-compat and shares applySesFeedback.
- SNS signature verify (`lib/sns-verify.ts`) is REAL (RSA-SHA1/256 over the
  documented string-to-sign, cert host pinned to `sns.<region>.amazonaws.com`),
  fail-closed, with an `SES_SNS_SKIP_VERIFICATION=true` opt-out. X.509→SPKI is a
  manual DER walk (find rsaEncryption OID, rebuild the enclosing SEQUENCE). Pass
  crypto.subtle args as a fresh `ArrayBuffer` (toArrayBuffer/base64ToArrayBuffer)
  — strict Deno lib rejects `Uint8Array<ArrayBufferLike>` as BufferSource.
- `email_deliveries` gained a `skipped` status + `skip_reason` (00293). Skips
  are recorded by `recordSkippedDelivery` (email.ts, exported) from the live send
  path (deliverEmail) + marketing coordinator; the retry cron marks its own row
  skipped and pre-checks BEFORE deliverEmail so there's no double-record (pass
  `skipSuppressionRecord` to suppress deliverEmail's insert if you add a path).
- A complaint flips `notification_preferences.marketing.email=false` (the flag
  the coordinator's consent gate reads, via marketingOptedOutEmail) AND runs
  `evaluateComplaintRate` (rolling complaints/sends over a settings window →
  ops alert + optional newsletter_send_paused). ops-events is dynamic-imported
  inside it to avoid the email→email-suppression→ops-events→email cycle.

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

## Android conversion backlog (US-1299…US-1396)
- The Android client is REAL and this host CAN build it. `android/` is tracked
  (100+ `*.kt`, Gradle wrapper, `android-ci.yml`) and the Windows loop host has
  the toolchain (scoop temurin17-jdk + gradle; `local.properties` → `sdk.dir`).
  US-1300+ stories ARE implementable and verifiable here — US-1321…US-1328 each
  landed real `feat(android)` code. The "Device/Android-toolchain-gated" tag in
  the story `notes` predates the scaffold and is NOT a reason to refuse a story.
  (This supersedes the old "no `android/` dir, no SDK/Gradle" note, which was
  true only before 2026-06 — do not restore it without re-checking `git ls-files
  android`.)
- Verify Android work from `android/` with
  `./gradlew assembleDebug testDebugUnitTest lintDebug` (mirrors android-ci.yml).
  The web steps (tsc/build:locked/vitest) NEVER exercise Kotlin, so they are not
  sufficient evidence for these stories.
- Still genuinely ungated-able: emulator/device-only ACs (e.g. US-1396
  accessibility audit) presuppose a running app on a device. Don't fabricate an
  audit/test result — leave a note and stop without emitting STORY_DONE.

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
- `PhotoCapture.capturedAt` is NON-optional and `AutoListerReviewModel.importPicks`
  fabricates `result.creationDate() ?? .now`. That silently defeats every
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

## Frontend conventions
- Virtualizing a dnd-kit surface (US-1906 autolister workbench) has three traps:
  (1) dnd-kit measures droppables ONCE at drag start, so a group that mounts
  mid-drag never accepts a drop — pass `measuring={{droppable:{strategy:
  MeasuringStrategy.Always}}}`; (2) unmounting the node a drag STARTED from
  cancels the drag, so pin the source row/group mounted for the drag's duration
  (`pinnedVirtualIndexes`, src/lib/autolister-virtual-grid.ts — a pinned index is
  gone from `getVirtualItems()`, get its offset from `virtualizer
  .measurementsCache[i]`); (3) virtualize against the WINDOW
  (`useWindowVirtualizer` + `scrollMargin` = the list's document offsetTop), not
  an inner scroll box — that's what keeps dnd-kit's viewport-edge auto-scroll
  working for free. For a Tailwind responsive grid, columns come from the
  VIEWPORT width (`sm:`/`md:` are viewport media queries) but tile/row height
  from the CONTAINER width — conflating them under-counts columns whenever the
  sidebar makes the grid narrower than the window.
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
- The `garments` table (Garment Passports, 00256) is now in the frontend
  `Database` type (`GarmentRow`, US-1118). Client reads are RLS-scoped to
  `created_by = auth.uid()` (no client writes), so `supabase.from("garments")`
  returns only the user's own passports — no manual `.eq` needed. `tsc -b`
  resolves `.data` as `never`, so cast `as unknown as Pick<GarmentRow,…>[]`.
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

## Upgrade prompts (US-1289)
- The hard 402 upgrade modal funnels through `useUpgradeDialogStore.show()` (the
  single chokepoint — edge-fetch's `handlePaymentRequired` + the autolister
  upsell button both call it). Rate-limiting lives IN the store, gated by an
  opt-in `rateLimit:true` flag so only the AUTOMATIC 402 path is throttled;
  explicit user-click upsells omit it and always open. `show()` returns a
  boolean (false = suppressed by cooldown) so edge-fetch can fall back to a
  lightweight `upgradeReminderToast`. Cooldown policy is the pure, testable
  `lib/upgrade-prompt-rate-limit.ts` (storage-injectable, keyed by user+subject).

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

## One-call eBay prep / aspects (US-826)
- `runEbayAspectsPhase` (flipdesk-ai.ts /extract) persistence is now routed
  through the PURE `buildEbayPrepUpdate` (lib/ebay-prep.ts): a PARTIAL prep
  (category resolved but aspects unfilled — AI budget exhausted OR extraction
  threw) sets `inventory_items.ebay_aspects_refill_needed=true` (00299) so the
  deterministic NO-AI refill (`deriveAspectsFromItem` in publish-prep /
  `/category/:id/derive-aspects`, US-824) recovers it; a filled/no-specs prep
  clears the flag. Never re-invoke AI to recover a partial prep.
- iOS `AIItemFieldWriter.write` (auto-apply) REPLACES the whole
  `ai_field_sources` column. So the US-826 attribute-confirm write
  (`writeAttributes`, read-modify-merge of attributes + ai_field_sources jsonb
  via `[String: AnyJSON]`) MUST run AFTER auto-apply, or the core-field sources
  clobber the attribute sources. Only `/extract` is called from iOS (always with
  a required `item_id`); AutoLister does its eBay prep server-side (ai-listing.ts).

## eBay OAuth scopes — the two UNLICENSED ones (US-1510/1421/1967)
- `sell.negotiation` (send-offer-to-interested-buyers) and
  `commerce.identity.readonly` (seller account_handle) are DELIBERATELY omitted
  from `getScopes()` (ebay-client.ts): the Production keyset isn't licensed for
  them, and requesting an unlicensed scope makes the whole consent screen fail
  `invalid_scope` — breaking EVERY (re)connect, not just the feature. So "fix
  the 501 by adding the scope" is a TRAP; the decision (US-1967) is to keep them
  off and gate the UI. Sandbox grants them, so this can't be caught locally.
- Gate a scope-dependent UI on `GET /negotiation/capabilities` (pure resolver
  `negotiationCapability(deploymentHasScope, connectionDenied)`), probed on
  appear — NOT on a sticky flag set by a failed call, which still renders a live
  button on the first visit after launch (that WAS the US-1967 bug). Distinguish
  `feature_unavailable` (unfixable → hide the entry) from `reconnect_required`
  (this token predates a granted scope → keep it and offer the reconnect); a
  reconnect prompt for the unlicensed case is a lie. Probe failure must degrade
  to AVAILABLE — a blip shouldn't hide a working feature. Incoming Best Offers
  ride the Trading API and are unaffected by any of this.

## Consignor auto-payout (US-1112)
- A consigned item's sale auto-creates the consignor payout: PURE math/decision
  in `lib/consignor-payout-math.ts` (no env → unit-testable) +
  IMPURE engine `lib/consignor-payout.ts` (`processSaleConsignorPayout`/
  `sweepConsignorPayouts`/`maybeFireImmediateConsignorPayout`). Split mirrors the
  consignor_pnl view (net = sale_price − platform_fees − payment_processing_fees;
  share = net × split). Idempotent via the partial UNIQUE index
  `uniq_consignor_payouts_auto_sale` (00301, source='auto') — a 23505 means a
  race/re-ingest already created it. Not-onboarded consignor ⇒ row stays pending
  (queued), retried by the cron once payouts_enabled flips. Config flag
  `consignor_auto_payout_mode` (off|batched|immediate); batched cron =
  `/api/jobs/consignor-payouts`. Manual POST /payouts (source='manual') is the
  untouched override.

## Condition Index price-guide API (US-1285)
- The queryable price guide (`lib/price-guide.ts`, `/api/v1/price-guide*`) is a
  THIN composition over two existing aggregates — it adds NO new DB/comp queries:
  value range per band ← `getIndexCurveBySlug` (curve points, already
  sample-suppressed by toDto, so thin bands self-omit) folded by `bandForGrade`;
  sell-through per band ← the platform-wide `computeResaleConditionReport().bands`
  (cached in-module, 15-min TTL). Sell-through is PLATFORM-WIDE, not per-brand
  (entry carries `sellThroughScope:"platform"` to say so). Read-scoped, so it
  rides the existing `/api/v1/*` api-key auth + read rate-limit — no new scope.

## Garment Passport re-grade + condition curve (US-1282)
- A re-grade links to an EXISTING garment via `submissions.regrade_of_garment_id`
  (00315). The grading pipeline branches on it: set → `appendRegradeEvent`
  (passport-write.ts, tenant-scoped by created_by; appends a 'graded' event +
  links grade_reports.garment_id to that garment) instead of
  `createSingleHopPassport` (a fresh passport). A forged/foreign id returns null
  → falls back to a fresh seed. grade.ts validates the `regrade_of` form field's
  ownership (garments.created_by == owner, status='active') before storing it.
- The condition-over-time curve reads ONLY the PII-free `public_grade_reports`
  view (added `garment_id`, 00315), never base grade_reports — so it surfaces
  only FINALIZED (certificated + approved/modified) grades. Pure builder =
  `lib/passport-curve.ts` `buildConditionCurve` (per-factor deltas, rounded to
  1dp); endpoint returns `grade_curve`; UI = `condition-curve.tsx` (≥2 grades).

## DB schema ownership gotchas
- `grade_reports` has NO `user_id` column — ownership flows through
  `submissions.user_id` (`grade_reports.submission_id → submissions.id`). A
  migration/backfill that does `grade_reports.user_id` fails with `column
  gr.user_id does not exist`; JOIN submissions instead. (`listings`/`sales` DID
  gain `user_id` in 00146, so those are fine to scope directly.)

## Brand KB group stories (US-1717…US-1733+)
- A brand-group story ships FOUR things, not just the migration: the
  `NNNNN_*_brand_knowledge.sql` seed, any missing `BRAND_ALIASES` in
  `brand-normalize.ts` (a brand absent there PASSES THROUGH the seller's casing
  into the prompt + the eBay Brand aspect), the `sizing-charts.ts` in-code
  fallback charts, AND **two** test files — cases in
  `brand-knowledge-golden_test.ts` (resolver: recovery/never-guess/no-false-
  positive) plus a per-group `<group>-content_test.ts` (prompt block renders the
  disambiguation + `findSizingCharts` reachability). The content test is easy to
  miss; every prior group has one (`alo-yoga-`, `athleta-`, `free-people-`,
  `madewell-jcrew-`, `athleisure-content_test.ts`).
- Some brands are ALREADY covered by a SHARED multi-brand chart — the 00389
  `thenorthfacepatagoniaouterwear` row / its `sizing-charts.ts` twin matched
  north face+patagonia+columbia+arcteryx. Giving such a brand its OWN chart makes
  `findSizingCharts` return BOTH (same numbers twice, competing for the 3-chart
  prompt budget), so narrow the shared `brandMatch` in the SAME commit — in-code
  AND via an UPDATE of the DB row (US-1734 did this for columbia+arcteryx). Check
  for a shared chart before adding a per-brand one.
- `verified=false` is CORRECT and intentional on every seeded fact even though
  the AC says "marked verified before the story passes" — verification is the
  US-1715 human admin queue's job. Every prior group shipped verified=false; do
  not flip it to true to satisfy the AC (that fabricates a human review).
- Seed only what a source supports: `tag_eras` is populated for heritage brands
  (Levi's/Carhartt/Lululemon) but left EMPTY for modern athleisure (Alo/Athleta/
  Free People/US-1733's six) — no authoritative era documentation exists. Same
  rule for decoders: seed `brand_style_codes` ONLY for a code that is both
  tag-printed and regular (of US-1733's six, only Under Armour qualifies); a
  web/catalog SKU is an informational tell, never a decoder.
- `canonicalizeBrand` returns `string | null` (NOT an object) — assert
  `canonicalizeBrand("x") === "Brand"`; `isKnownBrand` is what separates a
  curated entry from a passthrough.
- A SHORT brand token is a live hazard, and the two matchers differ:
  `sizing-charts.ts` `findSizingCharts` matches `brandMatch` by SUBSTRING
  (`brand.includes(m)`) and `detectBrandInText` regex-scans CANONICAL_BRANDS over
  free text — so a 2-3 letter entry false-fires (`"patagonia".includes("ag")` is
  TRUE, so a bare `"ag"` hands every Patagonia garment AG's denim charts).
  `BRAND_ALIASES` is an EXACT-key lookup, so the short form is safe THERE. Fix
  (US-1735): make the canonical the long form ("AG Jeans"), keep the short form as
  an alias key only, and never put it in `brandMatch` — the chart is then reached
  via the canonical, which is what brand-knowledge.ts passes anyway.

## prd.json / Ralph workflow
- Never read or edit `prd.json` from inside an iteration — the harness selects
  the story (`current-story.json`) and flips `passes:true` for you.
- A story whose AC says "ships atomically with US-XXXX" / "do not publish before
  those pass" must NOT be implemented before those deps are `passes:true`.
  Prerequisites are now declared explicitly via a story's `dependsOn` array and
  the harness will NOT select a story until its `dependsOn` are satisfied (so you
  should never be handed a blocked story — if you somehow are, its `dependsOn`
  is incomplete; do NOT emit STORY_DONE, leave a note and stop). Concrete case:
  US-1298 (guarantee remedy copy) `dependsOn` US-1279 + US-1280 (coverage-gating
  + grade-fee-back MECHANISM). `buyer-guarantee.tsx` is public marketing copy
  with NO feature gate, so editing it = publishing a live remedy promise; don't
  write the remedy copy before the mechanism lands — that's the liability the
  story warns about.
- New stories use `prd.json.nextId` then bump it (NOT `max(id)+1` — done stories
  live in `prd.archive.json`, so that would reuse ids).
- Optional per-story fields the harness understands:
  - `"hard": true` → iteration runs on `$HARD_MODEL` (Opus). The default model
    is now Opus too, so this is a no-op unless `RALPH_DEFAULT_MODEL` is lowered.
  - `"model": "opus"|"sonnet"|"haiku"` → exact model for that story (overrides
    `hard`). Env `RALPH_FORCE_MODEL` overrides all stories for a one-off sweep.
  - `"relevantPaths": ["src/...", "..."]` → file/glob hints the agent reads
    first instead of sweeping the tree (see GRAPHIFY_PILOT for auto-populating).
