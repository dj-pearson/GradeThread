# GradeThread full-surface review — findings

Severity key: **P1** breaks a paying user / wrong money / dead end · **P2** real UX or
completeness gap · **P3** polish, consistency, craft floor.

---

## B01 — Seller core

### /dashboard (`src/pages/dashboard.tsx`)
- **P2** Promo-before-work ordering. The page stacks 14 sections; the first ~8 are banners,
  checklists, promos and cross-sells (PWA banner, activation checklist, first-run card,
  quick actions, rewards widget, usage, FlipDesk promo, "Discover GradeThread", invite a
  friend, impact tile) before the seller's own data. Recent Submissions — the thing they
  came for — is dead last. `dashboard.tsx:456-769`.
- **P2** Usage is rendered twice: `<UsageMeters />` at `dashboard.tsx:524` and a hand-built
  "Grades Used" meter card at `dashboard.tsx:580-598`. Same number, two designs, one screen.
- **P3** The three stat cards (`dashboard.tsx:579-660`) are the generic icon-tile card row
  the house UI floor calls out. They carry three numbers that would read better as one line.
- **P2 (verify)** `gradesPercent = gradesUsed / gradesLimit` at `dashboard.tsx:278` divides by
  the plan's included count. If a plan has `includedStandardGradesPerMonth: 0` this is
  `0/0 = NaN` and the Meter gets `NaN`. Check the free tier's value.
- **P3** Quick action "Add Inventory Item" points at `/dashboard/inventory/new`
  (`dashboard.tsx:150`), a legacy path that immediately redirects. Point it at
  `/dashboard/flipdesk/intake` directly.
- **P3** Recent submissions show `toLocaleDateString()` only — no relative time, no grade
  tier, no thumbnail. `dashboard.tsx:735`.

### /dashboard/submissions (`src/pages/submissions.tsx`)
- **P2** No text search. The Filters card is titled with a magnifying-glass icon
  (`submissions.tsx:487`) but offers only two dropdowns — status and garment type. A seller
  with 300 submissions cannot find one by title or brand.
- **P2** No date-range filter and no certificate column.
- **P3** Sort state is invisible: both sortable headers render a static `ArrowUpDown`
  (`submissions.tsx:607,616`) with no active/direction indicator.
- **P2** "My Disputes" is a permanent second table on the list page with a full empty state
  for the 99% of sellers who have none (`submissions.tsx:709-803`). Collapse it when empty
  or move it under Account.
- **P2** No row selection and no bulk actions (export selected, delete, re-grade).
- **P3** Mobile: a five-column table inside `overflow-x-auto` with no card fallback
  (`submissions.tsx:594`).

### /dashboard/submissions/new (`src/pages/new-submission.tsx`)
- **P1 (verify)** Duplicate-submission path. When the server answers `checkoutRequired`, a
  submission row already exists. "Change tier" (`new-submission.tsx:1575`) clears
  `checkoutState` and returns to the tier picker with the Submit button live, so pressing
  Submit again POSTs `/api/grade/submit` a second time and creates a second submission.
  Should resume the existing `submissionId` instead of re-submitting.
- **P2** Tier is chosen twice: `GradePricingSummary` on step 1 (`new-submission.tsx:1062`)
  and the three-card tier grid on step 3 (`new-submission.tsx:1383-1420`). Same state, two
  controls, two screens apart.
- **P2** The Live Capture pitch (`new-submission.tsx:1354-1371`) tells a web seller to use
  the iOS app and gives them no way to get it — no App Store link, no QR, no "text me the
  link". A conversion surface with no conversion.
- **P3** Step labels are `hidden sm:block` (`new-submission.tsx:176`), so on a phone the
  wizard is three unlabeled numbered circles.
- **P3** No `aria-current="step"` on the step indicator — the wizard's position is not
  announced.
- **P3** Hand-rolled `<h1>` (`new-submission.tsx:977`) instead of the shared `PageHeader`
  every other dashboard page uses.

### /dashboard/submissions/bulk (`src/pages/bulk-submission.tsx`)
- **P1** Stale plan names in the paywall. The gate allows `["pro","business"]`
  (`bulk-submission.tsx:61`) but the locked-state heading reads "Available on Professional &
  Enterprise" (`bulk-submission.tsx:402`) — neither name is a live tier. A seller can't tell
  what to buy.
- **P1** No cost preview before a batch. Submitting 80 rows draws included grades, then
  credits, then charges — with no "this will use N included, M credits and charge $X"
  confirmation. The single-submission flow has exactly this summary; bulk does not.
- **P2** No CSV template download. The column contract lives only in a paragraph of prose
  (`bulk-submission.tsx:441-449`).
- **P2** No cancel during submit. The loop is sequential over every valid row
  (`bulk-submission.tsx:308`) with no abort, and navigating away kills the batch mid-way.
- **P2** Failed rows are listed but not retryable (`bulk-submission.tsx:685-708`) — the
  seller must fix the CSV and re-upload the whole thing.
- **P3** Invalid rows can't be corrected inline.
- **P3** Hand-rolled `<h1>` again (`bulk-submission.tsx:390,429`), and the locked state drops
  the "Back to Submissions" link.

### /dashboard/submissions/:id (`src/pages/submission-detail.tsx`)
- **P2** Two buttons, one destination. On the linked-inventory card, "Use this grade in a
  listing" → `/dashboard/flipdesk/items/:id` and "View item" → `/dashboard/inventory/:id`
  (`submission-detail.tsx:958,965`), and the second path redirects to the first.
- **P2** Six stacked post-grade cards after the report: graded photo, showcase consent,
  share certificate, passport panel, FlipDesk nudge, dispute, gallery
  (`submission-detail.tsx:1504-1681`). Consolidation candidate — one "What's next" action
  strip or a tabbed panel.
- **P2** The submitted-photo gallery has no lightbox or zoom (`submission-detail.tsx:1654`).
  On a condition-grading product, being unable to enlarge the evidence photo is a real gap.
- **P3** No "download all photos" for the seller's own records.

### /dashboard/snap (`src/pages/snap.tsx`)
- **P2** No history. Every snap is thrown away on reload — no list of past snaps, no way to
  return to one. Compare Submissions, which persists everything.
- **P3** The value half of the result renders "—" plus "add a brand/item to see value"
  (`snap.tsx:162-172`) — the fields that unlock it are above the fold and already filled in
  or not; the result should offer an inline "add brand" instead of sending the user back up.
- **P3** Hand-rolled header, no `PageHeader` (`snap.tsx:67-75`).
- **P3** No share affordance on a snap result, and no link into `/whats-it-worth` (the public
  page that sells the same thing).

### /dashboard/rewards (`src/pages/rewards.tsx`)
- **P2** Nine stacked panels (celebrations, level, integrity, loyalty, badges, milestones,
  quests, leaderboard, season, perks, recaps) with no tabs or sections
  (`rewards.tsx:138-340`). Longest page in the seller app and it is entirely secondary.
- **P3** Loading state is a bare centered spinner (`rewards.tsx:116`) while the rest of the
  app uses skeletons.
- **P3** No empty/first-run state — a brand-new seller sees level 1 with every panel at zero.

---

## B02 — Seller account

### Cross-cutting: every account page has two URLs
- **P2** `settings`, `billing`, `team`, `api-keys` and `referrals` are each mounted twice —
  as a standalone route (`routes/index.tsx:542-549`) and as a tab inside the Account hub
  (`account.tsx:56-74`). Identical content, two URLs, two entries in history, two things to
  keep in the sidebar. Pick the hub and redirect the standalone paths (the pattern
  `/dashboard/flipdesk/*` already uses for its consolidated hosts).

### /dashboard/account (`src/pages/account.tsx`)
- **P3** The hub has no "Account" heading of its own — the tab strip is the entire page
  chrome, and children suppress their own `PageHeader`. On landing you get a bare row of
  tabs under the app header.
- **P2** No "Danger zone"/delete-account, 2FA or session tab at hub level — those live buried
  at the bottom of the Settings tab's 14-card stack (below).

### /dashboard/settings (`src/pages/settings.tsx`)
- **P2** Fourteen unrelated cards in one column: Profile, Business & Shipping, Notification
  Preferences, Usage Alerts, AI Item Assistant, Product tour, FlipDesk prefs, Data Export,
  Formal data requests, Change Password, Active Sessions, Delete account, Storage
  (`settings.tsx:613-1500`). Security (password / sessions / delete) is mixed in with
  cosmetic preferences, and the destructive action is at the very bottom of a 1,500-line
  scroll. Needs sub-tabs: Profile · Preferences · Notifications · Security · Data.
- **P2** No search across settings.

### /dashboard/billing (`src/pages/billing.tsx`)
- **P2** Usage is rendered twice on one page: the three `UsageMeter`s inside the subscription
  card (`billing.tsx:484-504`) and `<UsageMeters />` again under a heading that literally
  says "Same data, compact view" (`billing.tsx:657-667`). Delete one.
- **P2** No invoice/receipt list in-app — every receipt path is "open the Stripe portal"
  (`billing.tsx:683-690`). A billing page that can't show a past invoice is incomplete.
- **P3** The trial banner hardcodes "Pro free trial active" (`billing.tsx:342`) regardless of
  which plan is trialing.
- **P3** For a store-managed subscription the copy is "open the GradeThread iOS app and go to
  Settings → Subscription" (`billing.tsx:309`) with no deep link. `itms-apps://` for the
  App Store subscriptions page is one line.
- **NOTE for B18** — credit packs and per-grade purchases stay purchasable on web for an
  App-Store-managed subscriber (`billing.tsx:310`). Confirm iOS offers the same two things,
  or the same subscription buys less on iOS.

### /dashboard/api-keys (`src/pages/api-keys.tsx`)
- **P2** This is a whole developer product living inside an Account tab: keys table,
  Developer Resources, `ApiUsagePanel`, `ApiOverageCard`, `WhiteLabelPanel`
  (`api-keys.tsx:440-603`). It deserves its own top-level Developers area.
- **P3** Two of the three "Developer Resources" tiles are non-interactive `div`s styled
  identically to the one that is a link (`api-keys.tsx:563-592`) — they look clickable and
  aren't.
- **P3** The 7-column keys table has no `overflow-x-auto` wrapper (`api-keys.tsx:467`), unlike
  every other table in the app.
- **P3** The empty state is hand-rolled instead of the shared `EmptyState` and carries no CTA
  (`api-keys.tsx:458-465`).

### /dashboard/team (`src/pages/team.tsx`)
- **P2** No seat count or seat cost anywhere. Inviting a member gives no signal about plan
  limits or per-seat billing.
- **P2** No audit log of role changes / removals — the MFA policy card is here, so this is
  the security surface, and it has no history.
- **P3** Neither the members table nor the invites table is wrapped in `overflow-x-auto`
  (`team.tsx:343,469`); the members table puts a `w-44` Select in a cell.
- **P3** The synthetic owner row prints "Workspace owner" in the *Joined* date column
  (`team.tsx:369`).

### /dashboard/referrals (`src/pages/referrals.tsx`)
- **P2** Eight stacked cards — link, stats, milestones, "were you referred?", promo code,
  earned-link badge, affiliate payouts, leaderboard opt-in (`referrals.tsx:311-730`). The
  promo-code redeemer in particular has nothing to do with referrals and belongs in Billing.

### /dashboard/support (`src/pages/support-tickets.tsx`)
- **P2** No attachments. On a photo-grading product the first thing a user wants to send
  support is the photo that failed.
- **P2** The thread never refreshes — no `refetchInterval`, no realtime (`support-tickets.tsx:110-121`).
  A user waiting on a reply has to reload the page.
- **P2** No unread badge anywhere in the app when support replies.
- **P3** A user can't close or resolve their own ticket.
- **P3** Both error branches are a bare red line, not the shared `ErrorState` with retry
  (`support-tickets.tsx:270-276,327-333`).

### /accept-invite (`src/pages/accept-invite.tsx`)
- **P3** No expiry countdown on the accept screen — the invite has `expires_at` and the page
  never shows it.
- **P3** Logo `<img>` has no width/height (`accept-invite.tsx:279`), so it shifts layout.

### /connect-extension (`src/pages/connect-extension.tsx`)
- **P2** Dark mode is broken: the page paints a hardcoded `bg-brand-gray`
  (`connect-extension.tsx:121`) and the success panel uses `bg-emerald-50 text-emerald-800`
  with no dark variants (`connect-extension.tsx:155`).
- **P2** The "extension not detected" error tells the user to install it and gives no store
  link (`connect-extension.tsx:94`).
- **P3** Emoji used as UI ("Extension connected 🎉", `connect-extension.tsx:156`).

### /dashboard/measurements (`src/pages/fit/body-profiles.tsx`)
- **P2** No link out to the fit checker. The entire point of saving measurements is checking
  fit, and the page never mentions `/tools/fit-checker`.
- **P2** Uses its own `mx-auto max-w-3xl px-4 py-8` container and a hand-rolled `<h1>`
  (`body-profiles.tsx:159-162`) inside the dashboard shell — it reads as a different app.
- **P3** No empty state: a new user gets a blank page with one "Add a profile" button.
- **P3** Loading is a bare centered spinner, not a skeleton (`body-profiles.tsx:184-187`).

---

## B03 — FlipDesk A (overview, inventory, item, intake, import, search)

### /dashboard/flipdesk (`src/pages/flipdesk/overview.tsx`)
- **P2** "Click a stage to filter the items view" (`overview.tsx:331`) is not what happens.
  Each pipeline tile links to `?status=<stage>`, and `statusParamToTab`
  (`inventory-tabs.ts:41-49`) collapses all nine pre-list stages into one `to_list` tab. A
  tile reading "Measured 12" lands the seller on a tab of every unlisted item. The tile
  promises a filter the destination can't apply.
- **P2** Every metric is computed in the browser by looping the whole item list
  (`overview.tsx:162-212`, `useItemsList()`). At a few thousand items this is a large
  payload plus a full scan on each render — the counts belong in a server aggregate.
- **P2** No date range. Everything is hardcoded to "this week" or all-time; a seller cannot
  ask "last month".
- **P2** Aging items and Stale listings each show 5 rows with a total-count badge and no
  "view all" (`overview.tsx:239,241`).
- **P3** Aging rows are not links; stale rows are (`overview.tsx:410` vs `overview.tsx:511`).
- **P3** Four `StatCard`s in a row with `text-xs uppercase tracking-wide` labels
  (`overview.tsx:607`) — the tracked-uppercase eyebrow the house UI floor calls out.

### /dashboard/flipdesk/inventory (`src/pages/flipdesk/inventory.tsx`)
- **P3** The Suspense fallback is always a table skeleton (`inventory.tsx:60`) regardless of
  which mode is loading, so switching to Kanban flashes a table.

### /dashboard/flipdesk/items/:id (`src/pages/flipdesk/item.tsx`)
- **P2** Four separate components each run their own query against the SAME `listings` row
  for the same item: `ListingAlertsSection` (`item.tsx:361`), `EbayNativeNotice`
  (`item.tsx:273`), `PromotionSaleCard` (`item.tsx:690`) and `GradethreadListingCard`. Plus
  `LeaveFeedbackCard` (sales), `AutomationOptOutCard` (inventory_items), `ListingQualityCard`
  and the composer. One item view fires roughly ten round trips.
- **P2** Twelve panels stacked in one column with no tabs (`item.tsx:131-251`). A listed,
  graded, sold item renders alerts, quality, eBay notice, listing card, promotions, feedback,
  the full composer, condition index, relist suggestion, disclosure and automations — in a
  single scroll. This is the app's most-used page and it has no structure.
- **P2** Back goes to a hardcoded `/dashboard/flipdesk/items` (`item.tsx:81,142`), discarding
  whatever tab, filter or saved view the seller arrived from.
- **P3** Two "grade this item" nudges can render at once — `CrossSurfaceNudge`
  (`item.tsx:164`) and `GradeRoiHint` (`item.tsx:187`) — both scrolling to `#canvas-grading`.
- **P3** Breadcrumb still says "Items" (`item.tsx:143`); the surface is called Inventory now.

### /dashboard/flipdesk/intake (`src/pages/flipdesk/intake.tsx`)
- **P2** No photo capture in the default intake form. A reseller's first action on a new item
  is shooting it, and that requires switching to `?mode=snap` or saving and reopening the
  item. Photos should be on the main form.
- **P2** No unsaved-changes guard. Cancel or Back abandons a filled form silently
  (`intake.tsx:445,764`), while `new-submission.tsx` guards exactly this.
- **P2** No measurements field, though `measured` is a pipeline status and a measure-card
  page exists.
- **P3** Hand-rolled `<h1>` instead of `PageHeader` (`intake.tsx:451`).
- **P3** "Title *" marks required with an asterisk in the label text (`intake.tsx:538`), with
  no `required`/`aria-required` on the input.

### /dashboard/flipdesk/import (`src/pages/flipdesk/import.tsx`)
- **P2** The whole import runs client-side in a loop and the UI says "Don't close this tab"
  (`import.tsx:766`). Closing the tab kills it mid-batch. The codebase already has a durable
  job runner (autolister) — this belongs there.
- **P2** No undo. Import matches on SKU and *updates* existing items
  (`import.tsx:368`), so one bad column mapping overwrites real inventory with no rollback.
- **P2** No template download — same gap as bulk grading upload.
- **P3** Hand-rolled progress bar divs (`import.tsx:756-765`) instead of the shared `Progress`.

### /dashboard/flipdesk/search (`src/pages/flipdesk/search.tsx`)
- **P2** A failed search renders "No matches". The RPC error is swallowed into an empty array
  (`search.tsx:111-113`), so an outage is indistinguishable from a genuine zero-result search.
- **P2** No pagination or result cap indicator — the RPC's limit is invisible to the user.
- **P3** No keyboard navigation, though each row shows a return-key affordance
  (`search.tsx:211`).
- **P3** No recent or saved searches.
- **P3** Hand-rolled `<h1>` instead of `PageHeader` (`search.tsx:132`).

---

## B04 — FlipDesk B (autolister, queue, bulk edit, scheduled drops, offers, post-sale)

### Cross-cutting: three god-components
- **P2** `FlipdeskAutolisterPage` is one function from `autolister.tsx:587` to the end of the
  file — about 3,750 lines with 64 hook calls in a single component.
  `FlipdeskAutolisterBulkEditPage` is ~1,800 lines / 37 hooks (`autolister-bulk-edit.tsx:192`).
  `FlipdeskAutolisterQueuePage` is ~1,000 lines / 22 hooks (`autolister-queue.tsx:101`).
  These are the three highest-traffic seller surfaces, every state change re-renders the
  whole tree, and nothing in them is independently testable.

### /dashboard/flipdesk/autolister (`autolister-host.tsx`, `autolister.tsx`)
- **P3** The host's loading fallback is a bare spinner (`autolister-host.tsx:34-40`) where the
  rest of the app uses skeletons.
- **P3** Hand-rolled `<h1>` (`autolister.tsx:2910`) instead of `PageHeader`, and two
  `text-sm font-semibold uppercase tracking-wide` section eyebrows
  (`autolister.tsx:3435,3745`) — the tell the house UI floor names.
- **P2** Queue and Bulk edit are deliberately not tabs of this host
  (`autolister-host.tsx:17-21`), so a seller mid-batch moves between three URLs with no
  visible relationship. A batch-scoped breadcrumb or step strip would fix it without adding
  empty tabs.

### /dashboard/flipdesk/scheduled-drops (`src/pages/flipdesk/scheduled-drops.tsx`)
- **P2** The calendar is read-only. There is no reschedule, no cancel, no drag — every
  interaction is a link into the item draft (`scheduled-drops.tsx:345,379`). A scheduling
  surface you cannot schedule from.
- **P2** No bulk action (shift a day's drops, cancel a batch).
- **P3** Day cells render every drop with no "+N more" overflow (`scheduled-drops.tsx:344`);
  a busy day blows out a 6rem cell.
- **P3** "Upcoming" is hard-capped at 12 with no "view all" (`scheduled-drops.tsx:378`).
- **P3** Loading is a bare spinner rather than a calendar skeleton
  (`scheduled-drops.tsx:300-303`); the grid has no `role="grid"` or keyboard traversal.

### /dashboard/flipdesk/offers (`src/pages/flipdesk/offers.tsx`)
- **P2** eBay only. Best Offers, send-offer and buyer messages all go through the eBay hooks;
  the app registers seven platforms and none of the others appear here. Either say so on the
  page or support them.
- **P2** Buyer messages needing a reply are counted on this page only
  (`offers.tsx:607`) — nothing badges the sidebar or the dashboard, so a seller who doesn't
  visit Offers never learns a buyer is waiting.
- **P3** "No recent messages." is a bare paragraph rather than `EmptyState` (`offers.tsx:655`).

### /dashboard/flipdesk/post-sale (`src/pages/flipdesk/post-sale.tsx`)
- **P2** Return rows never name the item. They show reason, return id and date
  (`post-sale.tsx:515-525`); cancellations show an order id (`post-sale.tsx:702-704`). The
  seller is asked to approve a return, refund it, or cancel an order without being told
  which garment it is. Add title, thumbnail and sale price.
- **P2** No deep link to the eBay case for a return or cancellation.
- **P2** Open returns and cancellations aren't surfaced anywhere else — no dashboard tile,
  no sidebar badge — despite being the most time-sensitive thing in the app.
- **P3** eBay only, same as Offers.

---

## B05 — FlipDesk C (money, pricing, sourcing, analytics, consignment, marketplaces, measure card, verified)

### Cross-cutting: the four tab hosts have no name on screen
- **P2** `money.tsx`, `pricing.tsx`, `sourcing.tsx` and `autolister-host.tsx` each render a
  bare `TabsList` and deliberately no `PageHeader` (`money.tsx:20-23`, `pricing.tsx:17-22`).
  The result on screen is: app header → an unlabelled row of tabs → the hosted page's own
  title. A seller who lands on `/dashboard/flipdesk/money` sees tabs and then a heading that
  says "Finances"; the word "Money" appears only in the sidebar. Give each host a title and
  suppress the child's, or drop the child header into a section heading.
- **P3** All four use a bare centred `Loader2` as the Suspense fallback
  (`money.tsx:42-48`, `pricing.tsx:49-55`, `autolister-host.tsx:34-40`) where the rest of the
  app uses skeletons.

### /dashboard/flipdesk/analytics (`src/pages/flipdesk/analytics.tsx`)
- **P2** Every tab owns its own date-range Select (`analytics.tsx:323,525,…`), so the range
  does not carry across tabs — a seller comparing sell-through and grading ROI over 90 days
  has to set it twice. Lift the range to the page.
- **P3** Fixed 30d / 90d / 365d presets with no custom range.

### /dashboard/flipdesk/consignment (`src/pages/flipdesk/consignment.tsx`)
- **P2** No consignor statement. There is no per-consignor PDF or CSV to send the person
  whose items you sold — the core paper artifact of running consignment.
- **P3** The error branch renders `Failed to load consignors: {String(error)}`
  (`consignment.tsx:~232`) — a stringified error object in the UI, with no retry, instead of
  the shared `ErrorState`.

### /dashboard/flipdesk/marketplaces (`src/pages/flipdesk/marketplaces.tsx`)
- **P2** No status summary. Eight prose sections and the seller still cannot see at a glance
  which platforms are connected, which need re-auth and which are pending. One
  platform × mechanism × status × action table at the top would replace most of the page.
- **P2** Seven `text-xs font-semibold uppercase tracking-wide` section eyebrows
  (`marketplaces.tsx:1401,1425,1456,1480,1503,1539,1553`) are the page's entire structure —
  the exact pattern the house UI floor calls out, repeated seven times.
- **P3** The disclosure lists are good and honest but long; they belong behind a per-channel
  expander rather than inline for every channel at once.

### /dashboard/flipdesk/marketplaces/google (`src/pages/flipdesk/marketplaces-google.tsx`)
- **P3** "Not available yet … Check back soon." (`marketplaces-google.tsx:147-152`) with no
  way to be notified when it is.
- **P3** Hand-rolled `<h1>` instead of `PageHeader` (`marketplaces-google.tsx:135`), and a
  hardcoded `bg-emerald-600` badge rather than a theme token.

### /dashboard/flipdesk/measure-card (`src/pages/flipdesk/measure-card.tsx`)
- **P2** The mail-a-card form is US-only and never says so: no country field, `State` is free
  text and the postal field is labelled ZIP (`measure-card.tsx:282-299`). A non-US seller
  fills it in and gets a card that can't be sent.
- **P2** No picture of the card. The page teaches you to frame "all four black squares"
  (`measure-card.tsx:42`) and never shows the object.
- **P3** A failed status read returns `null` (`measure-card.tsx:69`), so the page offers
  "request a card" to someone whose request is already in flight.
- **P3** Hand-rolled `<h1>` and its own page container (`measure-card.tsx:121-126`); bare
  spinner for loading (`measure-card.tsx:221`).

### /dashboard/flipdesk/verified (`src/pages/flipdesk/verified.tsx`)
- **P2** No preview of the public profile. The whole page configures what buyers see and the
  only way to see it is opening a new tab (`verified.tsx:354-362`).
- **P2** Seven stacked cards — stats, profile form, three publish switches, badge embed,
  badge performance, badge studio, passport identity (`verified.tsx:200-405`).
- **P3** Two of the three publish switches are disabled until the first is on
  (`verified.tsx:326,345`) with no inline reason next to them.
- **P3** Handle availability is conveyed by colour + icon with no `aria-live` region
  (`verified.tsx:229-247`).

---

## B06 — Buyer app

### Cross-cutting: retry means "reload the whole page"
- **P2** Seven `ErrorState onRetry={() => window.location.reload()}` across the buyer app —
  `alerts.tsx:386,422,486`, `portfolio.tsx:321`, `guarantee.tsx:133`, `demand.tsx:138`,
  `rewards.tsx:593`. Every other surface in the product calls `refetch()`. A full reload
  discards whatever the buyer had typed and re-runs every query on the page.

### Cross-cutting: five hand-rolled paywalls
- **P2** `BuyerPlaceholderPage` exists precisely to render the locked state
  (`placeholder.tsx:35-50`), and five pages reimplement it inline instead —
  `alerts.tsx:242`, `portfolio.tsx:136`, `guarantee.tsx:95`, `rewards.tsx:478`,
  `demand.tsx:37-50`. Each has its own `<h1 className="text-xl font-bold">` and its own copy.
- **P3** Four buyer pages carry a `text-sm font-semibold uppercase tracking-wide` section
  eyebrow (`home.tsx:161,187`, `portfolio.tsx:276`, `demand.tsx:130`, `rewards.tsx:579`).

### /buyer (`src/pages/buyer/home.tsx`)
- **P2** The "Get started" cards never complete. `FIRST_STEPS` is a static array
  (`home.tsx:80-102`) with no progress tracking, so a buyer with five live alerts is still
  told to "Create an alert". The seller side has `ActivationChecklist`, which self-hides.
- **P2** Nothing on the buyer's home is about the buyer's own activity — no recent alert
  matches, no recently scanned certificates, no watched items. It is a trust card, an impact
  card and two tile grids.
- **P2** "Get the extension" links to `/buyer/settings` (`home.tsx:86`) rather than a Chrome
  Web Store listing.
- **P3** `→` / `←` as literal text in links (`home.tsx:178`, `placeholder.tsx:76`).

### /buyer/* not-found (`src/pages/buyer/placeholder.tsx`)
- **P2** The buyer 404 is the "coming soon" component. The catch-all route renders
  `BuyerPlaceholderPage title="Not found"` (`routes/index.tsx:578`), which draws a Sparkles
  icon over "That buyer page doesn't exist yet" — a mistyped URL reads as an unshipped
  feature. The seller side has a real `InShellNotFound`.

### /buyer/onboarding (`src/pages/buyer/onboarding.tsx`)
- **P2 (verify)** The category chips are a hardcoded 13-item list
  (`onboarding.tsx:21-24`) that is not `GARMENT_TYPES` or `ITEM_CATEGORIES`. If alert
  matching keys off the shared taxonomy, a buyer who picks "sneakers" here may never match.
- **P3** Sizes are saved as a single `{ all: sizes }` bucket (`onboarding.tsx:51`), so one
  size applies across every category.
- **P3** No step indicator and no way out except Skip.

### /buyer/billing (`src/pages/buyer/billing.tsx`)
- ~~**P1** No store-managed branch...~~ **CORRECTED IN B18.** Buyer plans are not sold
  through IAP at all (the `.storekit` catalogue contains only the three seller subscriptions
  and four credit packs), so a store-owned buyer subscription cannot arise and the missing
  branch is correct behaviour, not a defect. The seller-plan-bundled case is handled too:
  `billing.tsx:327-332` routes `fromSellerPlan` users to seller billing, which does show the
  App Store banner. Withdrawn.
- **P2** Cancelling a buyer plan is one unconfirmed click (`billing.tsx:159`). The seller
  side routes every cancellation through `CancelSubscriptionDialog` with a period-end
  statement, an acknowledgement checkbox, reason capture and an undo banner.
- **P3** Plan tiles show `plan.features.slice(0, 5)` (`billing.tsx:256`) with no "see all",
  so a plan's remaining features are invisible at the point of sale.
- **P3** No annual-saving percentage next to the monthly/yearly toggle
  (`billing.tsx:216-230`), which is hand-rolled rather than a ToggleGroup.

### /buyer/demand (`src/pages/buyer/demand.tsx`)
- **P2** Brands, categories and keywords are free-text comma lists with no autocomplete
  (`demand.tsx:96-105`), so a typo silently never matches — while onboarding one screen away
  uses a chip picker for the same categories.
- **P2** No matches view. Posting a want returns a toast with a count
  (`demand.tsx:76`) and there is no way to see what matched, then or later.
- **P3** Raw `<input type="checkbox">` (`demand.tsx:117`) instead of the shadcn `Checkbox`.

### /buyer/alerts, /buyer/portfolio, /buyer/guarantee, /buyer/rewards, /buyer/settings
- Covered by the two cross-cutting findings above (reload-as-retry, hand-rolled paywalls).
- **P2** `alerts.tsx` carries three separate error branches all reloading the page
  (`alerts.tsx:383,419,483`), which suggests three independent queries that should share one
  boundary.

---

## B07 — Public trust surfaces

**Overall: this is the strongest part of the product.** `certificate.tsx` in particular is
the best page in the app — five distinct integrity states with copy calibrated to each
(`certificate.tsx:152-262`), JSON-LD, print styles, a lightbox, breadcrumbs and a passport
carry-forward. Findings below are gaps, not rewrites.

### /cert/:id (`src/pages/certificate.tsx`)
- **P2** The "Integrity check failed — do not trust this certificate" state
  (`certificate.tsx:212-227`) tells a buyer the worst possible news and gives them nothing to
  do. No report link, no support contact, no "what now". Same for the `unsigned` state, which
  says "contact support" without a link (`certificate.tsx:240`).
- **P3** Roughly a dozen stacked cards. Defensible for a certificate, but the buyer-critical
  ones (score, integrity, photos) and the reference ones (coverage, design features, factor
  weights) could separate.

### /t/:code (`src/pages/tag-scan.tsx`) and /claim/:token (`src/pages/passport-claim.tsx`)
- **P2** "Claim this item" is offered to an anonymous visitor and the POST goes out with no
  auth header when signed out (`tag-scan.tsx:57-58`). Either the server accepts an anonymous
  ownership claim on a provenance chain — which means anyone who scans a tag in a shop can
  claim a garment they don't own — or it rejects it and the buyer gets a generic failure.
  Verify the server, then either gate the button behind sign-in or say so on it.
- **P2** Every claim failure collapses to "Couldn't claim this item. Please try again."
  (`tag-scan.tsx:72`) — not-signed-in, already-claimed and network are indistinguishable.
- **P3** Claiming transfers ownership and is a single unconfirmed click (`tag-scan.tsx:103`).

### /embed/grade/:id (`src/pages/embed-grade.tsx`)
- **P2 — ~~crawlable~~ CORRECTED (US-2549).** The page renders no SEO component, which is
  what I checked, but it was never crawlable: `/embed/*` is routed to Pages Functions
  (`public/_routes.json`), `functions/embed/grade/[id].ts` delegates every non-`.js`
  request to `serveSpaShell`, and that helper sends `x-robots-tag: noindex, nofollow` on
  every response (US-2045). A header outranks a meta tag, so the strongest available
  mechanism was already in place. The finding was written from the SPA route in isolation;
  the serving path is what decides indexing. `<SEO noindex>` was still added as the stated
  decision in the page, and the guard pins the HEADER as the thing that must not be
  removed. (Note: `logo`, `support` and `color` params *are* properly sanitized —
  `embed-grade.tsx:55-59` — so the obvious injection vector is already closed.)
- **P3** `company` is rendered unvalidated as the card's header (`embed-grade.tsx:134`), so a
  crafted URL can show any brand name on a gradethread.com page. Text-only, so low severity,
  but it is a trust surface.
- **P3** Loading is the bare string "Loading grade…" (`embed-grade.tsx:108`) and the error
  state has no retry and no link back to GradeThread (`embed-grade.tsx:113-119`).
- **P3** Hardcoded light palette (`bg-white`, `text-slate-*`) — deliberate for a partner
  surface, but it means the card is unreadable embedded on a dark site.

### /leaderboard (`src/pages/referral-leaderboard.tsx`) and /waitlist-pending
- **P2 — ~~no decision~~ CORRECTED (US-2529, confirmed again in US-2549).** Both already
  have one, in different places, which is why a grep for `<SEO` in the two page files found
  nothing. `/leaderboard` renders inside `MarketingLayout`, which emits the SEO block for
  it. `/waitlist-pending` is served by its own Pages Function through `serveSpaShell`
  (`x-robots-tag: noindex, nofollow`) and is listed in `DISALLOWED_PATHS` in
  `functions/_shared/seo-config.ts`. Pinned in `src/test/embed-grade-indexing.test.ts` so
  neither is re-filed.

### /not-found (`src/pages/not-found.tsx`)
- **P3** `InShellNotFound` (`not-found.tsx:53-76`) drops the helpful-links nav the root 404
  carries, so an in-app 404 offers exactly one destination.
- **P3** The logo `<img>` has no width/height (`not-found.tsx:20`) — same CLS issue as
  `accept-invite.tsx:279`.

### /verified, /verified/:handle, /finds, /leaderboards, /trust/:handle, /passport/:slug, /status
- No material findings. All carry proper skeletons, `EmptyState`/`ErrorState` with real
  retries, and the SEO/noindex decision is made explicitly on each.
- **P3** `verified-directory.tsx:98,106` uses two `text-[11px] uppercase tracking-wide` stat
  eyebrows — the same house-floor pattern flagged elsewhere.

---

## B08 — Auth (login, signup, callback, confirm, reset) + layouts and guards

**Overall: the security work here is unusually careful.** Enumeration-safe failure copy,
rate-limit vs network vs credential classification (`login.tsx:91-98`), Turnstile
single-use reset, OAuth re-entry guards, keep-signed-in scoping to sessionStorage,
`?next=` sanitisation, an email-verification gate and a legal-consent gate on the protected
route. The findings are UX and metadata, not security.

### Cross-cutting: no auth page has an SEO component
- **P2** None of `login.tsx`, `signup.tsx`, `reset-password.tsx`, `auth-confirm.tsx` or
  `auth-callback.tsx` imports or renders `<SEO>` (verified by grep — zero matches). Five
  public routes with no `<title>`, no description and no noindex decision. `/auth/confirm`
  and `/auth/callback` carry tokens in the URL and should certainly be `noindex`.

### Cross-cutting: no password affordances
- **P2** No show/hide toggle on any of the four password fields — `login.tsx:182`,
  `signup.tsx:403`, `reset-password.tsx:292` and `:310`. On mobile this is the single most
  common cause of a failed sign-in.
- **P2** No password strength feedback on signup or on reset. The user finds out their
  password was rejected after submitting.

### /login (`src/pages/login.tsx`)
- **P3** Validation errors are inline and screen-reader-associated (`login.tsx:165-168`), but
  the actual sign-in failure is a transient toast (`login.tsx:92`). Two different error
  channels in one form; the failure that matters most is the one that disappears.
- **P3** No email-code / magic-link sign-in option, even though `/auth/confirm` already
  implements a full 6-digit OTP flow with resend and cooldown.

### /auth/confirm (`src/pages/auth-confirm.tsx`)
- **P3** The code input renders `<FieldError id="confirm-code-error">` but the `<Input>` has
  neither `aria-describedby` nor `aria-invalid` pointing at it (`auth-confirm.tsx:205-221`).
  `login.tsx` wires exactly this correctly, so it is an inconsistency, not a pattern gap.

### Layouts and guards (`layouts/auth-layout.tsx`, `components/auth/*`)
- No material findings. `ProtectedRoute` correctly preserves the attempted deep-link,
  gates on email verification and on current legal versions.
- **P3** `auth-layout.tsx:27` logo `<img>` has no width/height — third instance of the same
  CLS issue (`not-found.tsx:20`, `accept-invite.tsx:279`). Worth one shared fix.

---

## B09 — Marketing, part 1 (of 41 pages)

**Checked and clean, so recording it so nobody re-opens these:** all 41 marketing pages use
`MarketingLayout`, which renders `<SEO>` with title, description, canonical, OG image,
organization + breadcrumb JSON-LD and a `noindex` switch (`marketing-layout.tsx:59-67`).
40 of 41 also render an in-body `MarketingCTA` (only `sitemap.tsx` doesn't, correctly). The
shared header carries a "Get Started" → `/signup` button on every page. There is no missing
SEO and no missing CTA in this tree.

### The footer's Condition Index link 404s in the app
- **P2** Every marketing page's footer links to `/condition-index`
  (`marketing-layout.tsx:~155`). That path is served only by a Cloudflare Pages Function
  (`functions/condition-index/[[path]].ts`) and has **no SPA route**. Because it is a
  react-router `<Link>`, clicking it client-side never reaches the Function — it falls
  through to the `*` catch-all and renders the 404 page. `/finds` and `/leaderboards` have
  SPA fallback routes registered for exactly this reason (`routes/index.tsx:284,291`);
  `/condition-index` was missed. It is on every public page in the app.

### /pricing (`src/pages/marketing/pricing.tsx`)
- **P2** No buy button anywhere on the pricing page. The three per-grade tiles
  (`pricing.tsx:89-108`), the four credit packs (`pricing.tsx:119-129`) and the four FlipDesk
  plan tiles (`pricing.tsx:146-221`) all show a price and no action. The only conversion path
  is the "Get Started" button in the shared header.
- **P2** Monthly only. Every plan renders `plan.priceMonthlyCents` (`pricing.tsx:152`) with no
  annual toggle, so a visitor never learns annual pricing exists — while the in-app billing
  page and the buyer billing page both offer it.
- **P3** Four plan cards with variable-length feature lists and no comparison table, so
  Pro-vs-Business is a scroll-and-remember exercise.
- **P3** The page advertises unshipped features inside paid tiers — `ComingSoonBadge` on
  buyer bullets (`pricing.tsx:213`) and "Grade-locked purchase protection is on the way"
  (`pricing.tsx:252`). Honest, but it is on the page where money changes hands.

### App-wide UI craft floor (counted, not estimated)
- **P2** 106 instances of `uppercase tracking-*` section eyebrows across `src/pages` and
  `src/components`. This is the house style guide's single most-named tell, and it is the
  default section header throughout the product — 7 in marketing, the rest in the app
  (marketplaces alone has 7 on one page).
- Good news, also counted: only 2 gradient usages app-wide. The gradient-text and
  purple-gradient tells are effectively absent.

---

## B10 — Marketing part 2 + free tools + legal

### Free tools (`src/pages/tools/*`)
- **P2** A rate-limited visitor is told their photo is bad. `grade-checker.tsx:137` falls back
  to "Couldn't grade that photo. Try a clearer, well-lit shot." for any non-OK response,
  including a quota block. `snap.tsx:63` handles exactly this case properly with a
  `SNAP_LIMIT_REACHED` branch and an upgrade CTA; the three public tools have no equivalent,
  so the one moment a free user hits the paywall, we blame their camera.
- **P2** Two of the four free tools throw the result away at signup. `grade-checker.tsx` and
  `whats-it-worth.tsx` render `BuyerConversionCTAs`, which parks the result so
  `signup.tsx`, `buyer/onboarding.tsx:36` and `buyer/home.tsx:154` can pick it back up.
  `authenticity-check.tsx` and `fit-checker.tsx` do not, so a visitor who converts off those
  two loses what they just produced.
- **P2** The primary CTA on a finished result goes to an explainer. "Get a certified grade"
  links to `/how-it-works` (`grade-checker.tsx:354`, `authenticity-check.tsx:141,211`) rather
  than to signup or the submission flow — the user has already seen the value and is sent to
  read about it.
- **P3** Two more `uppercase tracking-wide` eyebrows inside the result card
  (`grade-checker.tsx:256,266`).

### Legal (`src/pages/legal/*`)
Structurally good: one shared layout, an `effectiveDate` on every page, real change-notice
clauses. Two concrete gaps, both verifiable rather than stylistic.

- **P2** The subprocessor list is missing Google and Apple. `subprocessors.tsx:15-24` lists
  ten subprocessors and names neither, while the product ships Google Sheets sync (which
  writes user inventory to their Google Drive), Google Play billing, Apple in-app purchases
  and Google Ads. The page is dated April 1, 2026. For a product that offers a DPA, an
  incomplete subprocessor list is a compliance defect, not a copy nit.
- **P2** The Terms of Service predate four shipped products. `terms.tsx` (effective April 1,
  2026) contains zero occurrences of "buyer plan", "in-app purchase", "App Store",
  "Google Play", "extension" or "consignment". Since that date the product has shipped: a
  second paid subscription (buyer plans, with its own cancellation flow), store-billed
  subscriptions whose refund and cancellation rules belong to Apple and Google rather than
  to us, the Lister browser extension — which automates the user's own logged-in marketplace
  sessions, a position `marketplaces.tsx:1495-1532` discloses carefully *in product* while
  the Terms say nothing — and consignment, which involves holding third-party goods and
  paying consignors through Stripe Connect.
- **P3** Effective dates have drifted apart: Terms and the AUP sit at April 1, 2026 while
  Privacy is August 7, 2026 and Trademarks is August 10, 2026. Nothing is wrong with that per
  se, but Terms is now the oldest document covering the newest surface area.

### Remaining marketing content pages
- No further page-level findings. The tree is template-uniform (verified in B09): shared
  layout, SEO, breadcrumbs, JSON-LD, in-body CTA. Content quality is consistent and the
  answer-first structure is applied throughout.

---

## B11 — Admin, structural pass over all 69 pages

**Checked and clean, recording it so nobody re-opens it:** there are no unconfirmed
destructive operator actions. Every real `DELETE` (`ai-models.tsx:688`,
`category-map.tsx:175`, `condition-index.tsx:287`) sits behind a confirm step — `category-map`
uses a `deleteTarget` + `confirmDelete()` dialog rather than `useConfirm`, which is why a
naive grep flags it. The other `.delete(` hits across the tree are all `Set.delete()` on
selection state.

### The admin sidebar has 81 destinations
- **P2** `adminNavItems` (`layouts/admin-layout.tsx:79-290`) defines 81 nav entries. That is
  more destinations than the seller app, the buyer app and the marketing site combined, in
  one sidebar, and the admin tree is 41,701 lines across 69 page files — larger than the
  entire customer-facing product.

### Six pairs of destinations whose names don't distinguish them
- **P2** An operator cannot tell these apart from the sidebar, and each pair is two separate
  pages:
  - "Jobs & Queues" vs "Background Jobs"
  - "System" vs "System Health"
  - "Plans & Pricing" vs "Pricing & Tiers"
  - "Review Queue" vs "Reviews"
  - "Support" vs "Support Tickets"
  - "Knowledge Base" vs "Knowledge"
  Renaming is the cheap fix; merging is the right one.

### Ten destinations answer "is the system healthy?"
- **P2** Reliability, System, Jobs & Queues, Mission Control, Activity Feed, System Health,
  Background Jobs, Dead Letters, Runbooks and Maintenance. During an incident the operator
  has to already know which of the ten holds the signal. This is the single biggest
  consolidation opportunity in the codebase.

### Other clusters worth consolidating
- **P3** Rewards is five entries (Quests, Milestone Rewards, Reward Economics, Reward North
  Star, Incentives); newsletter is four (Health, Console, Subscribers, Suppressions); AI is
  four (Models, Spend, Profitability, Assistant Monitoring); abuse is three (Moderation,
  Abuse & Fraud, Abuse Signals). Each is a tab strip, not a nav group.

### Shell consistency
- **P3** 53 of 69 admin pages use the shared `PageHeader`; 15 hand-roll an `<h1>`. Same
  inconsistency found in the seller app, at a larger scale.

---

## B12 — Admin, deep read of the seven highest-risk pages

**Verified clean, recorded so nobody re-opens these:**
- MFA step-up is enforced **server-side** on privileged grading actions (`requireStepUp` at
  `routes/admin-grading.ts:3141,3188`) and re-prompted **centrally** in the client
  (`lib/edge-fetch.ts:131-140` catches the refusal, prompts, mints a fresh token, retries).
  A page with no step-up code is not a page without step-up.
- Every privileged grading action writes an `auditLog` entry
  (`routes/admin-grading.ts:3173`).
- Adjusting a grade requires reviewer notes server-side (`admin-grading.ts:3199`), and
  disputes require resolution notes (`disputes.tsx:516`) and a rejection reason
  (`disputes.tsx:583`) client-side.
- GDPR export and erasure use type-the-phrase confirmation — the operator must type
  `EXPORT USER DATA` / `ERASE USER DATA` (`compliance.tsx:93-98,512-571`) and the phrase is
  re-sent in the request body. This is the strongest confirm pattern in the product.
- `fraud.tsx` is read-only. `users.tsx` only selects and hands ids to `/admin/bulk`. Neither
  needs a confirm dialog.

### The human-review claim lock is bypassable, and one page doesn't implement it
- **P1** `/admin/grading` ("Review Queue") and `/admin/reviews` ("Reviews") are two pages
  driving the **same** endpoints. Both call `approve`, `adjust` and `send-back` on
  `/api/admin/grading/review/:id`. Only `grading.tsx` also calls `claim` and `release`
  (`grading.tsx:295,352`); `reviews.tsx` has no claim step at all.
- The server does not enforce the lock either: `POST /review/:id/approve`
  (`admin-grading.ts:3140-3178`) loads the report and finalizes it without checking who, if
  anyone, holds the claim.
- So two operators can open the same flagged report — one from each page — and both approve
  it. `finalizeGradeReview` reports `alreadyFinal`, so the grade itself is safe, but each
  approval inserts its own `human_reviews` row (`admin-grading.ts:3155`), attributing one
  decision to two reviewers in the exact table the adjust endpoint feeds as the
  self-improvement dataset.
- Fix is either: enforce the claim server-side (409 when another reviewer holds it), or
  merge the two pages. Both are worth doing; the merge also resolves the B11 duplicate-name
  finding for this pair.

### Two full implementations of the same operator decision
- **P2** Beyond the lock, `grading.tsx` (1,360 lines) and `reviews.tsx` (1,029 lines) are two
  independent UIs over one workflow. The grading domain contract — factor weights, the
  three-rounding-sites lockstep, confidence caps — now has to be honoured in two client
  code paths that can drift apart silently.

---

## B13 — Admin growth (10) + content (9) + the ops cluster

### On failure, the admin tree tells the operator there is no data
- **P2, and the largest consistency gap in the review.** Across all **88** admin, growth and
  content pages, **zero** use the shared `ErrorState` component, and only **26 of 88** read
  `isError` at all. For comparison, 22 customer-facing pages use `ErrorState`.
- The consequence is concrete, not theoretical. `admin/growth/quests.tsx:427-441` renders
  `isLoading ? skeleton : quests.length === 0 ? EmptyState : table`. When the query **fails**,
  `isLoading` is false and the list is empty, so the operator is shown:
  *"No quests yet — Create one to give sellers a reason to come back this week."* An operator
  who believes that could create duplicate quests, or conclude a live program is empty.
- This is the same failure-reads-as-empty defect the customer-facing app has been fixing
  story by story (US-1636 on the dashboard, US-2026 on buyer wants, US-1131 on the verified
  directory, US-1631 on billing). The admin tree never got that pass.
- Only `admin/growth/buyer.tsx:170` handles `isError` in the entire growth + content tree
  (19 pages).

### Content editors can lose unsaved work
- **P2** Neither `content/blog-editor.tsx` nor `content/social-editor.tsx` uses
  `useNavigationGuard`. Body HTML is on a debounced autosave loop, but title, slug and meta
  fields "save on Save click" (`blog-editor.tsx:172`), so navigating away silently discards
  them. `new-submission.tsx:239` guards exactly this case for photos.

### Verified clean in this batch
- Growth and content use `PageHeader` consistently — 19 of 19, zero hand-rolled `<h1>`. The
  15 hand-rolled headers counted in B11 are all in the top-level admin tree.
- `blog-editor.tsx:276-286` confirms before publishing, and both editors debounce-autosave
  the body and cancel the pending timer on an explicit Save so the two can't race.

### The ops cluster
- Covered structurally in B11 (ten destinations answering "is it healthy"). No additional
  page-level defects found; the finding remains consolidation, not correctness.

---

## B14 — iOS part 1 (shell, auth, onboarding, paywall, dashboard, capture, AI extract, details)

### iOS navigation, for the record
5 tabs — Home, Inventory, **Add**, Money, Marketplaces (`ContentView.swift:1050-1109`), plus
Settings and a Tools hub of 13 destinations (`Tools/ToolsHubView.swift:95-207`): AutoLister,
Grades, Scheduled Drops, Templates, Consignors, Sources, Repricing, Automations, Community
Insights, Reconciliation, Reconcile Intake, Referrals, Verified.

### Hard IAP catalogue data (feeds the B18 parity matrix)
From `GradeThread.storekit` and `Billing/IAPProduct.swift`, iOS sells:
- Seller subscriptions: **starter, pro, business** — monthly *and* yearly. Matches
  `FLIPDESK_PLANS` exactly.
- Credit packs: **10, 25, 50, 100**. Matches the web `CREDIT_PACKS`.
- Grade tiers standard/premium/express exist with the same 1/3/5 credit costs
  (`Grading/GradeFactors.swift:59-90`), so per-grade purchasing reaches parity through
  credits rather than a one-off Stripe charge — correct for the App Store.
- **Not sold on iOS: buyer plans (Guard, Connoisseur).** There is no buyer product in the
  catalogue and no buyer surface anywhere in the iOS app.

### The two onboardings don't share a taxonomy, and iOS never persists the answer
- **P2** Web onboarding writes `users.use_case` as one of `seller | buyer | consignment |
  developer`, and the web dashboard personalises quick actions, feature cards and the
  first-run CTA from it (`dashboard.tsx:126-261`). iOS asks a different question with three
  non-overlapping answers — `reseller | grader | store`
  (`Onboarding/OnboardingState.swift:14-20`) — and sends the result **only to telemetry**
  (`OnboardingView.swift:183`). It never writes the shared column.
- Consequence: a seller who onboards on iOS and later opens the web app has
  `use_case = null` and lands on the generic default dashboard forever, having already
  answered the question once.

### Error presentation is a minority pattern on iOS too
- **P2** 19 of 69 iOS views use the shared `ErrorStateView`. Better than the admin tree
  (0 of 88) but the same underlying inconsistency.
- **P3** `AIExtract/AIExtractView.swift` has zero `accessibilityLabel` calls, against 11 in
  `ContentView` and 6 in `PhotoIntakeView`.

### Verified clean — and in two places iOS is ahead of web
- `Billing/PaywallView.swift` is the best-built purchase surface in the product: Ask to Buy /
  SCA deferral (`:84-91`), charged-but-grant-lagging reassurance (`:95-102`), the
  `ACTIVE_STRIPE_SUBSCRIPTION` 409 routed to web billing instead of a bare error
  (`:105-116`), and Restore Purchases that reports what it actually did (`:119-126`).
- **iOS login shows a persistent inline error** bound to `authStore.lastError` with a resend
  action for unconfirmed email (`Auth/LoginView.swift:92-106`). Web login shows the same
  failure as a **fading toast** (B08 finding). Fix web to match iOS.
- **iOS capture and details intake both offer draft resume and an explicit discard
  confirmation** (US-646 — `PhotoIntakeView.swift:140-226`,
  `DetailsIntakeView.swift:103-118`). The web FlipDesk intake has **neither** (B03 finding).
  Fix web to match iOS.

---

## B15 — iOS part 2 (inventory, item canvas, photos, autolister, drafts, marketplaces, listing kit, measure)

### Shopify can be connected on web but not on iOS
- **P2** `Marketplaces/MarketplacesView.swift:176` states it outright: "Shopify is web-only,
  and is the sole `.api` entry in `phasedChannels`". The web Marketplaces page renders a
  `ShopifySetup` card (`marketplaces.tsx:1413`). A subscriber paying the same price on iOS
  cannot connect a Shopify store. This is a concrete same-price-different-capability gap and
  belongs in the B18 matrix.
- iOS marketplace coverage otherwise: eBay live with multi-store support (US-671), the
  extension queue section showing work this phone handed to the desktop (US-2481), and
  Poshmark / Mercari / Depop / Grailed presented as extension-only or coming soon — matching
  web's honest treatment.

### Photo and measurement surfaces have no accessibility labels
- **P2** `Inventory/ItemCanvas/Photos/PhotoManagerView.swift` (505 lines, drag-to-reorder
  photo management), `Marketplaces/ListingKit/ListingKitView.swift` and
  `Measure/MeasurementPhotoEditorView.swift` each contain **zero** `accessibilityLabel`
  calls. Drag-reorder with no labels is unusable with VoiceOver, and these are the screens
  where a seller does the most repetitive work.

### iOS search is local; web search is server-side
- **P3** `Inventory/GlobalSearchView.swift:61-72` computes results synchronously over the
  synced SwiftData store — no network call, so there is no error state to miss (unlike the
  web equivalent, which swallows RPC failures into "No matches", B03). The trade-off is that
  a partially-synced device silently searches less than the full account, and the UI never
  says so.
- **P3** iOS search offers recent-search suggestions (US-1053, `GlobalSearchView.swift:25`).
  The web search page has none — confirms the B03 gap and shows the pattern already exists.

### Verified clean — and two more places iOS leads
- `ItemCanvasView.swift` edits eBay category + item specifics **inline** with a single Save
  that commits the item and the specifics together, and arms the back-swipe guard off both
  models (`:41-53, :954-966`). This is exactly the lesson the web side learned when it
  consolidated onto one editor (`item.tsx:226-230`); iOS already had it.
- **AutoLister is better factored on iOS.** Four focused files totalling 2,130 lines
  (`AutoListerView` 987, `AutoListerQueueView` 329, `DraftsLibraryView` 488,
  `DraftsBulkEditView` 326) against web's single 3,750-line component with 64 hooks (B04).
  The iOS split is a working template for the web refactor.

---

## B16 — iOS part 3 (money, pricing, analytics, scout, prospect, consignment, sales, fulfillment, support, team, tools, widget, share extension)

### Two more capability gaps confirmed
- **P2 Workspace 2FA policy is web-only.** The web Team page carries an owner-only
  `WorkspaceMfaPolicyCard` that sets the minimum role required to have 2FA, enforced
  server-side (`team.tsx:449,600-716`). `Team/TeamView.swift` has invites, role changes and
  member removal but no MFA policy control at all. An owner running the business from an
  iPhone cannot see or set their workspace's 2FA requirement.
- **P2 Return-reduction analytics is web-only.** Web has a dedicated analytics tab
  (`/dashboard/flipdesk/analytics/returns`). A grep for return-rate analytics across the
  whole iOS tree returns nothing. iOS does have grading-ROI and sell-through
  (`Analytics/AnalyticsMetrics.swift`), so this is a missing section, not a missing area.

### Confirmed at parity (checked, so nobody re-opens them)
- **Expenses**: iOS has the full expense flow with an offline queue
  (`Money/ExpenseFormSheet.swift`, US-981/982) — matches the web Money → Expenses view.
- **Community Insights**: `Insights/CommunityBenchmarks.swift:8` is an explicit twin of the
  web `community-recommendations.ts`, driving the same `community_benchmarks` RPC.
- **Barcode / UPC scanning**: both platforms (`Capture/BarcodeScanView.swift`,
  `components/flipdesk/barcode-scanner-dialog.tsx`).
- **Offline intake queue**: both platforms (`hooks/use-offline-intake.ts` on web).
- **Radar** is on both — the web `radar.tsx` is *not* orphaned, it is a tab of the Sourcing
  host (`sourcing.tsx:29-36,81`). Web Sourcing has six tabs (ScoutAI, Buy decision, Radar,
  My stores, Sources, Buyer demand); "My stores" needs a targeted check in B18.
- **Support tickets**: neither platform supports attachments, so the B02 finding is
  cross-platform, not a gap. iOS does add pull-to-refresh
  (`Support/SupportTicketsView.swift:108,339`) which web lacks.

### iOS-only capabilities web has no answer to
- **Home-screen widget** (`GradeThreadWidget/GradeThreadWidget.swift`, WidgetKit snapshot
  timeline).
- **Share extension** (`ShareExtension/ShareViewController.swift`) — send a photo from any
  app straight into intake.
- **AI plain-language analytics narrative** — "Get a plain-language read on this period's
  profit, ROI and sell-through" (`Analytics/AnalyticsView.swift:305-307`). Web analytics has
  charts and CSV export but no narrative summary.
- **Live Capture** device-attested photos, which `new-submission.tsx:1354-1371` explicitly
  tells web users they must install the app to get.

---

# B17 — SYNTHESIS: what the whole review says

## A. Five systemic patterns (each is one sweep, not N page fixes)

**A1. Failure reads as "you have no data."** The single most repeated defect.
- 0 of 88 admin pages use `ErrorState`; only 26 of 88 read `isError` (B13). Proven case:
  a failed load on Quests renders "No quests yet — create one" (`quests.tsx:427-441`).
- 7 buyer pages use `window.location.reload()` as their retry (B06).
- FlipDesk search swallows the RPC error into "No matches" (B03).
- 19 of 69 iOS views use `ErrorStateView` (B14).
- The customer app has been fixing this one story at a time (US-1636, US-2026, US-1131,
  US-1631). It needs a sweep, not another individual story.

**A2. Duplicate destinations for one job.**
- 5 account pages are routed twice — as a hub tab and standalone (B02). The sidebar
  correctly uses only the hub, but **12 in-app links still point at the standalone routes**,
  where the page renders with no tabs and no way back into Account.
- 6 admin nav pairs whose names don't distinguish them (B11).
- `/admin/grading` and `/admin/reviews` drive the *same* endpoints, and one skips the claim
  lock — the P1 (B12).
- Grade tier is chosen twice in one wizard, two steps apart (B01).

**A3. Long pages with no structure.** `item.tsx` 12 stacked panels, `settings.tsx` 14 cards,
`rewards.tsx` 9, `referrals.tsx` 8, `verified.tsx` 7, `marketplaces.tsx` 8 prose sections,
the dashboard's 14 blocks with the user's own data last. None of these need new features;
they need tabs or sections.

**A4. God components.** web AutoLister 3,750 lines / 64 hooks, bulk-edit 1,800, queue 1,000,
`admin/ai-models` 2,242, iOS `ItemCanvasView` 2,762. iOS AutoLister proves the split works
(4 files, 2,130 lines total).

**A5. House UI floor.** 106 `uppercase tracking-*` eyebrows; ~23 pages hand-roll an `<h1>`
instead of `PageHeader` (15 admin + 8 customer-facing); 3 logo `<img>` tags with no
width/height. Gradients are effectively absent (2 uses) — that tell is already handled.

## B. Missing surfaces — things that do not exist anywhere

**B1. CORRECTED (US-2510, 2026-08-14) — this finding was WRONG.** I claimed no
customer-facing notification centre existed, on the strength of grepping for
`NotificationBell` and `useNotifications`. It is called `NotificationCenter`, it lives
at `src/components/dashboard/notification-center.tsx`, and it has been mounted in the
SELLER header (`components/dashboard/header.tsx:67`) with unread counts, mark-read and
mark-all-read. The `notifications` table, its RLS, its type enum and a `notifyUser()`
helper with 26 callers all predate the review too.

What was ACTUALLY missing, verified:
  1. the BUYER shell had no notification affordance at all — fixed in US-2510;
  2. ~~offers, returns and cancellations never EMIT a notification~~ **ALSO WRONG**
     (US-2556, verified). US-1055 shipped the whole thing:
     `lib/marketplace-event-notify.ts` emits all four types to in-app + email + push
     from its own cron (`POST /api/jobs/marketplace-events`), deduped by a
     claim-before-deliver row in `marketplace_event_notifications`, with 19 passing
     tests including one named "re-polling identical data fires NO new
     notifications". My grep missed it because the types are built inside a
     `NotifyInput` rather than written as inline literals at a `notifyUser(` site;
  3. iOS has no tab-bar badge — the ONLY real gap here, carried by US-2557.

**Both errors in this area had one cause: I grepped for a SHAPE (a component name, an
inline literal at a call site) instead of for the capability.** The B04 finding
"nothing badges the sidebar or the dashboard" was right about the SIDEBAR and wrong
about the product having no notification pipeline.
The reviewable lesson: grep for the CAPABILITY, not for the name you expect it to have. Everything time-sensitive
is invisible unless you happen to open the right page:
- a buyer message awaiting reply (`offers.tsx:607` counts them, on that page only)
- an open return or cancellation request (`post-sale.tsx`)
- a support agent's reply (`support-tickets.tsx` never even refetches)
- a grade finishing, or coming back as needs_photos
- a buyer alert match
- a failed publish or a stuck offer
This is the biggest single addition the product is missing.

**B2. No in-app invoice/receipt history.** Every receipt path is "open the Stripe portal"
(`billing.tsx:683-690`).

**B3. No cost preview before a bulk grading batch.** Single submissions get a full payment
summary; submitting 80 rows gets none (B01).

**B4. No consignor statement.** Consignment has no per-consignor PDF/CSV to send the person
whose goods you sold (B05).

**B5. No lightbox on submission-detail photos** — the evidence behind a grade can't be
enlarged on the seller's own page (B01), though the public certificate has one.

## C. Consolidation candidates, ranked by payoff

1. **Admin ops: 10 destinations → 1 tabbed console.** Reliability, System, Jobs & Queues,
   Mission Control, Activity Feed, System Health, Background Jobs, Dead Letters, Runbooks,
   Maintenance.
2. **Merge `/admin/grading` + `/admin/reviews`** — resolves the P1 claim-lock bypass and one
   duplicate-name pair at once.
3. **Redirect the 5 standalone account routes into the hub** and repoint the 12 in-app links.
4. **Admin rewards (5) → 1, newsletter (4) → 1, AI (4) → 1, abuse (3) → 1.**
5. **Split web AutoLister** along the iOS seam.
6. **Give `item.tsx` tabs** (Details / Listing / Grade / Money) and dedupe its 4 queries
   against the same `listings` row.

## D. Highest-value quick wins

- The `/condition-index` footer link 404s on **every public page** (B09). One route.
- No buy button anywhere on `/pricing` (B09).
- Bulk upload's paywall names two plans that don't exist (B01).
- Free tools blame the user's photo when they hit a rate limit (B10).
- Buyer plan cancellation has no confirmation dialog (B06).
- Password fields have no show/hide toggle (4 fields, B08).
- Auth pages have no `<SEO>` at all (5 pages, B08).

---

# B18 — PARITY: does the same subscription buy the same thing on iOS?

## The short answer
**For the seller product: yes, almost exactly.** For the **buyer tools bundled into every
seller plan: no — none of them are reachable on iOS.**

## What the subscriber is paying for
`SELLER_PLAN_BUYER_TIER` bundles a paid buyer tier into every FlipDesk plan
(`constants.ts`, and the pricing page states it: "Every FlipDesk plan includes buyer tools"):

| FlipDesk plan | Price/mo | Bundled buyer tier | Standalone value |
|---|---|---|---|
| Starter | $29 | Guard | $8/mo |
| Pro | $59 | Guard | $8/mo |
| Business | $99 | **Connoisseur** | **$19/mo** |

Guard includes unlimited extension second-opinions, discrepancy + price-fairness scoring,
25 hourly condition alerts, fit prediction, 3 authenticity + 2 video-grade credits a month,
the standard purchase guarantee and a 200-item closet. Connoisseur adds unlimited instant
alerts, 15 authenticity + 10 video-grade credits, the Plus guarantee, the Graded-Wanted
demand board, an unlimited closet and priority support.

**On iOS, zero of these exist.** A targeted grep for every gate flag — `conditionAlert`,
`fitPrediction`, `videoGrad`, `portfolio`, `trustScore`, `purchaseGuarantee`, `demandBoard` —
returns nothing across the entire Swift tree. A Business subscriber paying $99 on their
iPhone is paying for $19/mo of Connoisseur tools they cannot open.
Some of it is inherently desktop (the browser extension second-opinion). Most of it is not:
alerts, fit prediction, authenticity credits, the closet, the guarantee, the demand board
and the trust score are all ordinary app screens that simply were never built.

## Confirmed capability gaps (web has it, iOS does not)
| # | Capability | Evidence | Severity |
|---|---|---|---|
| 1 | **Entire buyer product** — plans not sellable, no buyer screen exists | grep of all gate flags across `ios/**` returns nothing | **P1** |
| 2 | **Walk-around video grading** | web `new-submission.tsx:217,574`; no video capture anywhere in iOS | **P1** |
| 3 | **Shopify connection** | `MarketplacesView.swift:176` "Shopify is web-only" | P2 |
| 4 | **Workspace 2FA policy** | web `team.tsx:449,600-716`; absent from `Team/TeamView.swift` | P2 |
| 5 | **Return-reduction analytics** | web `/analytics/returns`; no return-rate code in iOS | P2 |
| 6 | "My stores" (Radar store linking) | web `sourcing.tsx` tab; needs a final targeted check | P3 |

Gap 2 is worth calling out on its own: video grading is a *seller* feature, and it exists
only on the platform without the good camera.

## Confirmed at parity — verified, not assumed
- **Billing**: starter / pro / business, monthly **and** yearly, plus credit packs
  10/25/50/100. Exact match with `FLIPDESK_PLANS` and `CREDIT_PACKS`.
- **Grading economics**: standard/premium/express at 1/3/5 credits on both.
- Inventory, item editor (with inline eBay category + specifics), AutoLister, drafts, queue,
  bulk edit, scheduled drops, templates.
- Money: profit, expenses (with an offline queue), payout reconciliation, price suggestions.
- Pricing: repricing, rules, automations.
- Sourcing: Scout, Radar, Sources. Consignment, Sales, Fulfillment, Offers/Negotiation,
  Post-sale. Marketplaces: eBay multi-store + the extension queue.
- Support tickets, Team (minus the 2FA policy), Referrals, Verified, Community Insights,
  barcode scanning, offline intake.

## iOS-only — web has no answer
Home-screen widget · Share extension · AI plain-language analytics narrative · Live Capture
device-attested photos · pull-to-refresh on support tickets.

## Correction to B06
The B06 "P1 — buyer billing has no store-managed branch" is **withdrawn**. Buyer plans are
not sold through IAP (the `.storekit` catalogue holds only the three seller subscriptions and
four credit packs), so a store-owned buyer subscription cannot occur, and the
seller-plan-bundled case already routes to seller billing, which does show the App Store
banner (`buyer/billing.tsx:327-332`). The one-click cancel with no confirmation
(`buyer/billing.tsx:159`) stands as a P2.
