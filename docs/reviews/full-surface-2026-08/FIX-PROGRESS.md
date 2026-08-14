# GradeThread review fixes — progress tracker

The review (20 batches, both apps, every page) is COMPLETE. Findings are in
REVIEW-FINDINGS.md. 52 stories filed as US-2503..US-2554 (committed d4eb27d8).

This tracker drives the FIX loop. Goal: fully complete the fixes of that review.

## Rules for each iteration

1. Read this file. Take the FIRST story not marked done.
2. Read the story: `node scripts/prd-story.mjs show US-####`
3. Implement it against its acceptance criteria. Ground every change in the files
   the ACs name — they carry real line numbers from the review.
4. Verify before claiming done:
   - `npx tsc -b` (NOT --noEmit, it is weaker)
   - `npm run lint`
   - `npm run ui:check` (baseline is ZERO)
   - relevant vitest suites
   - iOS stories cannot be built on Windows — the macOS CI lane is the gate. Say so.
5. Close it: `node scripts/prd-story.mjs done US-#### --note "Done <date>. <what changed>"`
6. **Archive after closing**: `node scripts/archive-passing-stories.mjs`. Closing a
   story leaves `passes:true` in prd.json, and `src/test/prd-archive-integrity.test.ts`
   fails until it is moved to prd.archive.json. Check no Ralph/hub loop is running
   first (`Get-CimInstance Win32_Process … -match 'ralph'`); `node hub/mcp/server.js`
   is an MCP server, not the editing loop, so it does not block. Commit BOTH json files.
7. Commit to LOCAL main. Do NOT push. A commit containing a MIGRATION is never
   pushed until the user OKs it — package it in PENDING_MIGRATIONS.md instead.
8. Mark the line below `[x]` with the commit sha, and append anything learned.

## Order

Work in priority order (ASCENDING — lowest number first). Do not skip ahead
unless a story is blocked; if blocked, note why and move to the next.

### P1 — do these first
- [ ] US-2503 (1800) iOS buyer tools unreachable — DEFERRED, see note below
- [ ] US-2504 (1802) Walk-around video grading web-only — DEFERRED, see note below
- [x] US-2505 (1804) Human-review claim lock bypassable — DONE d97a307d
- [x] US-2506 (1806) /condition-index 404s on every public page — DONE 117e99cc

### P2 — systemic sweeps (highest leverage)
- [x] US-2507 (1900) Admin error-state sweep — CLOSED 2690f22d (698b387e, 2670bd76,
      92ada4e9, 9745474e). Both MISLEADING shapes fixed + hard-guarded. Tail of 9
      multi-query pages re-scoped to US-2555 (priority 2430) behind the ratchet.
- [x] US-2508 (1902) Buyer reload-as-retry — DONE dfe13a49
- [x] US-2509 (1904) Five hand-rolled buyer paywalls + buyer 404 — DONE 78839879
- [x] US-2510 (1906) Notification centre — DONE fc35e596. NO migration needed: the table,
      RLS, enum, notifyUser (26 callers) and a MOUNTED seller centre all already existed.
      My review finding was WRONG; corrected in REVIEW-FINDINGS.md B1. Real gap was the
      BUYER shell, now fixed + guarded. Offer/return emission + iOS badge → US-2556.
- [x] US-2556 (1907) — CLOSED 5537e567 as ALREADY BUILT, no code written. US-1055 ships
      the whole pipeline (lib/marketplace-event-notify.ts + its own cron), deduped by a
      claim-before-deliver row, 19 tests green incl. the exact idempotency case I asked
      for. My filing was wrong; REVIEW-FINDINGS.md B1 corrected. iOS badge → US-2557.
- [x] US-2511 (1908) Duplicate account routes — DONE a36be351. RENDERS the hub with the
      tab preselected rather than redirecting (Stripe returns, the cancellation link,
      the drip CTA, Connect's return and the unsubscribe deep-link all point at those
      paths). 21 links repointed, not 12.
- [x] US-2512 (1910) Admin ops — DONE 98fdf3c2, RE-SCOPED on evidence. The 10-to-1
      framing was wrong: reliability is grading studies, Mission Control is the agent
      fleet, and system vs ops/health serve different audiences. REAL fix: both rendered
      the title "System Health"; now Platform Health / Infrastructure Health, guarded
      class-wide (no duplicate admin page title or sidebar label).
- [ ] US-2558 (2432) /admin/jobs shows read-only copies of crons + dead letters that the
      ops pages own with Run-now and replay — remove the weak tabs, do NOT fold the ops
      pages away
- [x] US-2513 (1912) Six ambiguous admin nav names — DONE 3cb82d1d. Finding HELD this
      time (read all six pages first): all distinct pages, badly-named. 3 pairs renamed
      in nav AND page heading; 3 were already resolved by US-2512/2505/2558. Guard now
      rejects a label that is a whole-word PREFIX of another — the shape this defect
      actually takes.
- [ ] US-2559 (2434) Four admin clusters (rewards 5, newsletter 4, AI 4, abuse 3) into
      tabbed hosts — VERIFIED distinct, so it is a merge not a de-dupe; keep
      reward-economics' payout kill switch immediate

### P2 — page level
- [x] US-2514 (1914) Pricing page has no buy button — DONE 7f5e451e. 11 prices now each
      carry a CTA; added the RECEIVING side for ?tier= and ?buy=credits so no CTA
      passes a param its destination ignores. Monthly/annual toggle added.
- [x] US-2515 (1916) Bulk upload names dead plans — DONE 67cffa65. Gate copy now built
      from FLIPDESK_PLANS + typed plan keys. Found a SECOND instance: /developers
      advertised an Enterprise API rate-limit row the server has never had.
- [x] US-2516 (1918) Bulk batch has no cost preview — DONE b1a24d8e. Pure estimator +
      confirm dialog + Stop batch + retry-failed-rows. Found that a 201 with
      payment.paid=false was being counted as a success, so unpaid rows looked graded.
- [x] US-2517 (1920) Search reports outage as "No matches" — DONE d8afadb6. ErrorState +
      retry, recent searches shared with the palette via src/lib/recent-searches.ts,
      keyboard nav. The palette dropped the same RPC error and now flags it too.
- [x] US-2518 (1922) CSV import: client loop, no undo — DONE c7503659. Durable server run
      (2 tables + worker + reclaim cron), undo from recorded effect rows, CSV template,
      shared Progress. ⚠ MIGRATION 00592 IS HELD — apply SQL + edge BEFORE any push, or
      the auto-deployed frontend 404s the Import button.
- [x] US-2519 (1924) Item page: 4 queries on one row, 12 panels — DONE c3be46e0. One
      shared use-item-listings hook, 4 tabs (Details default, alerts stay above them),
      Back via location.state.from, one grade nudge at a time.
- [x] US-2520 (1926) Split web AutoLister — DONE fbc15437. 6 modules extracted, 3 files
      down ~1,070 lines, shared BatchNav across Generate/Queue/Bulk edit, shrink-only
      ratchet. ⚠ The DnD staging grid + groups section deliberately NOT split — needs a
      browser session, see the story note.
- [x] US-2521 (1928) Return rows never name the item — DONE e42af569. Thumbnail + title +
      price + eBay case link on both rows, resolved via sale order id / listing item id.
      AC4: returns already notify (US-1055); cancellations filed as US-2560 (needs an
      enum migration, and 00592 is already held).
- [x] US-2522 (1930) Scheduled drops is read-only — DONE ed66b084. Day dialog with
      reschedule/unschedule/shift-the-day, role=grid + roving tabstop, "+N more",
      Upcoming show-all.
- [x] US-2523 (1932) Settings: 14 cards — CLOSED 695b3154 as ALREADY BUILT. US-1441 had
      already split it into 8 tabs with Security together and Danger its own tab. My
      finding came from the file's LINE COUNT, not its TabsContent boundaries. Shipped
      the missing guard only. (4th stale premise this loop: 2510, 2556, 2512, 2523.)
- [x] US-2524 (1934) Billing: duplicate meters, no invoices — DONE 1132708c. Marketplaces
      meter moved INTO the shared component (the only reason for the 2nd copy), new
      GET /api/payments/invoices + InvoiceHistory card, trial banner names the real plan,
      store banner deep-links to Apple/Play subscription settings.
- [x] US-2525 (1936) Support: no attachments, no refresh — DONE 74e5b109. Attachments via
      the US-276 path into the EXISTING private bucket (no new bucket), 30s poll, user-side
      close, both ErrorStates. ⚠ MIGRATION 00593 HELD (after 00592). iOS half → US-2561.
- [x] US-2526 (1938) Free tools blame the photo on rate limit — DONE d9acd70f. code
      'rate_limited' on all 6 edge 429s + ToolLimitNotice on both photo tools + Buyer
      CTAs on authenticity/fit + result CTA off /how-it-works. fit-checker has NO
      endpoint, so its "limit branch" would be dead code — guard pins that absence.
- [x] US-2527 (1940) Subprocessors missing Google + Apple — DONE 6b632949. NOT legal
      drafting, just stating what the code calls, so no counsel needed. Added Google,
      Apple, Etsy, Depop, Whatnot, Shopify. The new host-vs-list guard found a 7th I had
      missed (api.remove.bg, optional, uploads a garment photo when its key is set).
- [~] US-2528 (1942) Terms predate 4 products — BLOCKED ON COUNSEL (its own AC5 says so).
      Engineering half DONE 9aa82ce6: docs/legal/terms-update-brief-2026-08.md, all four
      gaps verified against the code, draft language marked draft, terms.tsx untouched.
      ⚠ DO NOT close this without the user's counsel signing off on the copy.
- [x] US-2529 (1944) No SEO on 5 auth pages — DONE 52ad9c30. 6 pages titled; the 4 with
      a token or an account state are noindex. /leaderboard already had SEO via
      MarketingLayout (my grep for '<SEO' missed the indirection) — guard pins that it
      must NOT get a second copy.
- [x] US-2530 (1946) No password reveal / strength — DONE 3b589dff. Shared PasswordField
      in components/AUTH (components/ui is hook-blocked as shadcn-generated), all 4
      inputs, meter on signup+reset only, persistent role=alert sign-in error.
- [~] US-2531 (1948) Shopify web-only — DEFERRED (iOS, unverifiable here)
- [~] US-2532 (1950) Workspace 2FA policy web-only — DEFERRED (iOS)
- [~] US-2533 (1952) Return analytics web-only — DEFERRED (iOS)
- [~] US-2534 (1954) iOS a11y labels missing — DEFERRED (iOS). All four noted in prd.json: no swiftc/xcodebuild on Windows, and the macOS lane only runs on a PUSH this branch must not make while 00592/00593 are held.
- [~] US-2535 (1956) Onboarding taxonomies diverge — DEFERRED (iOS) + a PRODUCT DECISION
      the owner must make first: iOS asks reseller/grader/store, the DB CHECK allows
      seller/buyer/consignment/developer, and 2 of the 3 collapse. 3 options + my
      recommendation are in the prd note. No code written.
- [x] US-2536 (1958) Content editors lose unsaved fields — DONE a581d9e0. Shared
      useNavigationGuard on both, dialog NAMES the dirty fields, off while saving.
- [x] US-2537 (1960) Dashboard: 8 promos before the data — DONE 1ad35cdc. Data first,
      usage rendered once (the duplicate card carried an Infinity% divide-by-zero on
      Free plans), quick action off the redirect.
- [x] US-2538 (1962) Tier change can double-charge — DONE ea0b45d3. Change tier keeps
      the submission id; Submit re-prices via /api/grade/pay/:id BEFORE any upload work.
      Review step now uses the same GradePricingSummary (one tier control, with the
      payment consequence shown).
- [x] US-2539 (1964) Buyer cancel is one click — DONE d38d7674. Shared
      CancelSubscriptionDialog with a product prop (buyer consequences, no pause/
      downgrade), reason onto the SUBSCRIPTION metadata not the seller column, full
      feature lists, annual saving computed from the plans.
- [x] US-2540 (1966) MeasureCard US-only, no picture — DONE 5d58ecbf. The table, the
      endpoint and the fulfilment CSV had ALWAYS carried country; only the form never
      sent it. Country select + mirrored server allowlist + guard comparing the two,
      card diagram drawn from MEASURE_CARD_V1, A4 print advice from its real
      dimensions, failed status read no longer reads as 'never requested'.
- [x] US-2541 (1968) Offers/post-sale eBay-only — DONE 270c7e4a. Coverage STATED, not
      built: 5 of the 11 marketplaces have no public API, 3 have one that stops at
      listings. New lib/marketplace-coverage.ts derives the split from
      LISTING_PLATFORMS so a new platform defaults to UNCOVERED; reasons keyed off
      MARKETPLACE_MECHANISM so this and the Marketplaces page cannot disagree. Also
      fixed the 3 post-sale empty states, not just the messages one the AC named.

### P3
- [x] US-2542 (2400) UI craft-floor sweep - `706eab0f` - 17 pages to PageHeader, 26 tracked-uppercase headings converted (106 -> 80), 13 logos sized, guard `src/test/ui-craft-floor.test.ts` (22 cases)
- [x] US-2543 (2402) Long secondary pages need structure - `9ee344d9` - rewards 9->3 tabs, referrals 8->3, verified 7->3, marketplaces 8->3; connection summary + profile preview added; promo code moved to Billing; guard `src/test/long-page-structure.test.ts` (16 cases, 12 red)
- [x] US-2544 (2404) Submissions: no search, permanent empty disputes - `76ed6c1d` - search + date range applied to BOTH sort branches, visible sort direction, row selection + selected-CSV, phone card layout, disputes collapse on empty; guard `src/test/submissions-list-filters.test.ts` (17 cases, 14 red)
- [x] US-2545 (2406) Submission detail: no lightbox - `30ac87b4` - same ImageLightbox as the certificate, two-buttons-one-destination collapsed to one, five post-grade cards into one "What's next" section; guard `src/test/submission-detail-evidence.test.ts` (10 cases, 7 red)
- [x] US-2546 (2408) Intake: no photos, no guard - `f204e6a9` - IntakePhotoStager on the main form uploading through an EXTRACTED shared core (`src/lib/item-photo-upload.ts`), navigation guard, MeasurementForm persisted to `inventory_items.measurements`, real `required` attribute; guard `src/test/intake-capture-and-guard.test.ts` (13 cases, 12 red)
- [x] US-2547 (2410) Overview tiles promise a filter that isn't applied - SHA - stage
      tiles narrow via the VISIBLE filter, one server aggregate (migration 00594,
      HELD) replaces the whole-account loop, date range in ?range=, show-all on
      both list cards; guard `src/test/overview-stage-and-range.test.ts` (15 cases,
      12 red)
- [x] US-2548 (2412) Tabbed hosts show no name - SHA - five hosts (the four named
      plus the Account hub) render their own PageHeader; AccountHubContext
      generalised to PageHostContext; 7 children moved off a hand-rolled h1;
      shared HostViewSkeleton; Analytics range lifted AND the query string kept
      across tab clicks; guard `src/test/tab-host-headers.test.ts` (46 cases, 29 red)
- [ ] US-2549 (2414) Embed widget missing noindex
- [ ] US-2550 (2416) Failed integrity check gives buyer nothing to do
- [ ] US-2551 (2418) Anonymous tag claim
- [ ] US-2552 (2420) Buyer onboarding taxonomy
- [ ] US-2553 (2422) Buyer home never completes
- [ ] US-2554 (2424) Snap history + API keys placement

## Notes carried between iterations

- Two stories are LEGAL, not engineering: US-2527 and US-2528. They ship when
  counsel signs the copy. Do not invent legal text — draft it and flag for review.
- US-2503, US-2504, US-2531..US-2534 are iOS. They cannot be built or tested from
  this Windows checkout; `iOS CI` on macOS runners is the gate. Only
  `python3 ios/Scripts/no-ungated-print.py` runs locally.
- ~~US-2510 needs a new table~~ WRONG, corrected: public.notifications has existed since
  migration 00007. No migration was needed. US-2556 needs none either — it reuses the
  buyer_notification_log dedupe ledger from 00412.
- US-2506 was taken FIRST, out of priority order, because it was live-broken on every
  public page and fully verifiable in minutes. Recorded so the deviation is deliberate.
- Lesson from US-2506: adding a router path for an edge-SSR'd page trips the US-291
  PUBLIC_ROUTES guard. The fix is an exemption entry with a reason, not a registry
  entry — /finds and /leaderboards set that precedent. Expect the same for any future
  SPA-fallback route over a Pages Function.
- Prove a new guard test fails without the fix (git stash the fix, run it, restore).
  A guard that has never gone red is not known to guard anything.

- **No backticks in a --note argument.** The shell executes them even inside double
  quotes, and the text silently vanishes from the note. Write the expression in words,
  or use a heredoc. (Cost one follow-up commit on US-2507.)

- **python3 does not exist on this host** and neither does a `python` on PATH for
  scripted edits. Use `node -e` for one-liners, or write a .mjs into the scratchpad and
  run it — but note that a `node -e` string with regex escapes is very easy to get
  wrong; the .mjs file is the reliable route.

- **A long mechanical tail belongs behind a ratchet, not a hard assertion.** Asserting the
  ideal on day one leaves the suite red for many iterations, which trains everyone to
  ignore it. A shrink-only allowlist locks in every fix immediately, blocks new
  offenders, and — because the test ALSO fails when a listed file was fixed but not
  removed — cannot rot into a stale suppression. Reserve hard assertions for the shapes
  that actively mislead.

- **Write the guard, then let IT find the work.** Twice now the guard found offenders a
  hand-written scanner missed: the empty-state pass named 12, and the infinite-skeleton
  pass named 5 when my own regex had found only 3. Do not pre-compute the offender list
  and trust it — assert the property and read the failure.

- **`isError` placed AFTER a `isLoading || !data` guard is dead code.** react-query
  leaves `data` undefined on error, so the loading guard always wins. growth/buyer.tsx
  had a fully-written error branch that could never render. When adding an error branch,
  it goes FIRST.

- **A coverage claim needs a DERIVED source, not a sentence.** "This page covers
  eBay" typed into copy is wrong the day a second platform lands, and nobody
  notices because prose has no compiler. Deriving the covered/uncovered split from
  the platform registry makes a new marketplace show up as uncovered by default,
  which is the truthful answer, and makes the guard able to check it.

- **Before building a capability, check whether the BACK END already has it.** The
  MeasureCard story read as "support international addresses", which sounds like
  schema work. The column, the handler and the fulfilment export had all shipped with
  the feature; the form was the only layer missing it. Reading the migration and the
  route first turned a day into an afternoon — and the same check is what caught
  US-2523 and US-2556 being already built.

- **A migration guard must assert `>=`, never `==`.** My US-2518 test pinned
  `EXPECTED_SCHEMA_VERSION = "00592"` exactly, so it went red the moment US-2525 added
  00593. The property is "the edge never expects a schema older than the table this
  story added", and a guard every later story has to edit is a guard nobody reads.

- **A multi-line search string in an edit script must use the FILE's newline.** Half the
  replacements in the support-page script silently no-op'd: the file is CRLF, my search
  strings were LF, and the script's `if (s === before)` guard still passed because the
  SINGLE-LINE replacements had matched. Read back every anchor, or use the Edit tool.

- **Never put `${...}` or a backtick inside a double-quoted bash string.** Bash expands
  both before node sees them, and it fails SILENTLY into mangled output — `dayLabel={}`
  and a JSX expression that just stopped mid-line. Same defect as the `--note` backtick
  incident. Any edit script carrying template literals goes in a `.mjs` file, always.

- **`npm run vault:lint` after any commit that touches a file in a note's `code_refs`.**
  It runs `--strict` in CI, so drift on a `type: contract` note is an ERROR. Five notes
  had gone red across this loop's earlier commits before anyone ran it (9fdf4148). Most
  were link repointing that changed nothing a note claims — check the claim against the
  diff, then bump `reviewed`. Do NOT bump to silence it: nothing can catch that.

- **A new edge router mount needs THREE middleware lines, not one.** `authMiddleware`,
  `workspaceMiddleware` and a `rateLimiter` are separate `app.use` blocks hundreds of
  lines apart in main.ts, and `flipdesk-auth-coverage_test.ts` only catches the missing
  auth one. Also: a new RLS policy must use `(select auth.uid())`, not `auth.uid()` —
  `rls-guard_test.ts` enforces the initplan form.

- **A new cron means five files, and the drift guard will name them.** CRON_REGISTRY,
  main.ts, COOLIFY.md, CRON_SETUP.md and launch-checklist.md (regenerate the last three
  with the two render scripts) plus the literal count sentence in vault/10-ops/deploy.md.
  The render scripts import the supabase client, so they need `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` set to anything at all to run.

- **`const { data } = await supabase.rpc(...)` is a silent-failure shape.** supabase-js
  RESOLVES with `{ data: null, error }` instead of throwing, so a try/catch around it is
  decoration and the page renders an empty state for a real outage. Grep for
  `const { data } = await (` before trusting any "it falls into the catch" story. Both
  hits in src/ were the same RPC, one page apart.

- **A 2xx is not proof the thing was paid for.** /api/grade/submit returns 201 with
  payment.paid=false when checkout is required, so the bulk loop counted an unpaid
  submission that will never be graded as a success. Read the BODY, not just
  response.ok, on any endpoint that runs a payment precedence.

- **Cancel has to be a ref read before the charge, not state.** The loop is already
  running when Stop is clicked, so it never sees a re-render. Checking the ref at the
  TOP of each iteration is also what keeps a stopped batch from leaving a half-made
  payment.

- **When a story names one instance of a copy bug, grep for the rest before closing.**
  US-2515 was filed against the bulk-upload paywall; the same dead tier names were on
  the PUBLIC /developers page, quoting an API rate limit the server never grants. Two
  minutes of grep turned a one-screen fix into a class fix. Legacy enum values
  (`professional`, `enterprise` in user_plan) are the usual source — a shim maps them
  internally and nobody notices they leaked into copy.

- **A CTA carrying a parameter its destination ignores is the original defect wearing
  a button.** /pricing's tiles needed ?tier= and ?buy=credits; neither page read them.
  Shipping the links alone would have looked fixed and preselected nothing. When
  adding a deep-link, grep the TARGET for `searchParams.get("<param>")` first, and
  assert it in the guard — pricing-has-ctas.test.ts checks both ends.

- **Name the DEFECT SHAPE in the guard, not the instance you happened to find.** The
  admin-nav guard started as "no two page titles are equal", which would have missed
  every real case: the ambiguity was always a whole-word PREFIX — Support / Support
  Tickets, Knowledge / Knowledge Base, System / System Health. Ask what shape the bug
  takes across the codebase, then assert that.

- **A consolidation story must be read against the pages before it is believed.** Three
  of the review's consolidation findings have now shrunk or inverted on contact with
  the code (US-2510, US-2556, US-2512). The pattern: I grouped pages by the WORDS in
  their nav labels rather than by what they do. Before merging admin surfaces, read
  each one's PageHeader subtitle and its action set — the richer page must survive, and
  "duplicate" often means "one is a read-only copy of the other", which is a removal,
  not a merge.

- **Guard the CLASS, not the instance.** Fixing one duplicate title is worth little;
  asserting no two admin pages share a title stops the next 80. Same shape as the
  footer-link and error-state guards.

- **A bulk find-and-replace WILL hit a guard test that asserts the old value.** The
  US-2511 link repoint rewrote src/test/email-preference-anchors.test.ts, a US-2102
  guard whose whole point is that the unsubscribe link must be /dashboard/settings and
  must NOT be /dashboard/account. The rewrite left the two assertions contradicting
  each other, and it would have shipped green only because the file it guards had
  ALSO been rewritten. Always `git diff` a bulk edit and read every test file it
  touched before committing.

- **Check what points at a URL from OUTSIDE the app before redirecting it.** Grep
  services/edge-functions for the path: Stripe return URLs, transactional email links,
  drip CTAs, unsubscribe links and OAuth/Connect returns are all baked in and cannot
  be repointed by editing src/. Rendering the new surface at the old path beats a
  redirect whenever a money path or an emailed deep-link is involved.

- **TWICE NOW: grep for the CAPABILITY, not the shape.** US-2510 and US-2556 were both
  filed on premises that were false, and both cost an iteration to discover.
    * US-2510: searched for NotificationBell / useNotifications; the component is
      called NotificationCenter and was already mounted.
    * US-2556: searched for `type: "offer_received"` as an inline literal at a
      notifyUser call site; the types are built inside a NotifyInput in a lib module,
      invoked from a dedicated cron.
  BEFORE filing or implementing any story whose premise is "X does not exist", check:
  (1) supabase/migrations for the table and enum, (2) services/edge-functions/src/lib
  for a helper module named after the DOMAIN, (3) main.ts for a cron route, (4) the
  edge test folder for a suite named after the feature. Any one of those four would
  have caught both.

- **Grep for the CAPABILITY, not the name you expect.** US-2510 was filed claiming no
  customer notification centre existed. It did — mounted, working, called
  NotificationCenter rather than the NotificationBell/useNotifications I searched for.
  A whole story's premise was wrong. Before filing "X does not exist", grep the DB
  migrations and the edge lib for the behaviour, not just src/ for a component name.

- **Fixing a duplication story usually orphans imports.** Deduping five paywalls left an
  unused Lock in all five and an unused react-router Link in one. tsc -b catches these
  as TS6133 and it is the LAST step, so budget a second pass. lint alone does not.

- **Do not write &amp; into a JSX ATTRIBUTE string.** Entity decoding differs between JSX
  text children and attribute literals; a bare & is correct and unambiguous in an
  attribute. Caught in review before it shipped a literal "&amp;" into a page title.

- **Editing a CRLF file with node string.replace works, but the Edit tool is safer.**
  One `node -e` replace silently no-op'd on a CRLF file (grid-image-lazy.test.ts)
  because the anchor spanned a newline. Verify with grep after any scripted edit.

- **The edge test command needs its permission flags.** `deno test src/tests/` alone
  produces ~673 bogus "uncaught error" failures — every suite that reads
  `Deno.env.get("SUPABASE_URL")` at module scope. The real command, from
  `services/edge-functions/deno.json` and `scripts/verify.mjs:237`, is:
  `deno test --allow-net --allow-env --allow-read`. Do NOT report a red edge
  lane without the flags; memory says a deno failure is a real regression, so a
  false red burns a whole iteration.

- **US-2503 and US-2504 are DEFERRED, deliberately, and here is why.** Both are
  large iOS features (a multi-screen buyer surface; a video capture + upload
  pipeline) and neither can be compiled, run or tested from this Windows
  checkout — only `python3 ios/Scripts/no-ungated-print.py` runs locally, and
  even that is unavailable (no python3 on this host; `node -e` is the substitute
  for scripted edits). Writing thousands of lines of unverifiable Swift inside a
  5-minute loop iteration would ship code whose first compile is in CI.
  What they need before they are worked:
    * a macOS session, or
    * decomposition into slices small enough that a CI round-trip per slice is
      an acceptable feedback loop (e.g. entitlement plumbing first, then one
      screen at a time).
  Everything below them in the list is fully verifiable here, so the loop keeps
  making real progress rather than stalling on the two it cannot check.

### Lessons from US-2542
- `git grep -- "src/pages/**/*.tsx"` does NOT match files directly under
  `src/pages`. Two passport.tsx headings silently escaped the sweep and only
  turned up when I counted by hand. Scope a git pathspec by DIRECTORY
  (`-- src/pages src/components`) and filter the extension in JS.
- A codemod that inserts attributes must run ONCE over the whole element. Two
  passes (single-line then multi-line) hit the elements the first pass had just
  expanded, so 13 files got `width`/`height` twice (TS17001).
- Anchoring a JSX close on `s.indexOf("      </div>")` also matches an
  eight-space `        </div>`, because the deeper line CONTAINS the shallower
  pattern. Line-anchor it: `` `\n${close}` ``.
- A sweep guard is worth writing even when the sweep is done, because it finds
  what the sweep missed. This one went red on an `<h4>` in photo-upload.tsx.

### Lessons from US-2543
- `indexOf` is the wrong tool for a CLOSING anchor. Cutting blocks out of
  rewards.tsx, the tail `    </div>
  );
}` matched an early-return block
  3,400 chars in, so every cut computed a NEGATIVE range. Use `lastIndexOf`
  for a tail, and always check `b < a`, not just `b < 0`.
- Moving a control off a page leaves three things behind, not one: the JSX,
  the useState pair, and the handler. tsc found all three as TS6133, so run it
  before assuming a cut is finished.
- A tab guard has to assert that `defaultValue` names a tab that EXISTS.
  A default pointing at a value no trigger declares renders a blank page, and
  no other test in this repo would notice.

### Lessons from US-2544
- A page with TWO query branches for the same list (here: sort-by-date and
  sort-by-score) will grow a filter that only one of them honours. Put the
  filters in one helper and have the guard COUNT the call sites. The symptom
  otherwise is "the data changed when I clicked a column", which nobody files.
- Collapsing an empty state must NOT collapse the error state. "You have no
  disputes" and "we could not load your disputes" look identical once
  collapsed, and one of them is a lie about the user's own data.
- `sanitizeSearch` existed in admin/users.tsx only. Grep for a guard before
  writing a second one: the PostgREST `.or()` comma/paren trap needs one copy.
- MIGRATIONS 00592 + 00593 were applied by the user on 2026-08-14, and
  everything through `76ed6c1d` is PUSHED. The rule resets from here: the next
  migration is held again until the user OKs it.

### Lessons from US-2545
- When a page needs a viewer/dialog another page already has, import THAT one.
  A second copy means two focus traps and two sets of keyboard handling, and
  the one with fewer users is the one that rots. Assert the shared import in
  the guard so a later "quick local version" fails the build.
- Two buttons pointing at one place is usually a REDIRECT nobody re-read. Chase
  the target through the router before designing a second destination: here
  /dashboard/inventory/:id rewrites to the FlipDesk item page, and since
  US-2519 there is only one item editor for a link to reach.
- Assert the assumption the fix rests on, not just the fix. The guard checks
  that InventoryItemRedirect still collapses the two URLs, so if that stops
  being true the test says a second button is worth having again.
- A heading written as `What's next` in JSX is `What's next` in the file, not
  `&apos;`. Grep the source for the literal before writing the assertion.

### Lessons from US-2548
- A suppression context suppresses YOU too. The first cut put each host's own
  PageHeader inside its `PageHostContext.Provider`, and PageHeader returns null
  when embedded with no actions — so the fix rendered exactly the same broken
  screen as before. The guard now asserts the header appears BEFORE the provider
  in the file, which is the cheap textual proxy for "outside it".
- Half the fix was already built and had a different name. `useAccountHub` had
  done child-header suppression since US-1441; the four FlipDesk hosts had the
  OPPOSITE half of the same bug and nobody connected them because the mechanism
  was named after the one page that used it. Renaming it to PageHostContext cost
  three importers and turned five separate fixes into one.
- The guard found the seventh offender again. My hand grep listed six children
  with a hand-rolled h1 and missed `demand.tsx` entirely, because I built the
  list from the host files I had open rather than from what the hosts mount.
- Check whether a "child" is also a ROUTE before demoting its heading.
  `/autolister/queue` is its own URL reached from a batch, so demoting its h1 to
  an h2 (which is right for a hosted page) would have left a real page with no
  title at all. It got a PageHeader instead, and the guard splits HOSTED from
  STANDALONE so the next person does not have to rediscover the difference.
- The review's premise on the Analytics range was half wrong, and the true bug
  was worse. The value was ALREADY shared through `?preset=` (US-2234); what
  broke it was `navigate("/dashboard/flipdesk/analytics/returns")` dropping the
  whole query string on every tab click. Lifting the control was still right
  (three copies, three different aria-labels, two naming the wrong report), but
  it alone would not have fixed the carry-across the AC asked for.
- `tsc -b` is INCREMENTAL, and it passed twice on a file it had not rechecked.
  A `noUncheckedIndexedAccess` error in US-2547's `overview-range.ts` only
  surfaced during this story, after a stash/pop invalidated the build info.
  Fixed here. If a story ends with a green `tsc -b`, that is evidence about the
  files it touched, not a clean bill of health for the tree.
- The one red suite on main, `react-router-8-contract`, is a STALE LOCAL
  node_modules: package.json declares ^8.3.0, the installed copy is 7.18.2, and
  CI runs `npm ci`. Do not "fix" it in code — run `npm ci` if the local suite
  needs to be honest about it.

### Lessons from US-2547
- A "click X to filter" tile is worth checking in BOTH directions. Chasing the
  destination turned up a second, worse bug the review had missed: the item
  status `completed` mapped to the Sold tab, whose predicate is
  `status = 'sold'`, so the Completed tile counted rows NO tab could show. One
  string was doing two jobs — an item stage and a sale state — and the money
  card was the one that meant the other. Ask what a param MEANS at each end
  before trusting a mapping table.
- Write the narrowing into the filter the user can SEE. A hidden second
  predicate would have made the chip count and the rows disagree, which is how a
  list starts lying about what it contains. The seeded rule shows up in
  `?filter=`, and the server-side RPC already applies it.
- Moving a page off a full-table read strands whatever ELSE was reading it for
  free. NorthStarCard was "no extra fetch" only because Overview already held
  every item; it now takes pre-grouped weeks, and the lifetime total travels
  separately because the aggregate caps the buckets at two years.
- `npm run vault:lint` was already RED on main before this story started, from
  earlier commits in this loop (one error, three warnings). The lesson recorded
  three iterations ago said to run it after any commit touching a note's
  code_refs, and it still rotted. Run it EVERY iteration, not only when you
  think you touched one — reading a note's claim against the diff takes a
  minute, and all four here were cosmetic.
- Docker is down on this host, so `verify:db` cannot prove the SQL parses. For a
  held migration that is acceptable (the owner applies it by hand and sees any
  error immediately), but write the SQL defensively: bounds cross-joined in as
  columns rather than scalar subqueries repeated inside a dozen FILTER clauses,
  and `to_jsonb` over `row_to_json`.

### Lessons from US-2546
- A form that creates the parent row cannot upload children from it. Photos need
  an inventory_item_id that does not exist until save, so the shape is: stage in
  memory, upload immediately after the insert returns the id, and report a photo
  failure as "saved, but N photos didn't upload" - never as a failed save, or
  the seller catalogues the item twice.
- Before adding an upload path, EXTRACT the one that exists. photo-uploader.tsx
  held 160 lines of normalize/compress/store/thumbnail/insert; a second copy
  would have meant two EXIF-orientation stories, two thumbnail sizes and two
  storage path formats, with only one of them ever getting fixed.
- `lastIndexOf("    </div>
  );
}")` finds the LAST component in the file, which
  in a page with helper components at the bottom is not the page. Anchor the
  search to the start of the helpers: `lastIndexOf(TAIL, indexOf("
function Helper("))`.
- Keep an unsaved-work guard NARROW. Blocking when nothing is at stake trains
  people to click through the dialog, which is how a guard silently stops
  working. Compare against the INITIAL form state, not against emptiness.
