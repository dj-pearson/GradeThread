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
- [~] US-2503 (1800) iOS buyer tools unreachable — SLICE 1 `74a2be2a` + SLICE 2 `010d7463` (still OPEN). Slice 1: `GET /api/buyer/entitlements` serves the resolved payload so iOS gates from ONE source rather than a Swift copy of the matrix (AC3 was not satisfiable without it). Slice 2: every one of the 13 bundled capabilities is now classified `shipped | planned | desktop-only` inside the EXISTING `buyer-features.ts` registry, so a new buyer capability does not compile until someone decides — and a `shipped` claim must name a Swift file that EXISTS, which is AC5 read literally. Guard `src/test/buyer-ios-delivery.test.ts` (9 cases). AC2/AC4 and AC5's Swift screen still need macOS.
- [~] US-2504 (1802) Walk-around video grading web-only — SLICE 1 `994561a1` + SLICE 2 `aee1a0ba` (still OPEN). Slice 1 pinned the multipart field names, the exact opt-in string and the abstain response; **AC3 needs no iOS work** — the no-charge guarantee is the SERVER's. Slice 2 pins what the route will ACCEPT, which nothing had recorded: the caps that apply are the ROUTE's 60 MB / 45s, **not** the validation library's 100 MB / 60s, so a recorder built by reading the validator is rejected every time; photos and a clip are mutually exclusive (a 400, and the natural additive iOS flow breaks it); and 100% uploaded is not 100% done. AC4's WEB half was already correct (XHR, because fetch has no upload-progress event). Guard `src/test/video-grading-contract.test.ts` now 25 cases, 3 proven red on drift. AC2's recorder + AC4's iOS progress still need macOS.
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
- [x] US-2555 (2430) Nine multi-query admin pages render nothing on a failed read
      - b7b0a310 - all nine fixed and KNOWN_SILENT_READS DELETED, so the third
      assertion is absolute like the two above it. Shared
      `src/components/admin/section-read-error.tsx` after the third repetition.
- [x] US-2558 (2432) /admin/jobs read-only copies - a9d2c326 - both tabs removed and
      linked out (ops pages keep Run-now + replay, pinned by the guard). The
      verification the AC demanded CHANGED the fix: the endpoint returned four
      dead-letter families and the tab rendered two, so failed generation/publish
      batches were being fetched every 30s and shown NOWHERE. They are visible now,
      and the endpoint stopped fetching the two it no longer serves.
      Guard `src/test/admin-jobs-no-readonly-copies.test.ts` (7 cases, 4 red)
- [x] US-2513 (1912) Six ambiguous admin nav names — DONE 3cb82d1d. Finding HELD this
      time (read all six pages first): all distinct pages, badly-named. 3 pairs renamed
      in nav AND page heading; 3 were already resolved by US-2512/2505/2558. Guard now
      rejects a label that is a whole-word PREFIX of another — the shape this defect
      actually takes.
- [x] US-2559 (2434) Four admin clusters into tabbed hosts - `af5d1865` - 16 nav entries
      → 4 hosts via ONE shared `AdminTabHost`; all 16 pages still mounted as tabs;
      Economics is the rewards DEFAULT so the payout kill switch stays immediate; 15
      retired paths redirect with `?view=`. Guard `src/test/admin-host-consolidation.test.ts`.
      Adapted to the merged `PageHostContext` in `d997dc75`.
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
- [~] US-2528 (1942) Terms predate 4 products — STILL BLOCKED ON COUNSEL (its own AC5). FOLLOW-UP `2aade3a8`: drift guard `src/test/legal-extension-disclosure-parity.test.ts` (honest in both states; enforces four-fact parity the moment a section lands) + the AC4 date check. **Corrected a flag I raised myself**: the AUP's scraping clause is scoped to "the Service", NOT the marketplaces, so no carve-out is needed.
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
- [x] US-2531 (1948) Shopify web-only - CLOSED 2026-08-19. The 2026-08-14 slice narrowed it correctly and the remaining gap was one link: the screen said "connect it on the web" and gave no way to get there. MarketplacesView now renders a "Connect on the web" action on any `.api`-tier row, opening the FlipDesk marketplaces page in an in-app SafariView. Anchored on the TIER, not on the string "Shopify". Destination is the dashboard page and NOT a Shopify OAuth URL - the web app owns the redirect target, so a more direct link would strand the seller on a callback the app cannot receive. Guard `src/test/ios-marketplace-capability-parity.test.ts` swapped its absence block for four presence cases; 3 sabotages reddened. NOT COMPILED - iOS CI is the gate.
- [~] US-2532 (1950) Workspace 2FA policy web-only — SLICE SHIPPED `6b19b3ca` (still OPEN). **Found a real WEB bug**: the edge sends the blocked-member explanation and `edge-fetch.ts` threw it away for a hardcoded near-duplicate that had ALREADY drifted — making AC3 impossible. Fixed. iOS half verified PURELY UI. Guard `src/test/workspace-mfa-policy-parity.test.ts`. **US-2671 closed the follow-on 2026-08-19**: iOS now has TOTP enrollment (Settings > Two-factor authentication), and this notice opens it instead of sending a phone-only member to a browser.
- [x] US-2533 (1952) Return analytics web-only - CLOSED 2026-08-19. iOS Analytics gains a "Returns by grade" card driven by the SAME `flipdesk_return_reduction` RPC (SECURITY INVOKER, granted to `authenticated`, so no new endpoint), keyed on the existing range picker (AC3). The honesty rules are PORTED into `ReturnClaimRules` rather than re-decided: sample floor 10, no multiplier when graded is equal/worse/zero-divisor, low-n bands shown and marked rather than hidden. The guard swapped its absence block for eight cases that read the FLOOR out of the Swift and compare it to `MIN_RETURN_SAMPLE`, so the two numbers cannot drift. NOT COMPILED - iOS CI is the gate.
- [~] US-2534 (1954) iOS a11y labels missing — SLICE SHIPPED `d7b69221` (still OPEN). Premise VERIFIED (all 8 screens at zero) with a path CORRECTION: AIExtractView.swift is in `AIExtract/`, not `Analytics/`. Guard `src/test/ios-accessibility-ratchet.test.ts` makes the debt measurable and protects the 68 files that DO carry labels. Baseline 171 real call sites, not the 185 a bare grep reports. Verified to BITE. AC2 still needs Swift.
- [~] US-2535 (1956) Onboarding taxonomies diverge — **DECISION MADE** (owner,
      2026-08-14): option A, all three iOS answers map to `seller`, volume stays
      telemetry. SLICE SHIPPED `bab70b6a` (still OPEN): `src/lib/use-case-taxonomy.ts`
      pins the four canonical values (mirroring the 00022 CHECK), the mapping, and an
      `isWritableUseCase` guard. Verified iOS needs NO protocol work — web writes the
      column directly under RLS — and AC4 needs no dashboard change, though persisting
      still matters because `activation-checklist.tsx` branches on `seller` explicitly.
      Guard `src/test/use-case-taxonomy.test.ts` (11 cases) reads the Swift enum body so
      a 4th answer fails red. AC3's Swift write still needs macOS.
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
- [x] US-2547 (2410) Overview tiles promise a filter that isn't applied - 2ee30cc2 - stage
      tiles narrow via the VISIBLE filter, one server aggregate (migration 00594,
      HELD) replaces the whole-account loop, date range in ?range=, show-all on
      both list cards; guard `src/test/overview-stage-and-range.test.ts` (15 cases,
      12 red)
- [x] US-2548 (2412) Tabbed hosts show no name - 4aa89117 - five hosts (the four named
      plus the Account hub) render their own PageHeader; AccountHubContext
      generalised to PageHostContext; 7 children moved off a hand-rolled h1;
      shared HostViewSkeleton; Analytics range lifted AND the query string kept
      across tab clicks; guard `src/test/tab-host-headers.test.ts` (46 cases, 29 red)
- [x] US-2549 (2414) Embed widget missing noindex - a9b9a7e1 - the noindex was ALREADY
      there as an x-robots-tag header (finding corrected); added the stated decision,
      a shared safeEmbedCompany that strips bidi/invisibles and is compared body-for-body
      against the server widget, a skeleton and a retry; guard
      `src/test/embed-grade-indexing.test.ts` (12 cases, 10 red)
- [x] US-2550 (2416) Failed integrity check gives buyer nothing to do - 0386ef33 -
      anonymous buyer report into the EXISTING moderation queue (migration 00599
      adds the third content type, HELD), a Certificates tab with a reversible
      Withhold, repeat reports counted rather than overwritten; AC4 was already
      built by US-1912; guard `src/test/certificate-report.test.ts` (15 cases,
      12 red) + 5 edge unit tests + 4 tenant-isolation cases
- [x] US-2551 (2418) Anonymous tag claim - c20eefcd - the server DID accept it;
      /tag/:code/claim now 401s an anonymous caller (before the tag lookup, so it
      cannot probe codes), the page signs you in instead of posting, the transfer
      is confirmed, failures are told apart by status via a shared
      `src/lib/claim-failure.ts`, and /claim/:token stopped claiming on mount;
      guard `src/test/tag-claim-requires-account.test.ts` (13 cases, 9 red)
- [x] US-2552 (2420) Buyer onboarding taxonomy - 50f06260 - FOUR surfaces wrote the
      same criteria four ways (13 hardcoded / 19 hardcoded / two free-text); one
      shared CategoryPicker over one taxonomy, server drops and REPORTS what
      cannot match, sizes per group, and a want finally shows what it matched;
      guard `src/test/buyer-taxonomy.test.ts` (16 cases, 8 red). Filed US-2571
      for a live extractor bug found on the way.
- [x] US-2553 (2422) Buyer home never completes - 7080c831 - steps complete on real
      signals (extension bridge marker / saved_searches / closet_items) and
      self-hide; one step REPLACED because it could never complete; new
      BuyerActivity reads two feeds that already existed; extension link points
      at the Web Store; guard `src/test/buyer-home-activity.test.ts` (12 cases)
- [x] US-2554 (2424) Snap history + API keys placement - 3f4ec7ec - snaps kept in a
      DEVICE-local history (reasoned, stated on screen, photo never stored),
      /dashboard/developers is a real destination with a sidebar entry while
      /dashboard/api-keys stays for the Stripe return, plus the three P3s;
      guard `src/test/snap-history-and-developers.test.ts` (11 cases, 5 red)


### Follow-ups filed during the loop
- [~] US-2561 (unranked) iOS support tickets: attachments and close - SLICE SHIPPED
      `ec9d3a8d` (still OPEN). Every AC is Swift. All five premises VERIFIED against
      the running code; the endpoints all exist and none needed adding. New
      `src/lib/support-attachment-contract.ts` pins the protocol, and the guard reads
      every value back out of the code that serves it. Catches the three things a
      second client gets wrong: the limit already lives in TWO constants (a Swift one
      is the third), the key is `data_url` not `dataUrl` (camelCase decodes to null
      and blames the bytes), and a signed url dies TWO ways - null, and a perfectly
      good string that expires after 600s. Guard `src/test/support-attachment-contract.test.ts`
      (19 cases), verified to bite on 4 simultaneous drifts. Swift half needs macOS.
- [~] US-2557 (1953) iOS shows no unread notification count - SLICE SHIPPED `1b3587d2`
      (still OPEN). AC1/AC2 premises VERIFIED as filed. But TWO things the Swift half
      reads from were wrong: **no push has ever carried a badge** (apns.ts has supported
      `badge` since pushes shipped and no caller ever set it, so the icon number could
      not appear whatever the app did), and **the web bell counted a .limit(20) page**,
      so it stopped at 20 and its own "99+" branch was dead - matching it, as AC3 asks,
      would have shipped the cap to the phone. Fixing the count exposed a THIRD bug:
      "Mark all read" marked only the ids on that page. Guards:
      `notification-badge_test.ts` (8) + `src/test/notification-unread-count.test.ts`
      (7), both verified to bite. AC3/AC4's Swift halves still need macOS.
- [x] US-2560 (unranked) A buyer cancellation reaches no notification channel -
      `49350ff7` - searchCancellations() existed since the Post-sale page shipped and
      NO poll source read it, so three of the four eBay post-order cases notified and
      this one did not. New poll source with the same claim-before-deliver contract.
      The state filter is a DENYLIST (not the allowlist the dispute source uses) so it
      AGREES with what the page calls open; a seller-initiated cancellation is skipped
      or every Approve would mail the seller about their own click. **The AC's pref
      premise was FALSE**: the `returns` copy did not cover cancellations, so the copy
      was widened in the same commit. Guards: 7 new poll cases +
      `src/test/post-sale-state-parity.test.ts` (7 cases, verified to bite).
      ⚠ MIGRATION 00601 IS HELD.
- [x] US-2571 (1850) AI extractor cannot emit neckwear or gloves - `d891f36a` -
      the stale list was SIX files, not one: ai-extract.ts, routes/grade.ts,
      routes/api-v1.ts, lib/openapi-spec.ts, the WEB submission form, and the deno
      guard's own mirror. ai-extract is the prompt AND the schema enum AND the
      return allowlist, so the model was FORBIDDEN from answering neckwear. AC5 also
      found GARMENT_CATEGORY_CRITERIA_V2 had no entry for either value (added, inside
      the existing env gate so OFF stays byte-identical) and that GARMENT_TYPES was in
      sync by luck, not by check. Guard `src/test/garment-taxonomy-copies.test.ts`
      (13 cases), verified to bite. Also fixed 2 edge tests red on main.
## LOOP STOPPED 2026-08-14 — owner's call, nothing left in scope

The 5-minute fix loop was cancelled at the owner's direction after it ran out of
work it could do. **This is not an abandonment; it is the end state.**

**Delivered.** All 52 review stories plus the follow-ups US-2555..2561, US-2571
are closed, except the ten below. Every one of those ten has had its non-Swift
half shipped as a slice with a contract module and a proven-red guard, so the
Swift lands against a spec instead of a reverse-engineered guess. The review's own
last unfinished item (gap 6) was checked and withdrawn. 17 commits, every gate
green (table above).

**Why it stopped.** Ten stories remain: nine need a macOS toolchain to write and
compile Swift, and US-2528 needs counsel to sign the Terms copy. Neither is
reachable from this Windows checkout, and neither becomes reachable by pushing —
pushing runs the iOS CI lane, which VERIFIES Swift, but somebody still has to
WRITE it on a Mac.

### To pick this up again
1. Apply `00601` (one `ALTER TYPE ... ADD VALUE`; see PENDING_MIGRATIONS.md).
2. Push the 17 commits.
3. On a macOS session, work the ten from this tracker. Each story's prd note names
   exactly what is left, and the guard file to extend — not to delete.

### Do not re-derive these
Five story premises turned out **false or narrower than filed** and cost an
iteration each to discover (US-2510, US-2523, US-2531, US-2556, and the review's
own gap 6). Three of the five were the same mistake: **searching for a NAME rather
than for the CAPABILITY.** The lessons section below is the accumulated record;
read it before opening any of the ten.

## Pre-push verification, 2026-08-14 — every gate green

Run as a SET over the 16 unpushed commits, reading real exit codes rather than a
marker after a pipe (see the lesson below about `| tail && echo OK`):

| Gate | Result |
|---|---|
| `npx tsc -b` | exit 0 |
| `npm run lint` | exit 0 (16 warnings, 0 errors — the baseline) |
| `npm run ui:check` | exit 0 |
| `npx vitest run` (whole suite) | **4714 passed**, 73 skipped, 0 failed |
| `npm run build` | exit 0, 217 static pages prerendered |
| `deno lint` / `deno check` | exit 0 / exit 0 |
| `deno test` (edge) | **6727 passed**, 0 failed, 193 ignored |
| `vault:lint --strict` | exit 0 |
| `runbook-sync` | exit 0 |
| `prd:lint` | exit 0 |
| `check-tracked-ignored` | exit 0 |

**One caveat, stated rather than glossed.** The working tree also holds the
concurrent agent's UNCOMMITTED US-2593 work (`vite.config.ts` modified,
`src/lib/pwa/` and `src/test/pwa-navigate-fallback.test.ts` untracked), so those
runs included it. That does not compromise the result for a push: `git diff
--name-only origin/main..HEAD` shows **zero overlap** between the 44 files these
16 commits touch and the files that agent is editing, and a push carries only
committed work. Their changes stay local either way.

**The push is blocked on one thing only: migration 00601.** It is one
`ALTER TYPE ... ADD VALUE`, packaged in PENDING_MIGRATIONS.md with the apply
order. Applying it and pushing also makes the macOS `iOS CI` lane available,
which is what unblocks the ten remaining stories.

## The review itself is now complete, 2026-08-14

`9a57fefc` closed the last open question IN THE REVIEW, as opposed to in its
fixes. The cross-platform gap table carried one item — gap 6, "My stores" (Radar
store linking), P3 — annotated *"needs a final targeted check"*, and no story was
ever filed against it because the check was never made.

Made now: **it is not a gap.** iOS calls the same
`/api/flipdesk/radar/my-stores` endpoint and renders it (per-venue summary row,
loading and error states); Android has a `MyStoresService`. What iOS lacks is a
tab *called* "My stores" — it folds the numbers into the Radar Nearby list beside
each venue, which is the better shape for a screen used while standing in a shop.
One asymmetry survives and is deliberately not filed: eight sorts on web, `roi`
only on iOS. Lesser surface, identical data. Guard
`src/test/radar-my-stores-parity.test.ts` (6 cases, both halves proven red).

⚠ **Scope note.** `prd.json` now also holds US-2572..US-2592, a HELP CENTER epic
planned by the concurrent agent on 2026-08-14 at priority 62-82 — so those sort
ABOVE every review story. They are **not** this review's work and this loop does
not take them; doing so would collide with the agent that planned them and is
editing the tree live.

## Where this loop stands, 2026-08-14

**Every remaining review story is blocked on something this checkout cannot do.**
Verified by reading each story's own STILL-OPEN marker, not assumed:

| Story | What is left | Blocked on |
|---|---|---|
| US-2503 | four buyer screens, the entitlement test, the plan screen | macOS |
| US-2504 | the AVCapture recorder, the iOS progress UI | macOS |
| US-2528 | the Terms copy itself | counsel sign-off |
| ~~US-2531~~ | ~~one link on the Marketplaces screen~~ | DONE 2026-08-19 (written here, compiled on iOS CI) |
| US-2532 | the 2FA control | macOS - and US-2671 shipped the ENROLLMENT screen 2026-08-19 |
| ~~US-2533~~ | ~~the analytics section + range wiring~~ | DONE 2026-08-19 (written here, compiled on iOS CI) |
| US-2534 | labels + move actions on eight screens | macOS |
| US-2535 | the `users.use_case` write, telemetry retention | macOS |
| US-2557 | the TabView badge, `setBadgeCount` | macOS |
| US-2561 | picker, attachment rendering, Close button, downscale | macOS |

Every one has had its non-Swift half shipped as a slice, with a contract module
and a guard, so the Swift lands against a spec rather than a reverse-engineered
guess. **The macOS lane only runs on a PUSH**, and the branch has been unpushable
because it carries a held migration — so the fastest way to unblock ten stories
is to apply `00601` and push.

### The one thing that was NOT blocked, and it mattered
`389fbfae` — CLAUDE.md said "Only `python3 ios/Scripts/no-ungated-print.py` runs
locally". **There is no python3 on this box**, so the single iOS check documented
as locally available was not available at all, and the real local iOS safety net
was zero — while ten stories sat deferred on the reasoning that Swift written
here would be unverified. Ported to `src/test/ios-ungated-print.test.ts` (11
cases) so `npm run verify` covers it with no Python. The Python stays for iOS CI
and a parity case fails if the two ever scan different trees.

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

### Lessons from US-2555
- READ prd.json for the queue, not the tracker's checkboxes. US-2555 is
  priority 2430 and should have come before US-2558 and US-2559, but it had no
  checkbox line — it lives inside the US-2507 entry as "re-scoped to US-2555".
  Two stories were done out of order before the gap showed up. The tracker is a
  narrative; prd.json is the queue.
- A ratchet that fails in BOTH directions is why this finished. Every page I
  fixed made the suite fail with "these were fixed — delete them from the list",
  so the list could not quietly rot into a permanent suppression. That property
  is the whole reason a nine-item allowlist reached zero.
- "Handles errors" is not the same as "reports them usefully". Three of the nine
  DID have an error branch: analytics printed the raw Error.message in red,
  reward-north-star had a muted paragraph, and both offered no retry — so the
  only recovery was a reload, which on reward-north-star also discards the
  window the operator picked. An internal exception string is not guidance.
- The worst wrong answer is the confident one. user-detail fell through to
  "User not found" on a failed read, which an operator reads as "this account
  was deleted"; jobs.tsx said "No jobs match this view", reporting an outage as
  a healthy queue on the page you open to check the queue. Both are worse than
  a blank space, and both came from the same `data === undefined` on error.
- Match the fix to the page, not to a template. Six independent queries need six
  branches; one query behind five sections needs ONE, because five identical
  error cards are five copies of a single fact.

### Lessons from US-2559
- Group by the JOB a page does, not by the word in its label. "Assistant
  monitoring" sat in the AI cluster because it starts with AI; it is the abuse
  console for the support bot. Reading its PageHeader subtitle took ten seconds
  and removed a page from the merge. Third time this loop that a consolidation
  shrank on contact with the code (US-2510, US-2512, now this).
- A merge is the cheapest time to find an unreachable page. safety-signals was
  ROUTED with no sidebar entry anywhere - reachable only by typing the URL -
  and that only surfaced because the cluster had to be enumerated. Worth asking
  of any nav change: which routes have no entry pointing at them?
- When a story says a control must stay immediate, "default tab" is a real
  answer. The payout kill switch had to survive the merge un-buried; making
  Economics the default view means /admin/rewards opens on it, which is one
  click closer than the old sidebar entry rather than one further away.
- The guard from a previous story caught this one before the tests did.
  US-2513's prefix rule rejected the label "AI" because it is a whole-word
  prefix of "AI Escalations" - the general-case-vs-specific ambiguity it was
  written for. Renamed to "AI Platform". Guards from earlier stories are the
  cheapest review available; run the admin ones after any nav edit.
- Assert the ANTI-goal, not just the goal. The merge's real risk is a page
  quietly dropped instead of moved, so the guard names all sixteen and fails if
  any host stops mounting one. "Nothing was deleted" is only a promise until
  something checks it.

### Lessons from US-2558
- "Verify nothing depends on it before deleting" found something nobody was
  looking for. The read-only tab was a duplicate, yes — but its ENDPOINT also
  returned two families the tab never rendered and no other page showed. The
  duplicate and the blind spot were in the same file, and only reading the
  handler next to the JSX surfaced the second one.
- Compare data SOURCES, not page titles, when judging whether two surfaces
  duplicate each other. Both cron views map the same CRON_REGISTRY, which is
  what made one a strict subset; the dead-letter views differed by two tables,
  which is what stopped this being a clean delete.
- Removing a UI is not the same as removing its endpoint. /api/admin/jobs/crons
  now has no client, and it is left in place on purpose: it works, it is tested,
  and deleting it would take a tested lib with it. Recorded in the story note so
  the next person finds a decision rather than an oversight.
- The comment-stripping guard from US-2553 was needed again ONE story later,
  for the same reason: an assertion that an endpoint is gone matches the comment
  saying it is gone. Any guard asserting the ABSENCE of a string in source needs
  to read code, not prose.

### Lessons from US-2554
- "Persist it" has more than one right answer, and the cheapest correct one is
  worth arguing for out loud. A server table for snap history would have added
  a row per free snap for every visitor, and the endpoint deliberately stores
  NOTHING today. Device-local gives the seller the list they actually wanted
  (on the phone they snapped with), keeps the privacy stance intact, and the
  screen says where it lives so nobody mistakes it for an account record.
  Recorded in the story note WITH what a server version would need, so the
  decision can be revisited rather than rediscovered.
- Do not redirect a URL Stripe returns to. /dashboard/api-keys carries the
  API-overage checkout success_url, so the new Developers destination is an
  ADDITION and the old path still renders. Same lesson as US-2511, now with a
  second instance — grep services/edge-functions for any path before moving it.
- A non-interactive div styled exactly like the link beside it is a bug with
  two possible fixes, and "make it look dead" is the worse one. Both tiles had
  a real destination all along (/developers documents the SDK and the sandbox),
  so they became links: they now behave the way they always looked.
- A missing `overflow-x-auto` on a wide table is not cosmetic when the last
  column is destructive. Seven columns on a phone clipped the REVOKE button off
  the right edge, so the recovery action for a leaked API key was unreachable
  exactly where someone would reach for it.
- localStorage is user-writable, so anything read back from it needs the same
  suspicion as a request body. The history reader drops entries missing the
  fields the list renders, because the alternative is a row of blanks or a
  crash on a value someone pasted into devtools.

### Lessons from US-2553
- A checklist step with no observable signal is worse than no step. "Verify a
  certificate" pointed at a public marketing page that records nothing against
  an account, so that card could never have gone out — it WAS the bug the story
  describes, not a victim of it. When a step cannot complete, either give it a
  record or replace it with the nearest action that has one; do not fake it with
  a localStorage "clicked" flag.
- The data for "show the user their own activity" was already there, twice. The
  alert-match feed has existed since US-1809 and the closet since US-1825; the
  home page simply never read either. Before building a feed, grep for the hook
  — this is the fifth story in this loop where the back end was already done.
- A content script lands AFTER first paint, so an install check must be state,
  not a render-time call. Reading the DOM marker during render reports "not
  installed" on every fresh load, which would have made the extension step
  permanently incomplete — the same failure in a new place.
- A guard that reads a FILE reads its comments too. Two assertions failed on the
  comment explaining the fix, not on the code. Strip comments before asserting,
  or the guard quietly punishes anyone who writes an explanation.
- `node -e` ate the backslashes out of a regex AGAIN, exactly as the note three
  lessons up says it does, and produced a test file that would not parse. The
  rule is not "be careful" — it is: any edit containing a regex or a template
  literal goes in a .mjs file or through the Edit tool.

### Lessons from US-2552
- The finding was wrong about WHICH values were broken and right that something
  was. All 13 onboarding chips were real taxonomy values, so nobody was ever
  matching nothing there — but settings had a DIFFERENT hardcoded 19, and two
  other surfaces took free text into a field matched by exact equality. Reading
  the matcher first (fifteen minutes) turned a guess about one page into the
  actual defect across four.
- When a story says "verify X before changing anything", that instruction is
  the story. Twice now (this and US-2551) the AC that said "verify first" was
  the one that decided what the fix should be.
- The correct shape was already in the codebase, one file away. watchlist.ts has
  iterated `prefs.sizes` as GROUPS since US-1798 and its own test uses
  `{ tops: [...] }`; the `{ all: [...] }` bucket the two buyer pages wrote was
  the outlier, and watchlist was copying it into saved searches. Grep for who
  READS a field before designing its shape.
- Migrating a stored answer has three options and two are wrong. Spreading the
  old single-bucket sizes into every group invents a claim the buyer never made
  (that their shoe size is their jeans size); deleting it throws away something
  they told us. Keeping it, showing it, and asking them to place it is the only
  honest one.
- Extracting the shared component AFTER the third copy is too late by one. I
  pasted the same 25-line chip block into onboarding, settings and demand before
  pulling it into CategoryPicker — and then found alerts needed it too. The
  moment a block appears twice, it is going to appear four times.
- Not every input can be autocompleted, and saying so is better than faking it.
  Keywords are matched as a SUBSTRING of title and brand, so any string can
  legitimately match and there is no set of known values; the useful fix was to
  tell the buyer what the field searches. Brands and categories are exact-match,
  which is what makes a typo there fatal and worth constraining.
- The full edge suite is the only thing that catches a route-surface guard.
  `buyer-plan-gates_test.ts` enumerates every buyer route and fails on any new
  one until its author says whether it is gated. My matches endpoint tripped it,
  which is the guard working — but only a full `deno test` run finds it, so a
  new buyer route means running that lane, not just the file you touched.

### Lessons from US-2551
- "Verify the server first" was the whole story. The finding offered two
  possibilities — the server accepts an anonymous ownership claim, or it
  rejects it and the buyer gets a generic error — and they need opposite fixes.
  It accepted. Reading the handler took two minutes and decided everything;
  guessing would have shipped better error copy on a live takeover hole.
- Put the auth check BEFORE the resource lookup. Checking the tag first and
  the identity second turns the 404-vs-401 difference into an oracle for which
  short codes exist, and these codes are ten characters.
- Two paths that look alike can deserve opposite answers. The tag claim and
  the token claim are both "claim this garment", but a token is single-use,
  expiring, privately delivered and replay-detected, while a tag code is
  printed where anyone can read it. Gating both would have made a legitimate
  buyer create an account to redeem a link; gating neither is the bug. The
  guard pins the REASON for the difference, or the next person will "fix" the
  inconsistency.
- An auto-action on mount spends a single-use credential on a page view.
  /claim/:token claimed in a useEffect, so opening the link to look at it — or
  a seller forwarding it to check — burned the token, and the actual buyer met
  "invalid, expired, or already used". A click costs a second.
- A shared retry button must know WHAT failed. Mine called claim() regardless,
  so a dropped connection while merely READING a tag would have fired an
  irreversible ownership transfer. The error state names the request to retry.
  Found by writing the guard, not by reading the code back.

### Lessons from US-2550
- `in` is not an ownership test. The report-reason validator used
  `v in REASONS`, which walks the prototype chain, so "toString" and
  "constructor" were valid reasons and the route then stringified a FUNCTION
  into an operator queue. `Object.hasOwn` is the check. My own test case
  caught it, written on a hunch rather than from the code.
- A queue that dedupes by design will silently swallow a signal. The moderation
  queue keeps ONE open flag per content item, which is right for operators and
  wrong for buyer reports: the fifth reporter overwrote the first, so five
  independent complaints read as one — and "five people reported this" is the
  strongest fact in the whole record. The count now rides in the reason text,
  parsed back out and incremented, in a pure function with its own tests.
- Look for the operator surface BEFORE building one. The queue, its RLS, its
  admin page and the string 'user_report' as an expected producer all shipped
  in US-889. The only thing missing was one enum value. Same check that caught
  US-2523 and US-2556 being already built.
- A link needs a route. The first draft of the admin tab offered "Open the
  submission" pointing at /admin/submissions/:id, which does not exist — the
  admin submissions page has no detail route and its search does not match ids.
  Replaced with the real action (Withhold / Restore), which is better anyway:
  it writes the same flagged state US-484 already uses to hide a certificate,
  so the product keeps ONE answer to "is this cert public".
- A source-shape guard that matches a literal `\n` is red on Windows forever.
  shopify-fulfillment_test.ts looked for `.from("sales")\n    .update(` against
  a CRLF working copy, so it failed locally and passed in CI, which is the
  worst possible split. Fixed to `\r?\n`. Any guard that reads SOURCE has this
  hazard — the repo checks out CRLF here and LF in CI.
- Concurrent sessions and a generated manifest do not mix. Another agent had
  four uncommitted migrations on disk, so `gen-migration-manifest.mjs` (which
  reads the DIRECTORY) put their versions into the manifest I was about to
  commit — and a manifest naming a migration a clean checkout lacks fails its
  own guard. I committed the manifest trimmed to my entry and left the full
  regeneration in the working tree, so their checkout stays consistent too.

### Lessons from US-2549
- Indexing is decided by the SERVING PATH, not by the page file. The finding said
  "no SEO component, therefore crawlable" — but `/embed/*` goes through Pages
  Functions, which delegate to `serveSpaShell`, which has sent
  `x-robots-tag: noindex, nofollow` since US-2045. Before filing an indexing bug,
  check `public/_routes.json` and the function that owns the path; a header beats
  every meta tag and is invisible from `src/`.
- Two copies of a rule need a test that COMPARES them, not one that restates the
  rule. The first version of the parity check asserted the literal regex strings,
  which makes the test a third copy: it passes while both files drift together
  away from what it meant. Extracting both function bodies and asserting equality
  is shorter and actually enforces the property.
- Order of operations in a sanitiser is the whole result, and both orders are
  wrong in different ways. A newline is a C0 CONTROL character, so stripping
  controls first deleted the only thing separating two words. Several invisibles
  (the BOM among them) are `\s` to JavaScript, so collapsing whitespace first
  turned them into spaces. The working order is: strip non-space invisibles,
  collapse whitespace, strip what controls remain, collapse again. Both halves
  were found by test cases, not by reading.
- A ratchet from an earlier story will catch the NEXT story. US-2548's PageHeader
  conversion pushed autolister-queue.tsx one line over the shrink-only ceiling
  US-2520 set. Fixed by tightening the block, never by raising the number. Run the
  ratchet suites after any edit to a file one of them names.

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

## ⚠ Concurrent-agent collision, 2026-08-14

A second agent worked this same review in parallel and PUSHED. It landed
US-2542, US-2544..US-2556 and US-2558 — the same stories this session had also
implemented locally — plus new stories US-2562..US-2570.

Resolution: **their published history won for every overlapping story.** 18 of
the 34 local commits were duplicate implementations and were dropped; the 8
unique ones (US-2503, US-2504, US-2528, US-2531, US-2532, US-2533, US-2534,
US-2559) were replayed on top. The dropped work is preserved on the local
branch `claude-local-backup-2026-08-14` if anything needs recovering.

The decisive factor was MIGRATION NUMBERS: both sides had written a `00594` and
a `00595`, different files each. Numbers on published history cannot be
renumbered, so the local pair had to go. Their 00594–00599 are the ones held in
`PENDING_MIGRATIONS.md`.

One code adaptation was needed: the local US-2559 host carried its own
`TabHostContext` from a parallel take on US-2548, while the published branch had
generalised the same idea as `PageHostContext` and wired `page-header.tsx` to
it. Two contexts would have meant a hosted page suppressing its title for one
host and not the other, so the local one was dropped.

### Lessons
- **Check `git log origin/main..HEAD` and `HEAD..origin/main` before starting a
  story, not after 34 commits.** A concurrent agent on the same tree is a known
  hazard here and the cost of noticing late is an entire duplicate branch.
- **Duplicate migration numbers decide the merge for you.** Published numbers
  cannot move, so whichever side is unpushed loses its migration and everything
  built on it. That alone is a reason to push early or to claim numbers late.
- Back the branch up BEFORE `git reset --hard`. `claude-local-backup-2026-08-14`
  cost one command and made an irreversible-looking step reversible.
- During a cherry-pick, `--ours` is HEAD and `--theirs` is the commit being
  picked. Getting that backwards silently discards the wrong side of a JSON
  file; the archives were merged by comparing id sets instead of trusting either.

### Lessons from US-2535 slice
- **A decision buried in a prd note is not a decision requested.** These three
  options and my recommendation sat unanswered for several iterations while I
  re-read them each time and moved on. Putting the question directly to the
  owner unblocked it in one exchange. Ask, don't file.
- My drift check was VACUOUS on first write. It filtered the Swift enum cases
  down to the ones already known to the map before comparing — so a NEW iOS
  answer, the exact thing it existed to catch, was filtered out and the test
  stayed green. Found only by adding a fourth case and watching nothing happen.
  **Break the thing the guard is for, every time, not just something nearby.**
- Anything named `useX` trips `react-hooks/rules-of-hooks` the moment it is
  called in a loop. `useCaseFromIosAnswer` was a pure function and still failed
  lint from the test that iterated the three answers. Renamed to
  `iosAnswerToUseCase`, with the reason in the doc comment so it stays renamed.
- Check whether the gap is protocol or UI before scoping it. Web writes
  `users.use_case` straight through supabase-js under RLS, so the iOS half is a
  single write — not an endpoint, not a contract.

- **A guard that MIRRORS the thing it guards is checking itself.**
  `category-criteria_test.ts` hand-copied GARMENT_CATEGORIES with a comment
  promising "the first test below fails if the two ever diverge in count". It
  could not: it WAS the other side of the comparison, so it measured a 20-value
  list against a 20-entry map for two releases while the real taxonomy held 22.
  Two more literal counts in the same file were the other places US-2224 should
  have failed. The edge cannot IMPORT the frontend module - it can READ the file,
  and parsing the literal is the whole difference between a copy and a reference.

- **Strip comments before matching strings out of a source literal.** The first
  version of that parser picked up `neckwear` and `tie` out of the US-2224 comment
  explaining why the value is NOT called tie, invented a category named `tie`, and
  the coverage assertion then demanded rubric text for it. Found in seconds because
  the guard was derived; a pinned count would have hidden it.

- **A stale enum copy is not one bug repeated, it is several different bugs.** Rank
  the copies before fixing them. A VALIDATOR that is missing a value 400s a caller.
  A PROMPT that is missing one forbids the model from ever saying it, which looks
  like a model that cannot classify ties. A PUBLISHED CONTRACT that is missing one
  ships a broken enum to every integrator. A FORM that is missing one takes the
  option away from the human. Same diff, four different reports.

- **Derive the count, never pin it.** `assertEquals(NEW.length, 11)` is the line
  that should have gone red on US-2224 and instead had to be edited by whoever
  broke it. `GARMENT_CATEGORIES.length - PRE_EXISTING.length - 1` says the same
  thing and cannot be satisfied by editing the guard.

- **Run the FULL edge suite, not the file you touched.** Two failures were sitting
  on main: my own `GET /api/buyer/entitlements` (US-2503) undeclared in the
  buyer-plan-gates GATES table, and `prompt-suffix-order_test.ts` anchored on the
  Anthropic SDK calling convention that US-2568 deliberately removed. Neither was
  from this story and both had to be fixed here, because a red suite is not a
  baseline you can read your own result against.

- **Two copies of a decision rule must AGREE, and that is a different requirement
  from either being right.** The poll decides whether to notify; the page decides
  whether the row shows as open. Each rule is defensible alone, but if they
  disagree the seller follows a notification to a page that shows them nothing,
  which reads as a broken notification and teaches them to ignore the next one.
  The edge cannot import the SPA module, so the fix is a second copy plus a
  source-comparing guard - the same shape as the taxonomy guard in US-2571, and
  the second time this loop that "the edge can't import it" turned out to mean
  "so compare them in a test", not "so let them drift".

- **A default that reuses an existing preference category must pass the COPY
  test, not the taxonomy test.** US-2560's AC said to map the new type to the
  `returns` gate "whose copy already covers post-order cases". It did not - it
  named returns, return status changes and disputes. Routing the type there
  unchanged delivers a message the sentence never promised AND silently takes
  the new thing away from anyone who had turned that toggle off. Either widen the
  sentence in the same commit or give the type its own category. This repo has
  precedent both ways (`reward_nudge` and `integrity_tier_change` got their own).

- **Verify a failure-mode claim before writing it into PENDING_MIGRATIONS.md.** I
  wrote that a failed notification releases its claim so the next poll retries.
  It does not: `deliver()` wraps the in-app write in its own try/catch and logs
  WITHOUT rethrowing, so the failure never reaches the poll's per-event catch and
  the claim stands forever. The correction mattered - it turns "apply the SQL
  first" from a formality into the thing preventing silent permanent loss. A
  migration doc's whole job is to be right about what breaks.

- **A test that asserts an EXTERNAL API's vocabulary is asserting a guess.** I
  wrote `CANCEL_COMPLETE` into a parity test as a terminal state; it went red,
  because the marker list holds COMPLETED and that does not match COMPLETE. The
  tempting fix - shorten the marker - widens the terminal set on a guess, and
  something like COMPLETE_REFUND_PENDING would then be read as finished and
  hidden. Assert only the states this repo actually records, and write down the
  near-miss so the next person does not "fix" it.

- **An IMPORT is not a USE, and a guard that greps for a name cannot tell them
  apart.** `expect(src).toContain("withUnreadBadge")` stayed green after I deleted
  the actual call, because the `import` line still carried the word. Assert the
  call site with its arguments. Found only by breaking the thing on purpose -
  which also failed the first time, because the break script's replace silently
  no-op'd on a CRLF file with an LF search string. **Two ways to fake a passing
  bite-check, in one attempt.** Always confirm the break APPLIED (throw if the
  replace returns the input unchanged) before believing a red or a green.

- **A source-scanning guard must strip comments, and this is now the THIRD time.**
  US-2571's taxonomy parser read `"tie"` out of a comment; US-2557's scan for
  `.limit(` matched the sentence in its own module doc explaining the bug it
  replaced. The file that documents a defect best is the file most likely to
  contain the forbidden string. Make `code(path)` that strips comments the
  DEFAULT helper in any test that reads source, not something remembered.

- **"Matching the web behaviour" is only safe once you have read the web
  behaviour.** AC3 said the iOS badge should match the web notification centre.
  The web centre computed its badge by filtering a 20-row page, so obeying that
  AC literally would have shipped a silent cap to a second platform - and the
  server-side count in the same story would then have disagreed with it, with
  neither number obviously the wrong one. When an AC says "match X", read X
  first; a parity requirement inherits X's bugs.

- **Fixing a derived number exposes what was hiding behind it.** The 20-row badge
  concealed that "Mark all read" also only marked those 20 rows: the badge read
  20, you clicked, it read 0, and the older unread rows stayed unread forever.
  Neither symptom was visible while both halves shared the same wrong source.
  After correcting a count, re-read every action that CHANGES it.

- **Never write a regex that matches a regex.** The data-URL parity check started
  as a pattern matching the edge's pattern literal and failed on its own
  escaping. When that breaks you cannot tell a real drift from a backslash you
  miscounted, which is the opposite of what a guard is for. Slice the literal out
  as TEXT and compare it to `pattern.source`.

- **A signed URL is dead in two ways and a null-check only catches one.** The
  obvious case is `url: null` from a signing failure. The one that actually
  reaches users is a perfectly good STRING that expired: the response was valid
  when it arrived and rots in place, so nothing about the value says it is dead.
  Any short-TTL URL handed to a client needs the FETCH TIME travelling with it,
  and a margin, so a link dying mid-request is treated as already gone. This
  applies to every `createSignedUrl` surface in the repo, not just support.

- **An "N clients must agree" fact is worth writing down BEFORE the second client
  exists.** Support's attachment limit already lived in two constants that agree
  only because nobody has changed one. Filing that as a contract while the Swift
  half is still blocked is the cheapest this fix will ever be - after the third
  copy exists, the same work is a three-way reconciliation with a shipped app in
  it. Third time this loop that the answer to "the edge can't import it" was a
  contract module plus a source-reading guard (US-2571 taxonomy, US-2560
  post-sale state, now this).

- **When an AC says "match X", read X first.** AC5 said downscale on device "as
  the web picker does". Only reading the picker gives you the numbers that
  actually ship (compressImage, maxWidth 2400, quality 0.85) - and had the web
  NOT been compressing, the honest answer would have been to say so rather than
  implement a parity requirement against a bug. Same lesson as US-2557's AC3,
  twice in two iterations.

- **A THRESHOLD IS NOT A PROPERTY.** The US-2503 guard's check against "no bullet
  advertises a screen that does not exist" was a count: at most two capabilities
  may claim shipped. Flipping an entry from `planned` to `shipped` kept the
  count under the limit, so the guard stayed GREEN on the exact defect it was
  written for. Fixed by making the claim name a Swift FILE and asserting the file
  exists. When a guard's subject is "X must really exist", assert the existence,
  never a number that correlates with it.

- **Break the guard in the direction of the DEFECT, not just in some direction.**
  My bite-check broke two things at once and one of them went red, which read as
  "the guard works". It did not — the reddened case was the unrelated one. Check
  WHICH assertion failed, not just that the run was red. Same class as the
  vacuous-test lesson but sneakier, because the evidence looks right.

- **A fourth vacuous assertion, caught before shipping this time:**
  `["ios/GradeThread"].flatMap(() => [])` compared to `[]` is always true. They
  keep appearing when a test needs a placeholder while the real check is being
  worked out, and they survive because a passing test is not re-read. If an
  assertion cannot fail, delete it rather than leaving it as scaffolding.

- **Extend the registry that exists before writing a parallel one.**
  `buyer-features.ts` already keyed every buyer capability by `BuyerGateFlags`
  with a `live` flag. Adding iOS delivery there rather than in a new module got
  the exhaustiveness for free — `Record<keyof BuyerGateFlags, …>` means a new
  capability does not compile until it is classified. A parallel registry would
  have needed its own guard to stay in step, which is the drift this loop has now
  fixed four times.

- **`cmd | tail && echo OK` REPORTS THE EXIT STATUS OF `tail`.** I had been
  verifying with `npx tsc -b 2>&1 | tail -5 && echo TSC-OK` all loop, which
  prints the success marker unconditionally — and this iteration it printed
  TSC-OK directly underneath a real TS2532. Earlier runs happened to be clean
  (no error text above the marker) but the check was never sound. Run the command
  bare and read `$?`, or put the marker inside the command that can fail.

- **When a spec has two plausible sources, the one a stranger reads first is the
  wrong one.** The video caps live in `lib/video-validation.ts` as defaults
  (100 MB / 60s) and in `routes/grade.ts` as the values actually passed
  (60 MB / 45s). A validation library is exactly where someone looks to learn
  what an upload may be, so the looser number is the discoverable one and the
  binding number is hidden in a call site. Pin the binding one AND assert the
  gap, so the trap itself is guarded rather than just the value.

- **Ask what the natural shape of the OTHER client's flow is.** Photos and a clip
  are mutually exclusive on the server, which reads as an odd restriction until
  you notice the iOS flow is additive by nature: stage photos, then also record.
  Sending both feels like sending more evidence. Rules that are obvious in the
  client you built are the ones a second client breaks first — write those down
  in preference to the ones that are merely important.

- **Check whether the "missing" half is missing.** US-2504 AC4 asks for upload
  progress; the web already had it, done properly, with the AC's own 60 MB
  reasoning in the comment. Half an hour of reading turned "build progress
  reporting" into "record the one non-obvious thing about it" (100% uploaded is
  not 100% done). Fifth stale-or-narrower premise this loop.

- **A documented mitigation that cannot run is worse than an admitted gap.**
  Ten stories were deferred on "Swift written here would be unverified until
  CI", and the contributor docs answered that with a command requiring an
  interpreter this machine does not have. Nobody noticed because the line reads
  as reassurance and nobody runs a check they have been told is the only one
  available. **When a doc names a local command as the safety net, RUN IT** —
  the failure mode is silent and it compounds every time the gap is cited.

- **Port a guard, do not move it.** The Python still runs in iOS CI, where the
  five checks that genuinely need Python live. Moving the sixth would have
  quietly reduced macOS coverage to buy local coverage. The parity case comparing
  the two scan scopes is the part that makes two copies safe — US-2342 exists
  precisely because four scripts each kept their own copy of that list and all
  four omitted `Packages`, where the money math lives.

- **Check `git status` before `git add -A`, every time.** This iteration's stage
  picked up `src/lib/pwa/` and a modified `vite.config.ts` from the concurrent
  agent working the same tree. Committing them would have attributed someone
  else's in-progress work to this story and possibly shipped it half-done. Stage
  the files you touched BY NAME when another agent is live.

- **A review with an item saying "needs a final targeted check" is a review with
  an open question presented as a finished document.** Gap 6 sat that way through
  every iteration of the fix loop, invisible because the fix loop reads
  FIX-PROGRESS.md and the unfinished check lived in REVIEW-FINDINGS.md. It had no
  story, so nothing in the story list could ever surface it. **Before declaring a
  review complete, grep its own findings for hedges** — "needs a check", "verify",
  "TODO", "unclear" — because those are precisely the items that never became
  work.

- **THREE TIMES NOW: grep for the CAPABILITY, not the NAME.** US-2510
  (NotificationCenter vs NotificationBell), US-2556 (types built in a lib rather
  than inline at the call site), and now gap 6 — iOS had no tab called "My
  stores", so a name search found nothing, while the endpoint, the fetch, the
  render and the error state were all there. The tell is identical each time: the
  finding describes a MISSING SURFACE and the search was for a STRING. Search for
  the endpoint, the table, or the helper module instead.

- **Confirm the break APPLIED before reading a green as proof.** Proving this
  guard bit took two attempts: `String.replace` with a string replaces only the
  FIRST occurrence, so removing one `PersonalSummaryRow` left another and the
  rendering assertion stayed green. That looks exactly like a weak guard. Use
  `split().join()` or a global regex, and re-read the diff — a bite-check that
  silently no-ops is worse than not running one, because it certifies the guard.
