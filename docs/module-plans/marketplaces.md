# Marketplaces, listing & crosslisting (eBay, autolister, publish, sync)

Health: **ok**

The core queues are in good shape. AutoLister generation and bulk publish follow the durable-jobs contract: atomic claims, attempt caps, per-item timeouts under the stale window, reclaim crons registered in COOLIFY.md, and an idempotent publish that adopts an existing listing instead of making a duplicate. The real gaps are in the two queues beside AutoLister that never got the full contract. Scheduled publish has no attempt cap, and the extension work queue never takes back a stale claim, which can leave a sold item live on another marketplace for up to 7 days. The backlog also overstates the open work: several stories are code-complete and only wait on an operator step.

## Actions

### 1. Put an attempt cap on scheduled publish (publish-due) so a broken draft stops retrying every 10 minutes

Impact: high | Effort: S | Story: none

**Why:** services/edge-functions/src/routes/flipdesk-ebay.ts:12250-12256 selects due drafts where publish_claimed_at is null or older than PUBLISH_CLAIM_STALE_MS (10 min, :12196). It never checks publish_failed_at or an attempt count. On failure (:12337-12354) the route writes publish_error and publish_failed_at but leaves both the claim and scheduled_publish_at in place, so the row becomes eligible again 10 minutes later, forever. No publish_attempts field exists anywhere in the edge code, even though AutoLister's publish worker caps at MAX_PUBLISH_JOB_ATTEMPTS (flipdesk-autolister.ts:2422). A draft with a permanent blocker such as a missing aspect or a revoked token makes about 144 publish attempts a day, each spending eBay API calls. The only tests are the five publishBatchLimit cases in tests/publish-due-batch_test.ts:20-49, and none covers the failure path. The failure write also stamps the scan-time `now` (:12343, :12352), not the time the item actually failed.

**Steps:**
- Migration (US-1108 triple): add listings.publish_attempts int not null default 0 (load the migrations skill).
- In both conditional claim updates (:12300-12320), increment publish_attempts and add .lt('publish_attempts', 5); keep them as sequential .eq chains with no .or() (US-1552).
- On terminal failure (attempts >= 5), clear scheduled_publish_at, keep publish_error, and send the seller a notification that the scheduled publish gave up.
- Stamp publish_failed_at with new Date() at the moment of failure, not with the scan-time now.
- Add a deadline check inside the loop (:12280) so the tick stops claiming new rows once it gets close to the 240s acquireJobLock lease (:12226).
- Deno tests: a failing row is retried at most 5 times, and a successful retry resets nothing it should not.

### 2. Give the extension work queue a server-side stale-claim reclaim so a dead browser cannot strand a delist for 7 days

Impact: high | Effort: M | Story: none (related: US-3061, US-3453)

**Why:** POST /claim (routes/flipdesk-extension-queue.ts:760) sets status='claimed' and claimed_at but never increments attempts. The attempts column (00588_extension_work_queue.sql:104) is written only as 0 on insert (:622). The only cleanup is expireStaleQueueRows (lib/extension-queue-stale.ts area, defined at flipdesk-extension-queue.ts:134-143 import), which moves queued/claimed rows to 'expired' once expires_at passes, and expires_at defaults to now()+7 days (00588:114). Nothing moves a stale claimed row back to 'queued': the only status:'queued' write in the module is the insert at :621. The extension's US-3061 fixes (extension-unified/background.js:2745-2760 unsent-results store and :2905-2920 claim-only-what-you-can-start) cover a lost /complete POST and over-claiming, but not a tab or browser that dies mid-job before any result exists. For a sold-elsewhere delist job that means the sibling listing stays live on Poshmark or Mercari for up to a week, which is a double-sale risk. US-3061 and US-3453 describe the symptom from the seller's side but neither asks for a server reclaim.

**Steps:**
- Pick a claim TTL per job kind (for example 15 min for delist, 30 min for list), longer than the extension's own per-job timeout.
- In /claim, before the read, requeue rows where status='claimed' and claimed_at < now - TTL, set attempts = attempts + 1, scoped .eq('user_id', ownerId) (US-268). Use sequential conditional updates, not .or().
- Fail rows terminally past an attempts cap (for example 3) with a result the delist log (lib/delist-log.ts) can show.
- Make /complete idempotent for a row that was requeued and then completed by the original browser (accept only when status is claimed and claimed_by matches, or the row is already done).
- Add a tenant-isolation_test.ts case and a pure test for the requeue plan.
- Update the vault note on the queue rules (closing-a-coverage-gap.md) in the same commit.

### 3. Make an AutoLister generation timeout actually stop the work, and stop duplicate eBay drafts

Impact: medium | Effort: M | Story: none

**Why:** withTimeout (flipdesk-autolister.ts:242-253) is a Promise.race. It rejects after GENERATION_TIMEOUT_MS=240s (:126) but does not cancel generateListing. The catch at :578-584 refunds the AI action and marks the job failed while the orphaned call keeps going. The Anthropic client alone can run 120s x 3 tries (lib/ai-config.ts:26-27), so the orphan is a normal case, not a corner case. The orphan then writes the draft (lib/ai-listing.ts:3488-3520) after the job has already been marked failed: the seller gets paid-for AI work with the quota refunded, and a retry runs a second AI call. That draft write is select-then-insert on (inventory_item_id, platform='ebay', listing_status='draft'), and no migration defines a unique index on listings for that key (grep of supabase/migrations finds only ingested_listings and sales). An orphan and a retry running together can both see no draft and both insert one.

**Steps:**
- Thread an AbortSignal from the job into generateListing and on to the provider call, and abort it when withTimeout fires.
- Before the draft write in ai-listing.ts, recheck that the job is still 'running' when batchId is set. If it is not, return without writing.
- Dedupe existing duplicate eBay drafts, then add a partial unique index on listings(inventory_item_id, platform) where listing_status='draft' (migrations skill; check the extension-writeback and composer inserts first).
- Replace the select-then-insert with an upsert on that index.
- Add a test in autolister-reliability_test.ts: a timed-out generation writes no draft, and two concurrent generations leave one draft.

### 4. Clean up the module backlog: close or reduce stories that are already built

Impact: medium | Effort: S | Story: US-2727, US-3362, US-2395, US-2326, US-2617, US-3367, US-3468

**Why:** Several open prd.json stories are code-complete and wait only on operator steps. That makes the module look less finished than it is and hides the real gaps. Evidence: US-2727's migration exists (supabase/migrations/00634_listings_listed_at_nullable.sql) and its notes describe the fix landing. US-3362's fix is in the tree (buildEbaySkuIndex keyed on listings.inventory_sku, flipdesk-ebay.ts:2796-2821), and its notes record 25+ passing tests with no open item. US-2395's revise-by-group is in (resolveReviseStrategy at flipdesk-ebay.ts:9588) and its notes say 'STILL OPEN: AC7 ONLY' (a live eBay check). US-2326's freshness window is in (flipdesk-webhooks.ts:184-197, :253) and only an operator staging check is left. US-2617's KNOWN_UNREACHABLE_CRONS is now empty (tests/cron-registry-drift_test.ts:338) and only Coolify steps are left. US-3367 is 'OPERATOR AC only'. US-3468 has three commits today (4d09c17, 0262aa3, 930db69) and empty notes.

**Steps:**
- For US-2727 and US-3362, run the tests their notes name, then close them with scripts/prd-story.mjs done.
- For US-2395, US-2326, US-2617 and US-3367, cut the remaining work to a single [OPERATOR] AC each, then close the code part or retitle the story as operator-only.
- Add a completion note to US-3468 for the three commits that landed, or close it.
- List the operator steps (live variation revise, staging EDGE_ENV check, Coolify task registration, extension origin env var) in one checklist so the owner can clear them in one sitting.

### 5. Split flipdesk-ebay.ts (15,530 lines, 124 routes) into route files by concern

Impact: medium | Effort: L | Story: none

**Why:** routes/flipdesk-ebay.ts is 15,530 lines with 124 flipdeskEbayRoutes handlers (grep count). It mixes OAuth, the listings pull, publish, publish-due, promoted-sync, promotions, negotiation and revise in one file. Pure helpers (buildEbaySkuIndex :2796, publishBatchLimit :12207) are exported from the route file itself, so every unit test that imports them loads the whole route module. The file has already drifted from its documentation: CLAUDE.md says the deliberate 501s are classified at flipdesk-ebay.ts:1840-1850, but that block is now at :2545-2555, and :1840 is validateItemPromotion.

**Steps:**
- Move pure helpers into lib/ first (SKU index, publish batch limit, revise strategy), with no behavior change and the existing tests repointed.
- Split the routes into flipdesk-ebay-{oauth,pull,publish,jobs,promoted,negotiation}.ts sub-routers mounted on the same /api/flipdesk/ebay prefix. Confirm no path changes with a route-table snapshot test.
- Keep the tenant-isolation_test.ts and cron-registry-drift_test.ts source scans green, since both read route files by path.
- Fix the CLAUDE.md pointer to the 501 classification (or point it at a symbol, not a line number).

### 6. Add a render test for the Marketplaces page

Impact: low | Effort: S | Story: none

**Why:** src/pages/flipdesk/marketplaces.tsx is 2,476 lines. It holds the eBay setup wizard (EbaySetup :652, EbayLocationDialog :236, EbayPoliciesDialog :351), Shopify setup (:959), promoted listings (:1103), sold-sync (:1502) and the extension queue section (:1699). src/pages/flipdesk/__tests__ has no marketplaces test. The src/test files that mention it (ebay-policy-setup, cross-post-channels, marketplace-coverage-stated and others) are source scans or helper tests, not a render of the page. A regression in the connect or setup flow, which is the first thing a new reseller touches, would only show up in production.

**Steps:**
- Add src/pages/flipdesk/__tests__/marketplaces.test.tsx with mocked queries covering: disconnected eBay shows the connect step; connected with missing policies shows the policies dialog trigger; the extension queue section renders counts.
- Add one Playwright case using page.route mocks for connect, then policy setup (the e2e suite runs without credentials per CLAUDE.md).

## Risks

- The extension queue gap is the one that costs money: a delist job stranded in 'claimed' leaves a sold garment live on another marketplace for up to 7 days.
- Publish-due retrying failed drafts without end could draw on eBay's call limits during the eBay Application Growth Check (US-3042).
- Adding a unique index on eBay drafts needs a dedupe pass first. Prod may already hold duplicate draft rows, and the migration fails if it does.
- Many module stories end in [OPERATOR] steps (live eBay revise, Coolify task registration, EXTENSION_ALLOWED_ORIGINS). Code work cannot close them, and they will keep looking open until the owner acts.
- Not run here: the edge Deno suite and a live eBay call. Every finding above comes from reading code and grepping migrations, not from running the code.
