---
title: Ralph learnings — the always-read playbook
type: learning
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-08-02
tags: [agent, ralph, learnings]
summary: Recurring gotchas the Ralph loop reads on every iteration; kept short on purpose because its cost is per-iteration.
---

> [!warning] Read every Ralph iteration — keep it small
> This file's cost is paid on EVERY loop iteration, which is why `prd-lint`
> warns past 800 lines and why the topic logs were split out. Append terse,
> durable bullets only.
>
> Moved into the vault by US-2061. It is a **vault note now**: the frontmatter
> block above is load-bearing and `vault-lint` fails the build if it is
> disturbed. Durable RULES belong in the domain notes — see
> `scripts/ralph/CLAUDE.md` for the write protocol.
# Ralph Learnings — durable gotchas playbook

Read every iteration. Keep it SMALL (target < 150 lines). One terse bullet per
durable, non-obvious trap. Prune anything stale. This is cheap persistent
memory — not a progress log (the harness records progress separately).

## Topic playbooks — read ON DEMAND, not every iteration

This file is read on EVERY Ralph iteration, so it holds only what is
cross-cutting. Three epic-specific bodies of knowledge were split out — nothing
was deleted, and each is still the authoritative playbook for its surface. Read
the matching file IN ADDITION to this one when your story touches it:

- `learnings/ios.md` — iOS / Swift (~314 lines). Any story touching `ios/`.
- `learnings/brand-kb.md` — Brand Knowledge Base (~284 lines). Brand KB group
  stories (US-1717…US-1733+) and `brand_knowledge`/`brand_styles`/
  `brand_size_charts`/`brand_colorways`.
- `learnings/email-marketing.md` — newsletter, broadcast, drip, SES (~350
  lines). The US-911…US-946 family, send coordinator, suppression loop.

Why: at 1308 lines this file cost every iteration the price of all three epics,
which is how the 800-line warning in prd-lint had been firing unread. If you add
a learning that only matters to ONE surface, put it in that surface's file.


## Build / verify
- `npm run build` does NOT run vitest — it only typechecks + builds. Run the
  tests separately or you ship a red `main`. **Run `npm run verify --web`, not
  `npm test`.** `npm test` is `vitest run` with NO coverage, and CI runs
  `npm run test:coverage`, which enforces FAILING thresholds (statements 65,
  branches 58, functions 62, lines 67). So `npm test` can be green while CI is
  red on coverage alone — the same trap that made `vault:lint` weaker than its
  CI step until 2026-08-02 (US-2391). `npm test` is fine as the fast inner
  loop; it is not the gate, and this line used to say it was.
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
- A `*.test.cjs` under `extension*/test/` must NOT `require()` the extension's
  own `.js` files: the root `package.json` is `"type": "module"`, so Node loads
  them as ESM and hands back an EMPTY namespace — the UMD `module.exports` shim
  never runs and every assertion dies on `x is not a function`. Use the
  `loadIntoSelf` pattern (`new Function("self","module", src)(selfObj, {exports:{}})`,
  see `extension-unified/test/depth.test.cjs`), which is also the only way to see
  what the file publishes on `self`.
- Edge tests that SCAN SOURCE TEXT for a literal multi-line snippet (e.g.
  `condition-alerts_test.ts` US-2317 looks for `.from("saved_searches")\n    .select(`,
  `ebay-bulk-revise_test.ts` US-2404) FAIL ON THIS WINDOWS HOST and pass in CI:
  git checks the tree out with CRLF, so the `\n` in the needle never matches the
  `\r\n` on disk. The HEAD blob is LF and `git diff --stat` shows no whitespace
  churn, so it is a checkout artifact, not your change — confirm by checking that
  the scanned file is untouched (`git status --porcelain <file>` empty) and move
  on. Don't "fix" the test.
- Adding a cron means FOUR edits or `cron-registry-drift_test.ts` fails: the
  `/api/jobs/*` route in main.ts, a CRON_REGISTRY entry (cron-runs.ts), AND the
  generated tables in COOLIFY.md + vault/10-ops/launch-checklist.md (`cron-registry` markers)
  + CRON_SETUP.md (`cron-setup` markers). `scripts/render-cron-{docs,setup}.ts`
  only PRINT to stdout — they don't write; splice the output between the markers
  yourself (the test compares VERBATIM). Both need SUPABASE_URL/
  SUPABASE_SERVICE_ROLE_KEY set or they die on the supabase.ts import.



## Agent cohabitation (co-running loops)
- A CO-RUNNING loop that commits with `git add -A` / `git commit -a` will SWEEP
  YOUR STAGED FILES INTO ITS OWN COMMIT — staging early does not reserve them.
  US-1987's 7 files landed inside a US-1979 commit, leaving the US-1987 commit
  holding only the file staged afterwards. Nothing is lost and the tree stays
  green, so it is silent: `git status` just goes clean and `git show --stat HEAD`
  is missing your work. Stage and commit in ONE step, as late as possible, and
  check `git log -1 -- <your file>` after committing. Do NOT try to rebase/reset
  it apart afterwards — the other loop is still writing to `main` and history
  surgery races it. Report the mis-attribution instead.



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



## system_settings seed gotcha
- A `system_settings` seed row's `value_type` must be one of `'number' | 'bool' |
  'string' | 'json'` (00208 check constraint) — `'boolean'` is REJECTED at apply
  time (`system_settings_value_type_check`), only caught by `verify:db`. Use `'bool'`.



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
- A story blocked on MEDIA someone must create (video, photos, a data report) is
  usually not blocked on its CODE. Build the render path behind a **publish
  gate** — one predicate both the component and the JSON-LD builder call, true
  only when the real asset's id is present — then the markup cannot describe
  something that doesn't exist, and shipping becomes a paste job. US-1689 was
  deferred whole for two runs on "VideoObject for a nonexistent video would be
  fake markup"; the gate is the answer to that, not deferral. Put the derived
  naming (title/tags) in code too, so the human can't publish off-series.
  Extend a SHARED builder (`garmentGuideJsonLd`) rather than the page — the
  prerender calls the same function, so parity holds with no second wiring.
- Two traps when widening a marketing page (US-1691): (1) a route's
  `description` in `src/lib/seo/public-routes.ts` is budget-checked at 70–160
  chars by `seo/__tests__/route-metadata.test.ts` — extending the copy to cover
  a new section blows it, and the page's own `<MarketingLayout description>`
  must be edited in the SAME step or prerender and SPA disagree. (2) An SSR test
  asserting a bare phrase ("By the numbers") passes off the FAQ copy that merely
  MENTIONS the section; assert the heading (`"By the numbers</h2>"`) so the
  unseeded/negative case can actually fail.
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



## When you cannot finish a story
- If a story has an AC no iteration can satisfy (a golden set someone must
  photograph, a scope someone must apply for), land what IS completable, commit,
  then end with `<promise>STORY_BLOCKED</promise> <one line on what a human must
  do>`. The runner drops it for the rest of the run, records it in progress.txt
  and prints it in the end-of-run summary — WITHOUT setting passes:true. Stopping
  silently instead looks identical to a crash to the runner, so selection
  re-picks the story every iteration; US-1997 cost three full runs that way.
  Never emit both tokens. Full contract: `scripts/ralph/CLAUDE.md`.

## Native binaries in the edge image
- Adding an apt package to `services/edge-functions/Dockerfile` (US-1762 added
  `ffmpeg`) is testable LOCALLY — Docker and trivy are both on this host, so run
  the CI gate verbatim rather than guessing: `docker build -t x services/edge-functions`
  then `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:0.65.0
  image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 x`. Use the
  **PowerShell** tool for the trivy run — Git-Bash rewrites `/var/run/...` into a
  Windows path and docker refuses it. Install alongside the existing `curl` line
  so it shares the fresh `apt-get update` and lands patched (ffmpeg scanned 0
  HIGH/CRITICAL that way). Also bump `deno.json` tasks AND the Dockerfile `CMD`
  together — the container runs an explicit permission list, so a new
  `Deno.Command`/temp-file path is a silent `PermissionDenied` until
  `--allow-run=<bin>` + `--allow-write=/tmp` are added to BOTH.

## Public certificate columns
- A publicly-visible `grade_reports` column must be added to BOTH read paths in
  the same commit: the edge allowlist (`CERT_REPORT_COLUMNS`, content-public.ts,
  read by the SSR cert) AND the `public_grade_reports` VIEW (read by the SPA via
  `.select("*")`). Extending one and stopping has shipped twice (US-2392's
  `certified_content_updated_at`, US-1997's `rubric_key`/`factor_scores`) — the
  view path fails silently because the `as PublicGradeReportRow` cast still
  compiles and the field just reads `undefined`. Guard:
  `src/test/public-grade-report-view-parity.test.ts`. Rule:
  [[public-certificate-read-paths]].

## A new AI feature needs BOTH economics config surfaces
- Metering a new `ai_usage_events.feature` reaches the admin dashboards through
  TWO `system_settings` rows, not one: `ai_feature_economics` (the OBSERVED
  per-feature table + margin) and `ai_usage_scenarios` (the modeled PROJECTIONS).
  `ai_profitability()` projects only features a scenario lists volumes for, so
  adding the first and stopping leaves every scenario projecting as if the
  feature did not exist — silently, since the observed table looks complete.
  US-1762 did exactly that for `video_grading`; US-1765 added the volumes.
  Model a feature that REPLACES another (video grade vs photo grade) by moving
  volume between them, never by adding on top — additive invents spend against
  revenue the scenario doesn't have. Also add the slug to `FEATURE_LABELS`
  (src/pages/admin/ai-spend.tsx) or it renders as the raw slug.

## Telemetry consent
- Adding a new kind of telemetry NEVER reuses an existing opt-in toggle, even
  when a story's own notes suggest it (US-1757 did). Each toggle's copy states
  what it sends; folding a second data flow under it makes a sentence someone
  read before agreeing false, retroactively. New data ⇒ new toggle, new storage
  key, new line in the privacy policy AND `SUBMISSION.md`. Revoking must also
  delete any batch still on the device. Full contract:
  [[extension-telemetry-consent]].

## Scaffolding modules
- A module that is "shipped but not yet wired" is NOT thereby correct — nothing
  calls it, so nothing can produce a wrong answer from it, so no test has a
  reason to check it. `rubric.ts`'s per-rubric `defectRouting` sat for months
  keyed on seven invented defect names; `coerceDefectType` folds any unknown
  string to `other`, so every one of those routings was unreachable (US-1997).
  Before extending a scaffold, first assert its declared invariants — that its
  keys really are members of the taxonomy/enum it says it reuses. Full case:
  [[shipped-but-unwired]].

## An allowance is inert until something spends it
- A NUMBER in a plan matrix (`activeAlertsCap`, `portfolioItemCap`, credits) is
  decoration until a call site reads it and refuses. The parity test cannot see
  this — it compares advertised to enforced, and two agreeing numbers nothing
  reads pass it perfectly. When the row is written CLIENT-SIDE under RLS there is
  no route to guard, so gate the OUTCOME instead (US-1805 caps in the matching
  engine, not on the insert). Rule + the bound/unbound table: [[buyer-platform]].

## DB schema ownership gotchas
- `grade_reports` has NO `user_id` column — ownership flows through
  `submissions.user_id` (`grade_reports.submission_id → submissions.id`). A
  migration/backfill that does `grade_reports.user_id` fails with `column
  gr.user_id does not exist`; JOIN submissions instead. (`listings`/`sales` DID
  gain `user_id` in 00146, so those are fine to scope directly.)



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
- `priority` sorts **ascending** — lowest number first — and a story with no
  `priority` is unranked and sorts last. Never hand-roll the comparison; import
  `comparePriority` from `scripts/lib/prd-priority.mjs`. Full rule and the two
  defects it fixed: [[backlog-priority-contract]].
- Optional per-story fields the harness understands:
  - `"hard": true` → iteration runs on `$HARD_MODEL` (Opus). The default model
    is now Opus too, so this is a no-op unless `RALPH_DEFAULT_MODEL` is lowered.
  - `"model": "opus"|"sonnet"|"haiku"` → exact model for that story (overrides
    `hard`). Env `RALPH_FORCE_MODEL` overrides all stories for a one-off sweep.
  - `"relevantPaths": ["src/...", "..."]` → file/glob hints the agent reads
    first instead of sweeping the tree (see GRAPHIFY_PILOT for auto-populating).



## Related

- [[agent-knowledge-surfaces]] — how this relates to skills, memory and the vault
- [[backlog-priority-contract]] — which story the loop picks next, and why
- [[ralph-brand-kb-log]] · [[ralph-ios-log]] · [[ralph-email-marketing-log]] — the on-demand topic logs
- [[INDEX]]
