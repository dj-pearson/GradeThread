# Extension sold-sync: two-way truth for the no-API marketplaces

Date: 2026-08-19
Status: approved design, not yet built
Epic: see prd.json (filed alongside this document)

## The problem

The Lister publishes listings out to Poshmark, Mercari, Grailed and Vinted from
the seller's own logged-in browser. Nothing comes back. There is no message type
in `extension-unified/background.js` that reads anything from a marketplace, and
no edge route that accepts marketplace state from the extension.

The consequence is the oversell that `cross-listing-sale.ts` exists to prevent.
That module is written, tested, and correct: when a garment in a cross-listing
group sells, it plans the sibling delist and refuses to auto-resolve a
simultaneous sale. For eBay and Shopify an API order triggers it. For every
extension-mechanism channel, nothing ever does. A Poshmark sale is invisible to
GradeThread until the seller marks it by hand.

Vendoo and Crosslist both lead with sold-item detection plus auto-delist. It is
the first feature a switching seller looks for.

## Scope

In scope: sold state and listing status (sold, active, removed) for the seller's
own listings on extension-mechanism channels.

Out of scope, each its own design: closet import, views and likes and listing
health, fee and payout truth, engagement automation beyond the existing Poshmark
share/follow/offer runner.

## Constraint

`vault/60-decisions/adr-no-server-side-marketplace-automation.md` governs. No
GradeThread server holds a marketplace password or session cookie for a no-API
channel, and no GradeThread code solves a CAPTCHA. US-715 additionally ruled out
server-side scraping with stored cookies on ToS, CFAA and DMCA grounds.

This design complies. All reading happens in the seller's own browser, on pages
of their own account, in the same category as the Lister and the engagement
runner that already ship under that decision. Reading the seller's own Sold page
is strictly less exposure than the writing the Lister already performs.

## Core rule: the extension observes, the server decides

The extension never concludes that something sold. It reports what it saw. The
server owns the confidence tier and every destructive action.

Two reasons this split is load-bearing:

1. A selector regression produces a bad observation, not a bad delist. The
   server's tier is what stands between a Poshmark redesign and a seller's
   catalogue being pulled off four other channels.
2. Decision logic ships with an edge deploy. Extension logic waits days for
   store review. The dangerous half belongs where it can be fixed in minutes.

## Components

| Component | Location | Responsibility |
|---|---|---|
| `sync/selectors.js` | extension | Per-platform selectors for the seller's own Sold page and active closet. Carries `version` and `lastVerified`, gated by `scripts/verify-lister-selectors.mjs` |
| `sync/observe.js` | extension | Pure. DOM-extracted rows in, normalized observations out. No `chrome.*`, no DOM API, no network, so it is unit-testable the way `lister/engagement.js` is |
| `GT_SYNC_OBSERVE` | extension background | Passive path. A content script on a page the seller opened themselves posts what is on screen |
| sync poll driver | extension background | Reuses the `drainQueue` pattern at `background.js:1248`: unfocused tab, URL allowlist guard, `chrome.alarms` sweep |
| `POST /api/flipdesk/sync/observations` | edge | Tenant-scoped batch intake |
| `lib/marketplace-observations.ts` | edge | Pure planner. Observations plus the tenant's `listings` rows produce `{ confirmed, ambiguous, unmatched }` |
| sync status projection | edge lib | One projection read by both the popup (HMAC extension token) and the SaaS (Supabase JWT), following `pending-delists.ts` |

## Data flow, confirmed sale

1. The seller's own Sold page is read, passively or by the poll.
2. Observations post to the edge and are matched by `listing_url` against
   `listings` rows scoped to the tenant.
3. A row on the Sold page carrying a price and a date against an exact URL match
   is tier `confirmed`. Write the `sales` row, mark the listing sold.
4. Hand off to the existing `cross-listings.ts` planner, which delists the
   siblings and surfaces any simultaneous sale rather than resolving it.

Ambiguous and unmatched observations write a review row and change nothing else.

## Evidence model

Two independent axes. Treating them as one is how this goes wrong.

**Axis A, sale evidence**

- `definitive`: a row on the seller's own Sold or Orders page with a price and a
  date. The platform itself is asserting the sale.
- `inferred`: a listing absent from a fully enumerated closet with no matching
  sold row. Could be sold, seller-removed, or platform-removed.

**Axis B, match evidence**

- `exact`: the row's listing URL matches a `listings.listing_url` written when
  the Lister published.
- `probable`: no URL on the row, but title, price and thumbnail match exactly
  one live listing we published on that platform.
- `none`: matches zero rows, or more than one.

**Action matrix**

| Sale | Match | Action |
|---|---|---|
| definitive | exact | Write the sale, fire the delist planner, notify |
| definitive | probable | Review queue, pre-filled, one click to confirm. No auto-delist |
| definitive | none | Unmatched counter and the Claim prompt |
| inferred | exact | Review queue: gone from the marketplace, reason unknown |
| inferred | probable or none | Dropped |

Claiming an unmatched row writes `listing_url` onto the `listings` row, so a
probable match today becomes an exact match for that item's later events. The
system gets more automatic as the seller uses it.

## Safety rules

**Absence is only evidence if the enumeration was complete.** A poll that reads
page 1 of an 8 page closet makes pages 2 through 8 look vanished. Every closet
observation carries a coverage field naming the pages enumerated and whether the
end was reached. The server refuses to treat absence as evidence on partial
coverage.

**Circuit breaker.** If one batch reports more sales than
`max(5, 20% of the tenant's live listings on that platform)`, the entire batch is
refused, routed to review, and flagged. A seller genuinely selling 15 items in an
hour is rare. A broken selector reporting 200 is what a broken page looks like.
Per-item undo does nothing against this case, which is why the breaker exists
instead of relying on undo.

**Zero rows where many were expected is an error, never a quiet success.** We
know how many listings we published to that closet. A read returning nothing sets
the channel to sync-failing, tells the seller, and writes no observations. This
is the single most likely way the feature ships broken: a fixture keeps passing
while the live page changes, and the failure mode looks like a seller who sold
out.

**Count reconciliation covers the breaker's blind spot.** The breaker catches too
many and is blind to too few. If the active closet shrank by 12 and sold-sync
explained 3, the review queue raises the gap unprompted.

**Idempotency.** The same sold row is re-read on every poll. Dedupe on the
platform order reference where one exists, otherwise on
`platform + listing_url + soldAt`. A second sighting is a no-op.

**Two hard stops, copied from the engagement runner.** A login wall means report
not-signed-in and back off, never prompt. A human check means stop and hand the
tab back.

## Trigger model

Three layers.

1. **Passive harvest.** Whenever the seller is on their own closet or Sold page
   anyway, read what is on screen. No extra traffic to the marketplace.
2. **Scheduled poll.** One unfocused background tab per channel every 30 to 60
   minutes while the browser is open, reusing the drain-queue pattern. Default
   on, with an off switch, and its own versioned clickwrap.
3. **Sync now.** Manual, from the popup and from the web.

Layer 1 covers most sellers with no automated load at all. Layer 2 is what stops
the oversell for a seller who has not opened Poshmark in three days.

## Surfaces

- **Extension popup.** One line per channel: last sync, listings seen, or
  not-signed-in, or off. Plus Sync now.
- **`src/pages/flipdesk/marketplaces.tsx`.** The same per-channel rows on the
  page that already owns connection state and the engagement risk statement.
  Carries the sync toggle and poll interval.
- **Review queue.** A tab on Marketplaces, not on `reconcile.tsx`, which owns
  payouts and fees. Three groups: needs confirming, unexplained, unmatched.
- **Notification.** Reuses `marketplace-event-notify.ts`. Names what sold, where,
  and which siblings were pulled. Naming the siblings is the point: a seller who
  disagrees needs to find out now.

## Privacy posture

This is a new claim. Today's posture states that engagement runs entirely on the
device and GradeThread's servers see run counts at most. Sold-sync changes that:
the seller's own sales data leaves the browser and reaches our server.

That is legitimate, being their data going to their own account, but it must be
stated on screen before the first sync, not only in a README. US-2472 AC5
requires exactly that.

Sent: listing URL, title, price, sale date, platform order reference.

Never sent, enforced the way `extension-queue.ts` enforces its rule, with a
constant, a CHECK constraint and a test: no cookie, no password, no session
token, and no buyer name, buyer handle or shipping address. A Poshmark order page
carries the buyer's address. The observer must never read that field and the
server must refuse the key if a future version does.

## Phasing

1. **Poshmark, passive only.** The whole spine, zero automated traffic. No new
   host permission, since `poshmark.com` is already granted. Proves the selectors
   against real sellers before automating a single page load.
2. **Mercari.** Selectors plus its pagination shape.
3. **The scheduled poll.** Separate because it is the only part with ToS
   exposure, and it gets its own consent.
4. **Grailed and Vinted.** Grailed matters beyond its volume: it can never
   delist, so a Grailed sale is the one case where the seller must act by hand,
   and sold-sync is what tells them to.

Facebook waits on US-2480, which is blocked on its own ARIA problem.

## Testing

- `sync/observe.js`: zero-dep node guards under `extension-unified/test/`, run by
  `scripts/test-extensions.mjs`. Fixtures are saved HTML with buyer details
  scrubbed before entering the repo.
- `lib/marketplace-observations.ts`: deno tests covering the full matrix, the
  coverage-incomplete refusal, the circuit breaker, the zero-rows error, count
  reconciliation, and dedupe.
- The new edge route needs a `tenant-isolation_test.ts` case (US-268).
- Extend `scripts/verify-lister-selectors.mjs` to the sync selectors rather than
  adding a second gate. It already refuses `enabled: true` with a null
  `lastVerified`.
- A source guard pinning the forbidden-key list, mirroring how `CREDENTIAL_KEYS`
  is pinned.
- Extend the popup's Check selectors probe (`lister/selector-probe.js`) to cover
  sync, so a human with a logged-in account can verify against the live page.
