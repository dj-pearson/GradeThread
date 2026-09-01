---
title: Closing a marketplace coverage gap
type: runbook
status: current
source_of_truth: vault
code_refs:
  - extension-unified/lister/selectors.js
  - extension-unified/lister/common.js
  - services/edge-functions/src/lib/cross-listing-sale.ts
  - services/edge-functions/src/lib/pending-revises.ts
  - services/edge-functions/src/lib/extension-relist.ts
  - src/lib/constants.ts
reviewed: 2026-08-11
tags: [runbook, marketplaces, extension, process]
summary: The eight steps that take a marketplace from "a label in the UI" to a channel a seller can publish and delist on, in the order that makes a half-finished one impossible to ship.
---

# Closing a marketplace coverage gap

The repeatable process for adding a marketplace. Constrained by
[[adr-no-server-side-marketplace-automation]] — if a step here ever seems to
require a stored credential or a solved CAPTCHA, the answer is that the channel
is not ready, not that the ADR needs an exception.

**The order is the point.** Every step before the tier flip exists so that a
channel cannot be advertised before it works. Doing them out of order is how a
platform ends up as `extension` in `MARKETPLACE_TIER` with a content script that
half-fills a form.

---

## Step 1 — confirm there is genuinely no write API

Before writing a selector, establish that the sanctioned path is closed. Check,
in this order:

1. A public developer portal with a **write/listing-create** endpoint. Read
   endpoints do not count — Depop and Etsy became API-tier channels because they
   publish; Whatnot did not, and modelling an undocumented API produced a
   connector where every method was `notImplemented`.
2. A partner or enterprise programme, and what it costs. Record the number.
   [[adr-poshmark-via-extension]] §2 is the worked example of a threshold test.
3. Whether the terms forbid third-party automation outright, and in what words.
   That wording feeds the disclosure copy in step 6.

If a write API exists, **stop** — this is an API-tier integration
([[marketplace-connector-contract]]), not an extension channel, and the rest of
this runbook does not apply.

## Step 2 — add versioned selectors

New entry in `extension-unified/lister/selectors.js`, mirroring the Poshmark
shape:

- `enabled: false` to start. It stays false until step 4.
- `version` and `lastVerified`. `lastVerified: null` while unverified — a date
  here is a claim that a human loaded the live form on that day.
- `hosts` — every domain a listing URL may live on. The background's
  `lister-guard.js` will not open a delist URL outside this list, so a missing
  locale silently disables delist for it.
- `login.urlPattern` — so a logged-out seller is told to log in rather than
  told the selectors broke.
- `liveListingUrlPattern` — anchored on the path, so the create-listing page we
  opened can never match itself and record the form URL as a live listing.
- `required` — **pre-interaction selectors only.** A control that appears after
  a click (a delete item inside an overflow menu) must not be in `required`, or
  the probe is unsatisfiable and the flow degrades on every run while blaming
  the marketplace. This is the US-1875 bug, and `legacy-parity.test.cjs` fails
  the build on it.

## Step 3 — probe before fill, fail loudly

The content script is a thin wrapper: ask the background for a queued job, hand
it to `GT.runJobForPlatform`. All the behaviour lives in `lister/common.js` and
is shared, so a new platform gets probe-then-fill, the login-wall rule and the
delist verification for free.

Non-negotiable behaviours, all already in `common.js`:

- **Probe first.** A missing required selector aborts with the manual-listing
  message and **names the selector version**, so a stale build is diagnosable
  from a screenshot.
- **Never half-fill.** The abort happens before any field is touched.
- **Verify a delist, never assume it.** A click that silently no-ops must report
  `unverified`, which deliberately leaves the pending-delist stamp armed. A
  false "delisted" costs the seller a double sale; a false "check this" costs
  them ten seconds.

## Step 4 — verify against the live form, then flip `enabled`

**This step needs a human with a logged-in account on the marketplace.** It
cannot be done from CI, and it cannot be inferred from the site's public HTML —
the sell form is behind auth on every channel we support.

For each required selector, load the live sell form and confirm it resolves.
Then, in one commit: fix whatever moved, bump `version`, set `lastVerified` to
the date you checked, and flip `enabled: true`.

`scripts/verify-lister-selectors.mjs` prints the checklist for a platform and
refuses to pass a platform that is `enabled: true` with `lastVerified: null`.

The fast path is the popup's **Check selectors** button (US-2484), which runs
the same selectors against the live DOM and prints a report to paste back.

> [!warning] Each flow has its OWN page, and a report from the wrong one proves nothing
> This is the single way the verification goes wrong, and it produced three
> misleading reports out of the first five (2026-08-10). `list` must be run on
> the sell form, `delist` on one of your **own live listings**, and `engage`
> (Poshmark) on your **own closet**. Run on the home page, every selector misses
> and the channel reads dead.
>
> A report from the sell form therefore verifies `list` **only**. The `delist`
> section of that same report is not evidence — and a channel enabled for
> listing without a verified delist is the oversell in Step 5, arrived at from
> the other direction. Since US-2485 the report states which page it was run on
> and names the one to open instead, so the mistake is visible in the paste
> rather than in a fix that does not work.

> [!warning] "Every required selector resolves" is not "the fill works" (2026-08-11)
> A live sweep of all five channels found two bugs that every previous report had
> called green, and both hid in the same blind spot: the probe only checks
> `required`, and `required` is deliberately small.
>
> **A field outside `required` fails in total silence.** Poshmark's `photoInput`
> was `input[type="file"][accept*="image"]` and matched **nothing** — Poshmark's
> picker lists EXTENSIONS, `accept=".mov, .mp4, .png, .jpg, .jpeg"`, which
> `*="image"` cannot match. Every Poshmark cross-post went up with zero photos
> while the probe stayed green. Its `price` was stale the same way, and worse:
> the input is not on the create page at all, it lives in a dialog opened later,
> so the fill silently no-opped on the field that decides what the seller is
> paid. **After a probe passes, check what each optional field actually did** —
> `GT.fill` returns false when it matches nothing, and since 2026-08-11 an
> unfilled price rewrites the on-page banner and returns `priceFilled: false`.
>
> **A selector list has no clause priority — document order decides.** Grailed's
> `submit` was `button[type="submit"].listItem, button[type="submit"]`. `.listItem`
> was gone, so it fell through to the bare clause, whose first match in the
> document is the **site header's search button**. `querySelector` returns the
> earliest matching ELEMENT, not a match for the earliest clause, so a broad
> fallback anywhere on the page beats a specific first clause. Scope every
> fallback to the form (`.SellForm-Form-Wrapper button[type="submit"]`). Nothing
> clicks `submit` — `runFlow` is always `autoSubmit: false` — so this cost
> nothing, but a presence probe the header can satisfy is not a presence probe.
>
> Both are the [[extension-adapter-verification]] failure in a different
> subsystem: a config cannot be checked by reading it.

> [!info] A marketplace can serve automation a blank page (Mercari, 2026-08-11)
> Driving Chrome for the sweep, every Mercari page — including the homepage —
> rendered `readyState: "complete"` with a **completely empty body**. Not a login
> wall, not a challenge, no content at all. Poshmark, Grailed, Vinted and
> Facebook all rendered normally in the same session, so it is Mercari, not the
> setup.
>
> Record that as **"could not verify"**, never as a selector failure. Reporting
> five misses from a blank page is how a working channel gets marked dead. A
> hand-run report from an ordinary browser session is the fallback, and remains
> the better evidence.

> [!danger] A native browser dialog ends the conversation (Grailed, 2026-08-11)
> Grailed's Delete opens `window.confirm` — the dialog **Chrome draws itself**,
> not an in-page modal. Nothing running in the page can answer it. It is not a
> selector problem and no timeout helps: a native dialog lives outside the
> document and BLOCKS the page's JavaScript while it is open, which is also why
> the selector probe hangs on one.
>
> The only interception is overriding `window.confirm` in the page's own world
> before the click — injecting script into the page context to defeat a deletion
> confirmation the seller is being shown, silently. Do not. The
> [[adr-no-server-side-marketplace-automation]] bright lines exist for smaller
> reasons than this.
>
> **Check for this BEFORE writing a delist flow**, not after: click the control
> by hand once and see which kind of dialog appears. A channel that confirms
> natively gets the honest fallback — `delist.enabled: false` and the US-2165
> `delist_unresolved` path, a durable marker plus one notification per sale, so
> the seller ends it themselves and keeps the sale.

## Step 5 — add the delist path

Two places, or the channel oversells:

- `EXTENSION_DELIST_PLATFORMS` in
  `services/edge-functions/src/lib/cross-listing-sale.ts`, so `delistMethodFor`
  resolves the platform to `'extension'` and never to `'unsupported'`.
- The `delist` block in the selectors entry, with its own `version`,
  `lastVerified` and `verify` signals.

`'unsupported'` is not a soft landing. Since US-2165 it stamps a durable
`delist_unresolved` marker and notifies the seller — which is correct, and is
also a support ticket per sale.

## Step 5b — add the revise path (US-9202)

An edit made in FlipDesk (price, title, description, photos) reaches eBay and
Shopify through their APIs and nothing else unless the channel has a **revise
flow**. Add one in `selectors.js` beside `delist`, with its own `enabled`,
`version` and `lastVerified`; `scripts/verify-lister-selectors.mjs` applies the
same gate (an enabled flow needs a real `lastVerified`, and only `edit` may be
required pre-interaction — the fields and `save` live on the editor the click
opens).

While the flow is off, an edit still does the right thing: the edge stamps
`listings.platform_fields.revise_pending` (`lib/pending-revises.ts`), the
Listings table and the item page read "Stale on Poshmark since <date>", the
popup counts it under "Needs updating", and the seller is offered the listing
link and "I updated it". Nothing anywhere says "applied" before the marketplace
confirms: the extension reports `applied: true` only with positive evidence
(the editor saved and the page left it, or the site's own confirmation), an
unverified run keeps the marker and bumps `attempts`, and a partial write
(some fields took, some did not) is reported as not applied naming the fields.

Flipping it on is two edits: `revise.enabled: true` plus `lastVerified` in
`selectors.js`, and `MARKETPLACE_EXTENSION_FLOWS.<channel>.revise: "live"` in
`src/lib/constants.ts`; `marketplace-mechanism.test.ts` fails the build if the
two disagree. Verify on the live editor with a real owned listing, and watch a
price change actually land before recording the date. Photos are never written
by the flow (a gallery is a file input plus a drag order; re-uploading blind
duplicates), so a photo edit always reads "by hand".

## Step 5c — add the relist path (US-9203)

Relist on eBay republishes under the existing offer. On an extension channel
it is the seller's browser **copying** the live listing into a fresh one, so
`selectors.js` carries a `relist` flow beside `delist` and `revise`: only
`copy` is required (the one control on the listing page), and `navigatesTo`
names the copy's form, which must never match `liveListingUrlPattern` or the
watch would record the form as the new listing. The server half is
`lib/extension-relist.ts`: a NEW listings row for the copy at request time and
the OLD row ended, with its marketplace removal queued through the pending-
delist queue, only once the live-URL watch reports the copy posted
(`/api/grading/public/relist-listed`). That order is what keeps sold-sync from
ever matching the stale listing while still seeing a sale of it in between.

The automation `relist` action and the bulk relist endpoint (`/bulk-relist`,
Pro-gated under `autoRelist`) queue the same job for the desktop through the
US-2481 queue (`kind: relist`), and the action log says queued until then.
`no_views_in_days` never fires on an extension row: there is no performance
sync there, and "no evidence" is not "no views".

## Step 6 — add the disclosure copy

`MARKETPLACE_DISCLOSURE` in `src/lib/constants.ts`, per US-2475. One exported
constant so web and iOS render identical wording. A unit test asserts every
`MARKETPLACE_MECHANISM` key has copy, so a platform added without disclosure
fails the build rather than shipping silent.

For an extension channel the copy must state all four facts: the marketplace's
terms restrict third-party automation; the actions run in the seller's own
browser and session; GradeThread servers never receive the password or session
cookie; the seller is responsible for the account.

## Step 7 — manifest and host allowlists

- `host_permissions` and a `content_scripts` entry in
  `extension-unified/manifest.json`.
- The same hosts in the selectors `hosts` array.
- `manifest-hosts.test.cjs` and `host-permissions.test.cjs` enforce the lockstep.

A locale not covered by host permissions must **report the manual-listing
message rather than guess** — Vinted is the live example, with ~20 country
domains where only the covered ones run.

## Step 8 — flip the tier, last

`MARKETPLACE_TIER` and `MARKETPLACE_MECHANISM` in `src/lib/constants.ts`, in the
same commit as each other. `marketplace-mechanism.test.ts` enforces the
consistency rule (`tier extension` ⇒ `mechanism extension`), so they cannot
drift.

This is the step that changes what the product **claims**, which is why it is
last. Everything above is reversible without a seller noticing; this one is not.

---

## Queueing from a phone (US-2481)

An extension channel can also be driven from mobile: the app records an
instruction in `extension_work_queue` and the desktop extension drains it the
next time the browser opens. Nothing about step 1–8 changes — the queue carries
a platform key, and a channel that is not enabled still reports "list manually"
when it drains.

Two rules the queue adds:

- **It stores WHAT to do, never a way in.** No password, no session cookie.
  Enforced in three places, each catching a different failure: a CHECK
  constraint on the table, a by-key rejection in `lib/extension-queue.ts` (so
  the 400 can name the offending key), and `extension-queue_test.ts`.
- **Queued is not done.** One sentence — `QUEUED_NOTICE` — is shared verbatim by
  the edge, the web hook, the iOS service and the Android repository. A screen
  that reads like completion for a queued **delist** tells a seller their
  listing was pulled when it is still live, which is the double sale everything
  else here is arranged to prevent.
- **Only actions that survive the seller being absent may be queued** (US-2497).
  The queue held a third verb, `share`, for a day. It could never drain: the
  Poshmark engagement pass starts only against an active tab already on the
  seller's own closet, and the extension holds no handle and will not navigate to
  a URL that arrived in a message ([[adr-no-server-side-marketplace-automation]]
  §3.1, US-1876). The deciding reason was not the missing tab, which is
  engineerable. It was the fourth statement of the engagement clickwrap — *"stop
  and hand the tab back to me if Poshmark asks for a human check"* — which cannot
  be honoured with nobody at the machine. So before adding a verb, ask what it
  promised the seller, and whether that promise holds while they are elsewhere.

## The mirror rule (while it lasts)

Until the legacy retirement gate opens (US-1872 AC5), any selector fix applied
to `extension-unified/` must be applied to `extension/` **in the same commit**.
`extension-unified/test/legacy-parity.test.cjs` fails the build on divergence.
This exists because the hand-sync already failed once, silently, for four days,
on the delist probe.

## Related

- [[adr-no-server-side-marketplace-automation]] — the constraint this process operates under
- [[adr-poshmark-via-extension]] — why the extension model at all
- [[marketplace-connector-contract]] — the API-tier equivalent of this runbook
- [[cross-listing]] — the channel-reach model
- [[INDEX]]
