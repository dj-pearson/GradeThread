# GradeThread — unified browser extension (US-1872 / US-1873)

**One install, role- and subscription-aware.** This folder merges the two legacy
extensions into a single MV3 extension:

- **Condition Check (buyer research)** — from `extension-condition/` (US-1755/1756).
  An independent AI condition read on eBay / Poshmark / Grailed / Mercari / Depop /
  Vinted listing pages. **Always on** — anonymous-capable, quota-capped.
- **Depth (US-2241)** — the photo cap is now the ACCOUNT's (4 anonymous, 8 paid),
  mirrored in `registry.js` from `lib/extension-gates.ts` so the gallery is
  extracted at the right depth before the request goes out; the server trims to
  the real cap regardless. Gallery dedupe now collapses one photo served at two
  sizes via a per-adapter `assetIdPattern`. Plus the doors that weren't there:
  **Alt+G**, a right-click **"Grade this image"** (the case the gallery selector
  missed), an **options page** carrying every setting and the undo for per-site
  opt-outs, and a **per-tab toolbar badge** cleared on navigation.
- **Compare tray (US-2240)** — nobody buys ONE listing; they choose between six
  of the same jacket at six prices, and every read used to be discarded on the
  way to the next candidate. Pinning stores the payload the endpoint already
  returned (no second call, no second Vision spend) into `storage.local`, capped
  at 6, oldest-out. `compare.html` renders the table with **no network call at
  all** — it is a record of reads the shopper already has, not a live re-query.
  Opened via the worker (`tabs.create`), NOT linked from the content script,
  which would require `web_accessible_resources` on every marketplace host.
- **Seller memory (US-2239)** — every read used to be a one-off. Reads now carry
  the seller's handle and the claim they made, so at 2+ reads of the same seller
  the overlay states the shopper's own pattern ("your 4 reads average 1.8 points
  below their stated condition") and the popup gets a **By seller** view.
  **Entirely on-device**: the handle is stored in `storage.local`, never attached
  to any request, and nothing is written to `reputation_events` /
  `buyer_trust_scores` (US-2148 — a seller-adverse score needs its own model and
  a human-confirmed basis, which a handful of unconfirmed reads is not).
- **A panel that fits the screen and the report (US-2622)** — the overlay caps its
  own height (in `dvh`, so a phone's URL bar can't hide the bottom), pins the
  header, and scrolls the report inside itself. Before this a long read grew
  upward past the top of the viewport, taking the close button with it: unreadable
  and undismissable by mouse. The header also carries a collapse control, and on a
  listing you OWN the panel opens as that bar alone — eBay's owner-only Revise
  controls are the tell, deliberately *not* the "Sell one like this" link every
  visitor sees (`test/own-listing.test.cjs`).
- **Flip mode (US-2238)** — the SELLER's question about the same listing. On a
  detail page, a FlipDesk account gets "Should I flip this?": the listing's own
  photos are shadow-graded, priced against condition-matched eBay comps, and
  turned into resale range / margin after fees / break-even / days-to-sell /
  buy-or-pass (`POST /api/flipdesk/scout/appraise-url`, the URL-fed twin of
  ScoutAI's `/appraise`). **Click-to-run, never automatic** — it spends a metered
  AI action, unlike the buyer read's free tier. The shadow grade is private to
  the tenant and is never written to `grade_reports` (US-620).
- **Scan mode (US-2237)** — the same six marketplaces' **search / category grids**.
  Badges each result with the seller's *claimed* condition and whether the asking
  price is high or low for that claim. **It does not grade**: no photo is fetched
  and no Vision call is made, which is why it can run automatically (default ON)
  where the detail-page read stays click-to-run.
- **Cross-listing queue (US-3048)** — the queue the seller can finally SEE.
  `drainQueue` has claimed and run server-side work every five minutes since
  US-2481 and the popup never showed a single row of it: a seller who queued six
  cross-posts from their phone in a thrift store opened the laptop to no count,
  no list, no way to start them, and no sight of the rows that expired or failed
  — which the API had been returning in `needsAttention` the whole time. The
  Selling tab now opens on a **work summary** (to end / queued / to update, each
  a jump), and the queue block lists every row with its state, its age, and, for
  anything that will never run, the reason. **Run these now** calls the same
  drain the alarm calls, for the seller who is at the machine. **Cancel is
  offered on a WAITING row only** — `DELETE /:id` would take a claimed one too,
  and that pulls the job out from under a marketplace tab halfway through a
  form. Shaping is `queue/queue-view.js`, shared with the worker and pinned by
  `test/queue-view.test.cjs`.
- **Lister (seller cross-post)** — from `extension/` (US-716). Cross-post + delist
  FlipDesk drafts from the seller's own logged-in tab. Per-marketplace status is
  the table below, which is the only place that list lives — naming the channels
  here as well is how that sentence went stale for three of them at once.
  **Unlocks only for an active paid FlipDesk account.**

Founder decision 2026-07-09: sellers doing sourcing/comping ARE buyers in the same
session — two installs and two store listings is friction. See
[[unified-extension-decision]] (agent memory) and prd.json US-1872..US-1885.

## Layout (module boundaries kept for a clean store-review narrative)

```
manifest.json        one MV3 manifest — both permission sets + all content scripts
background.js        one service worker — routes GT_CC_* + GT_LISTER_* + entitlements
registry.js          feature registry — resolves capabilities from entitlements+settings
popup.html/js/css    role-aware popup (US-1885)
onboarding.html      first-run page opened on install (US-1885 AC4)
research/            buyer overlay  (selectors.js, image-utils.js, condition-format.js,
                     scan-format.js, flip-format.js, seller-memory.js,
                     compare-tray.js, overlay-host.js, overlay-css.js,
                     marketplace.js, overlay.css)
                     overlay-host.js mounts the overlay and each scan badge in a
                     SHADOW ROOT, so a marketplace's stylesheet cannot reach them
                     (US-1884). overlay.css is the authored source; overlay-css.js
                     is GENERATED from it by
                     `node scripts/gen-extension-overlay-css.mjs` and is what the
                     shadow roots adopt — the manifest injects no document CSS.
compare.html/js/css  the side-by-side view for the pinned tray (US-2240)
queue/               cross-listing queue view model (US-3048) — pure, shared by
                     the popup and the worker, so the count on the Selling tab
                     and the rows under it are shaped by one function
lister/              seller Lister  (selectors.js, lister-guard.js, common.js, job-store.js,
                     poshmark/mercari/grailed/vinted/facebook.js)
icons/               shared icon set
test/                zero-dep node guards (run in verify:web via scripts/test-extensions.mjs)
```

## Design (redesigned 2026-09-02)

`popup.css` is a token sheet: colours by role (`--fg`, `--muted`, `--line`,
`--ok/--warn/--bad` and their soft tints), a four-step spacing scale, three
radii, and ONE elevation, which is a hairline border. The popup is 380px wide.
Toggles are drawn as switches over the same checkbox markup popup.js reads;
scores render as a conic ring (`scoreRing()` sets `--p`, the `.s-*` classes
set the colour); each marketplace has a one-letter monogram on its own hue
(`.pop-mono[data-platform]`). Button surfaces use `--cta` (#d43a53, 4.6:1
under white) rather than the brand red, which is 3.8:1 and stays for accents.
The overlay (`research/overlay.css`) and the three full pages (`compare.css`
carries the shared page tokens; `options.css` and `onboarding.html` layer on
it) use the same roles at their own scale. The dark theme is ONE block at the
end of `popup.css` (`src/test/popup-theme.test.ts`). **Theme preference (US-3055):**
System / Light / Dark on the options page, stored as `theme` (absent = System)
and applied as `data-theme` on `<html>` by `theme.js`; the overlay sets it on
its card and badge rows from `GT_CC_GET_SETTINGS`. `popup-theme.css` and
`compare-theme.css` are GENERATED from each sheet's dark block by
`node scripts/gen-extension-theme-css.mjs` (same rules under
`[data-theme="dark"]`, the base values back under `[data-theme="light"]`), and
the overlay generator appends the same for `overlay.css`; `test/theme-css.test.cjs`
fails on drift. `npx impeccable detect
extension-unified` is the check; what remains are the tool's opinions about a
popup's type scale and 11px meta text, both deliberate at 380px.

## Popup layout — what it opens on (US-1885, revised US-3048)

Three tabs, defaulted from entitlements. Inside them the order is **urgent,
then recent, then settings, then reference**, which is not where it started:

- **Reads** leads with the button. The extension's primary action had three
  doors — the overlay's own button (on the page, below the fold on most
  listings), `Alt+G`, and a right-click on a photo — and none of them was the
  toolbar icon people actually press. "Get condition read" is now the first
  control in the popup, disabled with a reason rather than hidden when the tab
  is not a supported listing.
- **Selling** opens on a skeleton until entitlements resolve, then leads with the
  work summary and the two queues that decide whether an item sells twice, then
  the edits that have not landed, then what just happened, then the machinery
  (sold-sync, scheduled checks, Poshmark sharing). The cross-listing queue is
  grouped (`groupRows`: needs you / running now / waiting); a failed or expired
  row carries **Retry** (`GT_QUEUE_RETRY`: POST the same instruction as a new
  row, then DELETE the dead one, in that order so a failed POST leaves the row
  in place), and from two rows up the card offers **Retry all**, **Clear
  failed** and **Cancel all waiting**, each one request per row over the list
  as last rendered.
- **Reads** carries a site card (host, supported/off, the real shortcut from
  `commands.getAll`), a stats strip over the local history (reads, average
  grade, average gap to the seller's claim), and the compare tray as a card.
  The channel table is reference — a seller reads it once, when they first
  cross-post to a marketplace — so it is collapsed, with its live count on the
  summary.
- The nav badge is the SUM of outstanding seller work, written once from
  `workCounts` after all three queue renders settle. It used to be whichever
  renderer finished last, so a seller with two sold items still to end and four
  failed cross-posts was shown a number that meant neither. A count nobody could
  read is never rendered as zero.

## The gate (US-1873)

`registry.js` is the single source of truth for "what may this install do?":

| capability | granted when |
|---|---|
| `research` | **always** (anonymous allowed, quota-capped server-side) |
| `autoRun`  | buyer setting (default **off** — it spends a Vision call per listing) |
| scan mode  | buyer setting (default **on** — it spends none; `scanMode !== false`) |
| `lister` / `delist` | `sellerEnabled` — an **active paid FlipDesk** plan |
| flip mode  | `sellerEnabled`, gated in BOTH the content script (render) and the background (request); the server gates again via `requireFlipdesk` |

`background.js` fetches `GET https://functions.gradethread.com/api/grading/public/entitlements`
with the signed extension token (US-1838), normalizes it through the registry, and
**refuses** `GT_LISTER_LIST` / `GT_LISTER_DELIST` when `lister` is false. **Fail-safe:**
any lookup gap or malformed response resolves to anonymous (buyer-only) — a hiccup
never unlocks seller tools. The cache is short (5 min) and a token set/clear
invalidates it, so a sign-in / upgrade / lapse takes effect without a tab reload.

## Auth / token flow

1. The buyer app mints a token: `POST /api/buyer/extension-token` (US-1838).
2. The connect page posts it to the extension via `externally_connectable`:
   `chrome.runtime.sendMessage(extId, { type: "GT_SET_TOKEN", token })`.
3. `background.js` stores it as `gtBuyerToken`, invalidates the entitlement cache,
   and re-resolves capabilities. `GT_CLEAR_TOKEN` signs out.

The popup's **Sign in** button opens `gradethread.com/connect-extension?ext=<id>`
to launch this flow. *(The `/connect-extension` frontend page is the remaining
half — it mints the token and posts `GT_SET_TOKEN` back. The extension side is
complete.)*

## Why the Lister runs in your browser at all

Recorded once, in
[`vault/60-decisions/adr-no-server-side-marketplace-automation.md`](../vault/60-decisions/adr-no-server-side-marketplace-automation.md)
(US-2476): GradeThread's servers never hold a marketplace password or session
cookie for a no-API channel, and GradeThread never solves a CAPTCHA. The ADR
also states what that costs — your desktop browser has to be open, which
US-2481's mobile queue softens rather than removes. Adding a new channel follows
[`vault/30-platform/closing-a-coverage-gap.md`](../vault/30-platform/closing-a-coverage-gap.md).

## Poshmark engagement — share, follow, send offer (US-2482)

The feature Nifty charges ~$25/month for, built the way the ADR requires: every
action is a content script click in the seller's own logged-in closet tab. No
GradeThread server performs a Poshmark action or holds a Poshmark cookie.

The safety is in `lister/engagement.js`, a pure state machine with no `chrome.*`,
no DOM and no network. That is not tidiness — engagement automation is the only
thing here that can cost a seller their closet, so the parts that stop it are
held by `test/engagement.test.cjs` and a build fails if any of them is removed:

| Control | Value |
|---|---|
| Daily share cap (default) | 5,000 |
| Daily share cap (absolute, **not raisable**) | 9,000 — below the ~9,500 sellers report as Poshmark's edge; the gap is the margin |
| Follow / offer caps | 200 / 100 default, 500 / 300 absolute |
| Pacing | randomized, floor 1,400 ms, minimum floor 800 ms — raisable, never lowerable |
| Consent | a **separate** clickwrap from the Lister one, versioned; an old acceptance stops counting |
| Human check | the run **pauses** and hands the tab back. Never solved, never outsourced, never retried around |
| Storage | `chrome.storage.local` only. GradeThread's servers see run counts at most |

The gate is checked **before every single action**, not once per run — a 5,000
share run that checked consent at the start would keep going through a
revocation, and one that checked its cap at the start would sail past it if a
second tab was sharing too. Only a **confirmed** action increments the meter: a
click that no-ops is not counted, because an optimistic meter is worse than no
meter, and the seller trusts it.

The popup shows shares used today against the cap and names share jail as what
sits on the other side. `src/pages/flipdesk/marketplaces.tsx` carries the same
statement on the web (US-2475), so it is not only visible to someone who already
opened the extension.

## Lister rollout — which channels actually run

Listing flows ship one marketplace at a time. `enabled` in `lister/selectors.js`
is the switch, and it is **not** the same question as the channel's tier in
`src/lib/constants.ts`: the tier says how a channel is reached, `enabled` says
whether the flow runs today. They used to disagree silently, which is how three
channels advertised "Connect via browser extension" while every attempt reported
"list manually for now". `MARKETPLACE_EXTENSION_FLOW` now mirrors this column and
`marketplace-mechanism.test.ts` fails the build if the two drift.

**List and delist are separate switches**, and the table says so per row. A
channel that lists but cannot end a listing is not a half-finished one — it is a
deliberate trade, disclosed to the seller before they cross-list, who then gets a
pending-delist reminder per sale instead. The popup renders these same three
states ("Enabled" / "List only" / "Coming soon") off `selectors.js` directly.

| Phase | Marketplace | List | Delist | Notes |
|---|---|---|---|---|
| 1 | Poshmark | **Enabled** | **Enabled** | Verified 2026-06-13; delist menu 2026-08-11 |
| 2 | Mercari | **Enabled** | **Enabled** | Both verified 2026-08-10/11. The React SPA rewrites field ids often — re-check after any redesign |
| 3 | Grailed | **Enabled** | **Never** | Delete is confirmed by a NATIVE browser dialog nothing in a page can answer. Permanent, not a gap |
| 4 | Vinted (US-2479) | **Enabled** | Not yet verified | List verified 2026-08-11 on vinted.com. 22 country domains; an uncovered locale reports "list manually" rather than guessing. Delist needs a probe from a live listing |
| 5 | Facebook Marketplace (US-2480) | Awaiting verification | Awaiting verification | ARIA-anchored selectors, and as of 2026-08-11 the live form's title/price/description carry NO accessible name at all — that anchoring strategy needs rethinking before this ships |

A disabled target reports a clear "list manually for now" message instead of
guessing at the form. When a flow succeeds, GradeThread writes one `listings` row
(`platform=…`, `listing_url`) so the item shows as cross-listed.

**Enabling a channel needs a human with a logged-in account** — the sell form is
behind auth everywhere, so this is the one step CI cannot do.

**The fast way (US-2484).** Open the marketplace's sell form in a browser with
this extension installed, open the popup, and click **Check selectors**. It runs
every selector for that platform's list, delist and engage flows against the
live page and hands back a report naming any misses. The report carries the
host, the selector version and per-selector verdicts — and no page content and
no full URL, because it is written to be pasted somewhere. Controls that only
appear after a click are labelled, so an untouched page still reads clean.

The manual path, for when the popup cannot reach the page (a tab that loaded
before the extension was installed) or you want to see what is being asked for:

```bash
node scripts/verify-lister-selectors.mjs --checklist mercari   # what to check
node scripts/verify-lister-selectors.mjs                       # the invariants gate
```

The gate refuses `enabled: true` with a null `lastVerified` or a `-draft`
version, so a flow cannot claim a verification that never happened. Full process:
[`vault/30-platform/closing-a-coverage-gap.md`](../vault/30-platform/closing-a-coverage-gap.md).

## Privacy posture (rewritten for the merged permission set — US-1872 AC4)

The old Lister claim "not host-permitted on gradethread.com" no longer holds once
merged. The posture is now:

> **No `cookies` permission and no access to your marketplace accounts.** Condition
> Check sends only the public listing photos already on the page to GradeThread's
> public endpoint (nothing is persisted server-side). Lister automation runs
> entirely on your device — GradeThread never receives your marketplace password or
> cookies, and records a cross-listing only from your own GradeThread session.

**Scan mode adds one flow, and it is the only one that runs without a click** —
so it is stated separately in `SUBMISSION.md` rather than folded into the above.
On a supported search page it sends the text *already printed on* up to 24 visible
result cards (title, price, stated condition) to `/api/grading/public/scan`. No
photos, no page address, no account identifier; nothing is persisted; the popup
toggle switches it off.

## Wiring for the single extension id (US-1873 AC5)

Once published, the unified extension has ONE id. Update:

- **`VITE_LISTER_EXTENSION_ID`** → the unified id (the frontend bridge
  `src/lib/lister-extension.ts` sends `GT_LISTER_LIST`/`GT_LISTER_DELIST` to it
  unchanged).
- **`EXTENSION_ALLOWED_ORIGINS`** (edge, `main.ts`) → add `chrome-extension://<id>`
  so the grade + entitlements endpoints accept its CORS origin.
- **`externally_connectable`** already trusts `*.gradethread.com`.

## Cross-browser (US-1881 / US-1882)

Chrome, Edge, **and Firefox**. The packager emits both a Chrome zip
(`-chrome.zip`) and a Firefox zip (`-firefox.zip`, gecko id
`unified@gradethread.com`). Four things make Firefox work from one codebase:

1. **API namespace** — Firefox's `chrome.*` is callback-only; only `browser.*`
   returns promises. Every script aliases `const chrome = globalThis.browser ||
   globalThis.chrome` so `await chrome.storage…` resolves in both browsers
   (callback-style `sendMessage` in the Lister content scripts was converted to
   promise form for the same reason).
2. **Background** — Chrome runs `background.js` as a service worker (via
   `importScripts`); Firefox runs it as a non-persistent **event page**. The
   `importScripts` call is guarded (`typeof importScripts === "function"`), and the
   Firefox manifest lists the deps in `background.scripts` (in load order) — the
   packager does this transform.
3. **`externally_connectable` → postMessage bridge** — Firefox doesn't support
   page→extension messaging by id. `gt-bridge.js` (a content script on
   gradethread.com) relays `window.postMessage` envelopes to the background and
   back, and drops a `data-gt-ext-bridge` DOM marker the SaaS uses to detect the
   install. The background re-checks the sender origin + entitlement on the bridge
   path exactly as it does for `externally_connectable`. The frontend
   (`src/lib/lister-extension.ts`) picks the transport automatically: Chromium uses
   `externally_connectable`, Firefox uses the bridge. The packager strips
   `externally_connectable` from the Firefox manifest (AMO flags the unsupported
   key).
4. **Opt-in host permissions** — Chrome grants `host_permissions` at install;
   Firefox withholds them until the person allows each site. So a perfectly
   healthy Firefox install starts INERT: no content script runs, no promise
   rejects, no console line appears, and the only available reading is that the
   extension is broken. `host-permissions.js` is the probe (fail-open — an
   unanswerable probe means granted, so Chrome never sees a prompt for access it
   already has) and the popup is the ask: an honest block on a marketplace tab
   with no access, and a hint before **Sign in**, because the bridge in (3) is
   itself a content script and an ungranted gradethread.com makes sign-in HANG
   rather than fail. A grant reaches only the next navigation, so the flow
   reloads the tab. `permissions.request()` must be the first statement of a
   click handler (an `await` ends the gesture) and must never be called on a
   browser that already granted the permission — Chrome throws for anything not
   in `optional_permissions`. `test/host-permissions.test.cjs` pins all of it,
   including a source guard that no other shipped file may call
   `permissions.request()` directly.

## Status vs the two legacy folders

`extension/` and `extension-condition/` are deleted when the retirement gate in
**`scripts/lib/extension-retirement-gate.cjs`** opens — that is **US-1872 AC5**,
and the gate is computed there rather than described here, because five separate
copies of this paragraph all went stale at once. It has two halves:

1. **Code parity** — computed from the manifests and files: every permission,
   host, content-script reach, source file and icon size the legacy folders have,
   this folder has too. **Met today.** A child story that makes this extension
   *better* than the legacy ones was never a parity blocker.
2. **Store retirement** — the unified extension published on the Chrome Web Store
   and AMO, and both legacy listings unpublished (**US-1757 AC1**, operator-gated:
   store developer accounts + a browser for screenshots). **Still open**, and the
   real reason the folders are still here — their listings are the only shipped
   distribution, so deleting the source strands installed users on a build we
   cannot patch.

`extension-unified/test/legacy-retirement-gate.test.cjs` enforces both directions:
the folders may not be deleted early, and once the gate opens they may not be
kept. All reliability/coverage fixes land **here**.
