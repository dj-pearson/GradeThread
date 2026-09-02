---
title: The buyer platform — one account, two products, one entitlement rule
aliases: [buyer plan, buyer tier, Guard, Connoisseur, buyer entitlements, buyer gate flags]
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/constants.ts
  - src/lib/buyer-features.ts
  - src/lib/watchlist.ts
  - src/lib/__tests__/buyer-plan-limits-parity.test.ts
  - services/edge-functions/src/lib/buyer-plans.ts
  - services/edge-functions/src/lib/buyer-entitlements.ts
  - services/edge-functions/src/routes/buyer-profile.ts
  - services/edge-functions/src/lib/condition-alerts.ts
  - services/edge-functions/src/lib/listing-ingest.ts
  - services/edge-functions/src/lib/video-grading-cost.ts
  - services/edge-functions/src/lib/buyer-metering.ts
  - services/edge-functions/src/lib/closet-grade-link.ts
  - src/lib/buyer-conversion-claim.ts
  - src/lib/__tests__/buyer-conversion-claim.test.ts
  - src/lib/buyer-analytics.ts
  - src/lib/__tests__/buyer-analytics.test.ts
  - services/edge-functions/src/lib/buyer-analytics.ts
  - supabase/migrations/00535_ingested_listings.sql
  - supabase/migrations/00536_buyer_video_grading.sql
  - supabase/migrations/00537_buyer_growth_metrics.sql
reviewed: 2026-09-02
tags: [buyer, plans, entitlements, contract]
summary: A buyer's effective tier is the higher of their buyer subscription and the tier their seller plan already includes; the plan matrix is written twice and only a cross-boundary parity test keeps the halves honest.
---

# The buyer platform

> **Re-reviewed 2026-09-02.** Drift flagged `src/lib/constants.ts` for
> `CREATOR_AFFILIATE` (US-9212), the creator commission terms. That is a
> SELLER-side growth programme and touches no buyer plan, buyer entitlement or
> buyer surface named below. Nothing here changed.


The seller product grades garments. The buyer product sells **confidence at the
point of purchase** on top of that same objective condition data, as its own
recurring subscription. This note owns the identity and entitlement layer that
every buyer feature attaches to. The money that moves inside those features —
reward credits, guarantee claims, what a buyer's search may see — is
[[buyer-economy]], and nothing here restates it.

## One account, two products

There is no second identity. `users.account_type` (`buyer` | `seller` | `both`,
migration `00401_buyer_account_roles.sql`) branches `handle_new_user` so a
buyer-only signup provisions without the seller assumptions, and one person can
hold both products on one Supabase account and one Stripe customer.

That is why plan resolution keys on the **price id**, not on "the customer's
subscription": a customer with both a FlipDesk subscription and a buyer
subscription has two live subscriptions, and asking which one is "theirs" has no
answer.

## The entitlement rule

`resolveBuyerEntitlements` (`lib/buyer-entitlements.ts`) is the only place the
question "what does this buyer get?" is answered on the edge, and it is one rule:

> **effective tier = the HIGHER of (a) the buyer subscription, counted only while
> its status is `active` or `trialing`, and (b) the tier the account's effective
> FlipDesk plan already includes.** Free is the floor for anything unknown,
> lapsed, paused or past due.

Both halves are load-bearing. The status filter is what makes the gate **deny by
default** — a cancelled subscription cannot leave a paid capability switched on.
The seller fold-in (US-1887, `SELLER_PLAN_BUYER_TIER`) is what stops the two-sided
product from billing a seller twice for tools they were already sold: a Business
seller *is* a Connoisseur buyer without a second subscription. It reuses
`effectivePlanFor`, so a lapsed seller loses the buyer bump on exactly the same
grace window they lose seller caps on, rather than on a second timetable nobody
maintains.

Routes gate through `requireBuyerFeature(c, flag)`, which returns a 402 carrying
`product: "buyer"` and `current_plan`. The buyer plan is **personal, never
workspace-shared**, so the read is scoped to the authenticated `c.get("userId")`
and never to a workspace owner or a request-body id.

Since US-2503 the resolved payload is also **served**, at
`GET /api/buyer/entitlements` (`routes/buyer-profile.ts`). That exists because
the React app resolves this matrix client-side from the profile it already holds
(`src/hooks/use-buyer-entitlements.ts`), which is fine for one client and a trap
for two: a native client would otherwise re-implement the rule above in Swift,
and a rule implemented twice drifts. iOS reads the answer instead of deriving it.

The endpoint adds no logic — it returns `getBuyerEntitlements` verbatim. Two
properties are deliberate and worth not "fixing":

- **A read failure answers 200 with the FREE payload** (`FREE_BUYER_ENTITLEMENTS`),
  not 500. The failure direction has to be *locked*: an over-grant shows a paid
  screen to someone who is not paying, and a 500 invites a client to cache an
  optimistic unlock.
- **`no-store, private`**, so a plan change is visible on the next load and no
  shared cache can hand one buyer's entitlements to another.

## The matrix is written twice, and one test is why that is survivable

The tier matrix exists in two files by necessity — the web bundle cannot import
Deno source, and the edge should not carry marketing copy:

| | Where | Holds |
|---|---|---|
| Advertised | `BUYER_PLANS`, `src/lib/constants.ts` | prices, `features[]` copy, allowances, `gateFlags` |
| Enforced | `BUYER_PLAN_ENTITLEMENTS`, `services/edge-functions/src/lib/buyer-plans.ts` | allowances, `gateFlags` |

Comments on both files say "keep in lockstep", which is not a mechanism.
`src/lib/__tests__/buyer-plan-limits-parity.test.ts` is the mechanism: it reads
the edge file as **text** across the project boundary and compares every numeric
allowance and every advertised gate flag, per plan. A drift there is the
advertised-vs-enforced defect class — the pricing page selling a capability the
server refuses.

Two consequences for anyone editing the matrix:

- Adding a flag or an allowance means adding its name to that test's
  `BUYER_GATE_FLAGS` / `ALLOWANCES` lists too. The test enumerates; a key it does
  not name is a key it does not guard.
- Renaming a flag on one side silently un-gates the feature rather than failing to
  compile, because the two `BuyerGateFlags` interfaces are separate declarations.

## `live` is not a gate flag

`BUYER_FEATURES` (`src/lib/buyer-features.ts`) carries a `live` boolean per
feature and it answers a different question from `gateFlags`:

- `gateFlags[f]` — **does this plan unlock f?** Entitlement.
- `BUYER_FEATURES[f].live` — **has f's buyer surface shipped at all?** It mirrors
  the `/buyer/*` route table, and a route still rendering `BuyerPlaceholderPage`
  is not live.

`live: false` is what puts the "Coming soon" badge on a pricing bullet. Treating
the two as the same field is how a placeholder gets sold.

One sharp edge in that mapping: `buyerFeatureForBullet` is **first-match-wins over
the key order** of `BUYER_FEATURES`. A bullet naming two features ("3 authenticity
+ 2 video-grade credits / month") badges only on the first one that matches, so
flipping the second feature's `live` changes nothing visible. A feature that needs
its own badge needs its own bullet.

### …and `ios` is not `live` either (US-2503)

`live` answers "has this shipped **at all**". With two clients that stopped being
the same question as "has it shipped **here**", and the gap was a live
over-promise: `/pricing` says every FlipDesk plan includes buyer tools,
`SELLER_PLAN_BUYER_TIER` really does bundle them, and a phone-only subscriber
could reach none of them and was told nothing about it.

So each entry also carries `ios`, with exactly three values and no fourth:

- **`shipped`** — an iOS screen exists. Requires `iosScreen`, the Swift file's
  repo-relative path.
- **`planned`** — iOS could deliver it and has not yet. The plan screen says so
  rather than omitting the bullet.
- **`desktop-only`** — iOS *cannot* deliver it, for a reason about the capability
  rather than about effort. Requires `iosNote`, the sentence the plan screen
  shows. Only `extensionSecondOpinion` qualifies on its own merits: it is a
  browser extension that reads the page you are looking at. The four riding on it
  (`discrepancyScoring`, `priceFairness`, `fitPrediction`, `authenticityAddon`)
  are reached *through* that surface or bought against a grade on the web.

The bar for a new `desktop-only` entry is high, and it is the entry to be
suspicious of: it is the one that closes a question permanently.

Three things enforce this rather than three comments asking for care:

- `src/test/buyer-ios-delivery.test.ts` — a `shipped` claim must name a Swift
  file that **exists on disk**, and (for a `Buyer/` screen) `ContentView.swift`
  must actually route to it. Its first version only *counted* shipped entries,
  so flipping `planned` → `shipped` sailed straight through; a threshold is not
  a property.
- `src/test/buyer-ios-capability-parity.test.ts` — the Swift capability table
  (`ios/GradeThread/Buyer/BuyerEntitlements.swift`) is parsed and compared field
  by field to this registry. The list is duplicated into Swift because the plan
  screen needs it; the duplicate is *tested*, not trusted.
- The `Record<keyof BuyerGateFlags, …>` key type, which means a new gate flag
  does not compile until somebody classifies it. The default is **decide**,
  never "quietly becomes an iOS bullet".

Note the direction of the iOS entitlement read, which is the opposite of the edge
rule and catches reviewers out: the buyer screens read `saved_searches` and
`notifications` through the **buyer's own** Supabase client, so owner RLS is the
control. [[service-role-tables]]'s "every query carries `.eq(user_id)`" is about
the service-role client, which bypasses RLS.

## A gate flag is a switch; an allowance needs a *binding*

`gateFlags` gate themselves — `requireBuyerFeature` is the one call and a route
either makes it or does not. **Allowances do not.** A number in the matrix is
inert until some call site reads it and refuses, and the parity test cannot see
the difference: it compares the advertised number to the enforced number, and two
agreeing numbers that nothing reads pass it perfectly.

So the question to ask of any allowance is *where is it spent*, and the answer
takes one of three shapes:

| Allowance | Bound by |
|---|---|
| `extensionChecksPerMonth`, `authenticityCreditsPerMonth` | `withBuyerMeter` — debited per action |
| `alertFrequency` | `effectiveDigestMode` (`buyer-notify.ts`) — floors the buyer's chosen cadence |
| `activeAlertsCap` | `entitledSearchIds` (`condition-alerts.ts`) — the matching engine |
| `videoGradeCreditsPerMonth` | `debitBuyerMeter` at the clip gate (`routes/grade.ts`, US-1841) |
| `portfolioItemCap` | **nothing** — US-1824 owns it |

`activeAlertsCap` is the instructive one, because its binding could not be a
route guard. Saved searches are written **client-side straight to Supabase under
RLS** — there is no edge route between the buyer and the row, so there is nothing
for `requireBuyerFeature` to sit in front of. It was decoration for the whole of
the alerts epic for that reason.

US-1805 resolved it by moving the gate to where the thing being *sold* is
produced. A saved search is not the product; an **alert** is. So the matching
engine resolves each batch buyer's plan and evaluates only their `cap` **oldest**
active searches — oldest because that is stable across sweeps (an over-cap buyer
must not get a different arbitrary subset alerted each run) and because it keeps
the searches they have relied on longest. The buyer UI shows and respects the
same cap, but is explicitly *not* the enforcement.

Two rules fall out of that, both general:

- **Gate the outcome, not the row**, whenever the row is client-written. A client
  check on an RLS-direct write is advice, not a limit.
- **An over-cap row still gets stamped.** Skipping it without stamping
  `last_matched_at` leaves it permanently stalest, so it is re-picked at the head
  of every run — the [[ralph-learnings|US-2315]] starvation shape, re-created by
  the fix for a different problem.

## Alerts have two universes, and the second one has a ToS boundary

The matching engine's universe is **public GradeThread certificates only** — a
deliberate privacy choice (see `condition-alerts.ts`), and also almost none of
what a buyer actually shops. US-1808 added the second universe: a marketplace
listing the buyer is **looking at**, handed to the edge by the extension, graded,
and evaluated against that same buyer's saved searches.

Both universes converge on one predicate and one delivery path, on purpose:
`matchesSearch` (widened to the structural `MatchableItem` so a non-certificate
can be judged by it) and `notifyBuyer`. A second copy of the criteria logic, or a
second sender, is the bug — an ingested match would drift from a certificate
match on quiet hours, digest cadence or dedupe and nobody would notice which.

`activeAlertsCap` is re-applied here through the same `entitledSearchIds`. Skip
that and the endpoint becomes a way to get alerts on searches over the cap: the
enforcement point would have *moved*, not been added to.

**The ToS boundary is mechanical, not a promise.** Marketplace terms permit a
shopper reading a page they opened; they do not permit building a crawl. That
difference is enforced in code, in five places, because a comment saying
"buyer-initiated" is not an enforcement:

- **One listing per request.** There is no array form, so no request shape can
  express "ingest this results page".
- **A marketplace allowlist** (`INGEST_MARKETPLACE_HOSTS`) matched on **label
  boundaries**, not `endsWith` — `ebay.com.evil.example` is not eBay. Without the
  allowlist the endpoint is a general-purpose fetch-and-grade crawler.
- **The marketplace is derived from the URL**, never read from the body.
- **The listing page is never fetched.** Only the image URLs the buyer's own
  browser already loaded are retrieved, through `safeFetch`'s SSRF guard inside
  `quickGrade`. We never request or store the page's HTML.
- **A per-buyer daily row cap** (`INGEST_MAX_PER_DAY`), because the monthly
  `extensionChecksPerMonth` allowance is `-1` on both paid tiers and *unlimited
  monthly* must not read as *may be pointed at a catalogue*. Plus
  `INGEST_RETENTION_DAYS` pruning, so the table stays a buyer's recent browsing
  rather than an accumulating corpus.

Rows are private to the ingesting buyer, owner READ + DELETE under RLS and
**never owner-write** — the grade on the row is GradeThread's objective read, and
a client-writable one would make "we graded it 9.5" a number the buyer could set.

## Video grading has two payers, and the ordering is the contract

Closed by US-1841 (the gap this section used to record: both paid tiers advertised
`videoGradeCreditsPerMonth`, and no route spent it, so a Guard buyer on a free
FlipDesk plan was answered `UPGRADE_REQUIRED` for a feature their plan had sold
them).

The clip path in `routes/grade.ts` now resolves a **payer** rather than a
yes/no, through the pure `resolveVideoGradingAccess` (`lib/video-grading-cost.ts`):

| seller plan allows | buyer entitled | payer |
|---|---|---|
| yes | either | **seller** — the ordinary grade precedence |
| no | yes | **buyer** — one `video_grades` credit |
| no | no | none → 402 `UPGRADE_REQUIRED` |

**Seller wins when both apply**, and that is the whole reason the resolver exists.
A paid FlipDesk plan already covers clip grading out of its bundle, so also
spending a buyer credit would charge one account twice for one grade and drain an
allowance it never needed.

Three consequences worth keeping straight:

- **The credit is spent at the gate**, before the submission row exists, so an
  out-of-credits buyer gets the quota answer for free and leaves nothing behind.
  Everything after that point must be able to give the unit back.
- **Two refund paths, one payer identity.** `failVideoGrading` refunds within the
  request; `refund_grade` (00536) refunds a failure that happens later, and it can
  only reach `submissions.user_id`. So the debit is taken from the **workspace
  owner**, matching every other charge in that handler — splitting the payer
  between the two paths would leak a credit exactly when a grade fails.
- **`payment_status = 'buyer_credits'`**, not `'credits'`. The latter means the
  seller's `grade_credit_balance` was debited and is what `refund_grade` would try
  to hand back. `submissions.buyer_credit_source` records which pocket
  (allowance vs reward credit) paid, because the US-1800 rule is that a refund
  returns to the *same* pocket and nothing else remembers which it was.

The result lands in the portfolio, not just a submissions list:
`closet_item_id` (ownership-filtered, never refused — a foreign id is simply
ignored) carries the buyer's closet item through, and `closet-grade-link.ts`
writes the graded condition back onto it after the grade report commits.

`authenticityAddon` remains the simpler shape of the same idea
(`routes/buyer-authenticity.ts` → `withBuyerMeter`); video needs the two-half
`debitBuyerMeter` / `refundBuyerMeterSource` form only because the work it pays
for finishes in a background pipeline, long after the response.

## The way IN is a claim, not a redirect

The free public value tools — `/whats-it-worth` (US-849) and
`/tools/grade-checker` (US-1687 + the US-1751 value range) — answer "what is this
worth", which is the buyer's question as often as the seller's. US-1843 binds
them to buyer signup, and the shape of that binding is the contract:

**The anonymous result is carried, not re-derived.** `buyer-conversion-claim.ts`
parks the whole result — item, grade, tier, value range, sample size, currency —
under one localStorage key, and the buyer home claims it into a saved search or a
closet entry. Sending the visitor to `/signup?intent=buyer` and letting them
retype the item would be a redirect, not a funnel; the number they were looking at
is the entire reason they clicked.

Three rules hold it together, and each exists because the obvious shortcut breaks
something:

- **The anonymous half touches no endpoint.** Everything before signup is
  localStorage. A server-side "pending result" row would be an unauthenticated
  write, which is a second anonymous surface sitting beside the free tools' rate
  limits — those limits are the abuse control, and adding a way around them is
  not a funnel improvement.
- **Attribution is COPIED, never consumed.** The claim stamps the last-touch
  affiliate code (`storedAffiliateRefCode`, read-only) so the conversion is
  attributable end-to-end. `redeemStoredAffiliateRef` still owns the single
  redeem, at sign-in. A claim that cleared the ref on its way past would silently
  cost the affiliate the conversion they earned — and it would look like it
  worked.
- **The pressed moment leads; it does not narrow.** Save / alert / verify all
  stay offered on the claim card, because a visitor who pressed "save" and then
  wants the alert must not have to retype the item. That is what "without loss"
  means here.

The alert a claim builds is derived, not invented: brand → `brands`, the label
minus the brand as **one** keyword phrase (keywords are OR-ed substring matches,
so splitting into words widens the alert past the item that was picked), the
chosen grade → `min_grade`, the median value → `max_price_cents`. Category stays
empty — neither tool asks for one, and a guessed category narrows the alert to
nothing while looking like a working feature.

## The measurement layer names the steps, or every surface invents its own

US-1845 instrumented the funnel, and the shape of that instrumentation is the
contract, not the event list:

**One vocabulary, two halves.** `src/lib/buyer-analytics.ts` owns the ordered
funnel steps and the feature keys; `services/edge-functions/src/lib/buyer-analytics.ts`
owns the same feature keys for the actions with no browser in the loop (a metered
spend, a guarantee decision, an extension check arriving on the extension's own
token). They are separate declarations across a project boundary, so a parity
test compares them as text — the same mechanism, and for the same reason, as
[[#The matrix is written twice, and one test is why that is survivable]].

**Existing names are load-bearing.** `buyer_funnel_cta` / `_claimed` /
`_claim_dismissed` shipped with US-1843. The name builder preserves them exactly
rather than tidying them into a new scheme, because a rename orphans a series'
history and there is no way to notice that has happened.

**Activation is derived, not pressed.** It is the first feature used in a
session, so it is emitted from inside `trackBuyerFeature` — no surface has to
remember to report it, and none can report it twice.

**Exits are not steps.** `claim_dismissed` sits outside the ordered list and
indexes to -1. Put it in the order and every drop-off chart counts a dismissal as
progress.

**Prices stay out of SQL.** `buyer_growth_metrics()` (00537) returns the plan ×
interval × status mix; MRR is multiplied out on the frontend from `BUYER_PLANS`.
A third copy of the tier prices inside a migration would be a copy the parity
test cannot see, in a file that can never be corrected once applied. Yearly
subscriptions count at a twelfth, so MRR does not spike on renewal and read as
growth.

**Acquisition buckets on FIRST touch**, falling back to the earned link and then
to `direct` — the same order in `buyerAcquisitionProps()` and in the SQL. Last
touch rides along as its own property. Bucketing on last touch attributes every
buyer to whatever newsletter they most recently clicked.

**The flywheel is a correlation, reported with its sample size**, and the surface
says so in words. Two series moving together over a few weeks is a prompt to
look. A flat series returns `null`, not `0`: "not measurable" and "measured, no
relationship" are different answers.

Consent: the browser half is a no-op until the analytics cookie category is
accepted (PostHog is not even downloaded before that), so it is opt-in by
construction. The server half carries the acting user's id, which feature ran and
its outcome — never the item, listing, price or photos — and never borrows a
browser toggle to justify itself ([[extension-telemetry-consent]]).

## Related

- [[buyer-economy]] — credits, claims and buyer-facing visibility, once a buyer is entitled
- [[buyer-legal-and-privacy]] — what we hold about a buyer, and what we are allowed to say to one
- [[grade-accuracy-guarantee]] — what the guarantee flag may actually pay
- [[pricing]] — the seller tier matrix this one folds into
- [[INDEX]]
