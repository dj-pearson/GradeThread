# FlipDesk Cross-Listing Automation — the A→Z Map

> How FlipDesk lists to the marketplaces that have **no usable third-party listing
> API** (Poshmark, Mercari, Grailed, Vinted, Whatnot) alongside the ones that do
> (eBay ✅ wired, Shopify ✅ wired, Etsy 🟢 official API, Depop 🟡 private partner API).
>
> Backlog: stories **US-1659 → US-1684** in `prd.json` (notes tagged `[CROSSLIST]`).
> This document is the source-of-truth design; each story cites a module here.
> Companion research/strategy docs already in-repo: [`Cross_Listing.md`](Cross_Listing.md)
> (marketplace-by-marketplace API availability) and [`SYNC_SOURCE_OF_TRUTH.md`](SYNC_SOURCE_OF_TRUTH.md).

---

## 1. The core finding (why this epic is shaped the way it is)

There is **no secret API**. Every established cross-lister (Vendoo, List Perfectly,
Crosslist, PrimeLister, Flyp) reaches the API-less marketplaces the same way: a
**Chrome browser extension whose content scripts drive each marketplace's own
logged-in web UI in the user's own browser** — filling the site's real listing form
and clicking its real buttons under the user's existing session. There is no
OAuth, no REST endpoint; the "integration" is UI automation.

This splits the work into **two tiers that must not be conflated**:

| Tier | Marketplaces | Mechanism | Runs where | Ban risk |
|---|---|---|---|---|
| **API (sanctioned)** | eBay ✅, Shopify ✅, **Etsy** (Open API v3), **Depop** (private partner API, gated by `business@depop.com` approval) | Real REST/GraphQL under OAuth | Server-side edge adapters | None |
| **Extension (UI automation)** | **Poshmark, Mercari, Grailed, Vinted, Whatnot**, + Depop-fallback | Content scripts drive the site UI under the user's session | **User's own browser** (never our servers) | Medium — ToS gray area |

**Design rule #1 — user-side, never server-side.** The extension runs in the
user's browser on the user's IP under the user's own cookies, so the user is
automating their *own* account. Server-side automation with uploaded cookies is a
clear ToS escalation and a documented Poshmark detection trigger (datacenter-IP
mismatch). We store **no marketplace passwords or session cookies** on our servers.

**Design rule #2 — the adapter contract already exists.** `services/edge-functions/
src/lib/marketplace-adapters/types.ts` defines `MarketplaceAdapter`
(connect · refreshToken · publish · updateListing · delist · syncListings ·
syncOrders · mapDraftToListing). eBay/Shopify implement it; Poshmark/Mercari/Depop
are typed `notImplemented()` stubs. The API-tier work fills stubs in place. The
extension tier introduces a **new transport** (a signed job the SaaS hands to the
browser extension) but presents the *same* adapter surface to the pipeline, so
`flipdesk-listings.ts` callers don't change.

**Design rule #3 — the marketplace UI is data, not code.** Every extension recipe
resolves its fields from a **versioned selector manifest fetched from the server**,
so a Poshmark DOM change is a data deploy, not a Chrome Web Store re-release.

## 2. The legal / ban posture (baked into every extension story)

- Poshmark's **"Excessive Listing Removal" policy (eff. May 1, 2025)** bans mass
  listing removal "whether manually or through automation" and repeated
  delist/relist of the same item within 60 days, enforced by an automated ladder:
  warnings → temporary listing restrictions (~6-day) → permanent account disable.
- Its detection produces **false positives** — sellers were suspended for
  legitimately deleting items that sold elsewhere, behavior Poshmark said it would
  not penalize. So **delist/relist is the highest-risk surface**: conservative,
  user-initiated, rate-limited, 60-day-guarded (Module T).
- Anti-detection posture across the industry: run in the user's session +
  human-like throttling (randomized 1–2s+ per action) + pause on any
  CAPTCHA/challenge (Module U). We surface ban-risk signals to the user and
  operator (Module X) and can kill any recipe by feature flag (Module Z).

---

## 3. The modules, A → Z

Each is one `prd.json` story. `dependsOn` enforces the true build order; the
priority band (1200→1075, descending) just slots the whole epic below the current
sprint. Foundation (A–C) → API adapters (D–J) → extension companion (K–Z).

### Foundation
- **A · US-1659 — Capability registry + platform expansion + schema.** Extend the
  `CrossListingPlatform` union to `etsy | grailed | vinted | whatnot`; a
  capability matrix (`api` vs `extension`, and which lifecycle ops each supports);
  migration for the new `marketplace_connections` provider rows + any `listings`
  columns. Idempotent migration + `EXPECTED_SCHEMA_VERSION` bump (migrations skill).
- **B · US-1660 — Extension transport contract.** A signed, TTL'd job envelope the
  SaaS mints for the browser extension (`chrome.runtime.onMessageExternal`); an
  `extension_jobs` operator/tenant table; edge routes to enqueue/claim/report;
  every new route gets a `tenant-isolation_test.ts` case.
- **C · US-1661 — Security & session model.** Invariant tests that we never persist
  marketplace credentials/cookies server-side; per-(user, marketplace) consent +
  ToS-acceptance gate recorded before any recipe can run; tenant-scoped.

### API tier (sanctioned, server-side)
- **D · US-1662 — Etsy adapter: connect + refreshToken** (OAuth 2.0, `x-api-key`,
  Open API v3; store scopes in `marketplace_connections`).
- **E · US-1663 — Etsy publish/update/delist** (`createDraftListing` w/ `listings_w`,
  image upload, `updateListing`, delete).
- **F · US-1664 — Etsy syncListings + syncOrders + webhooks.**
- **G · US-1665 — Depop partner adapter: connect** (OAuth 2.0 + PKCE, sandbox-first,
  behind an `depop_partner_api` approval feature flag; graceful when unapproved).
- **H · US-1666 — Depop publish/update/delist** (`PUT /api/v1/products/{sku}` upsert).
- **I · US-1667 — Depop syncOrders + mark-as-shipped + webhooks.**
- **J · US-1668 — Shopify sync completion** — wire the `syncListings`/`syncOrders`
  that currently return 501.

### Extension tier (the API-less marketplaces)
- **K · US-1669 — Extension MV3 scaffold.** Manifest, host permissions, background
  service worker, options page, one-time device-token pairing to a FlipDesk account.
- **L · US-1670 — UI-driver engine.** Server-fetched selector manifest + a throttled
  fill/click/upload primitive + a per-marketplace `recipe` abstraction.
- **M · US-1671 — Poshmark recipe** (create/publish under the user's session).
- **N · US-1672 — Mercari recipe.**
- **O · US-1673 — Grailed recipe.**
- **P · US-1674 — Vinted recipe.**
- **Q · US-1675 — Depop extension fallback recipe** (for users not approved for the
  partner API).
- **R · US-1676 — Whatnot spike + capability gating** (livestream-selling
  constraints; research, gate, and stub rather than assume a form flow).
- **S · US-1677 — Sale-triggered auto-delist + sold-elsewhere sync** via extension
  polling of connected marketplaces (requires the user's browser to be open).
- **T · US-1678 — Poshmark Excessive-Listing-Removal safeguards** (60-day guard,
  delist rate-limit, user-initiated only, warnings surfaced).
- **U · US-1679 — Anti-detection & resilience** (randomized human-like delays,
  per-action caps, CAPTCHA/challenge detection → pause + notify).
- **V · US-1680 — Selector-drift maintenance harness** (versioned server manifest,
  per-recipe health checks, breakage telemetry so a UI change is a data fix).
- **W · US-1681 — Extension↔SaaS reconciliation** (report platform listing IDs/URLs
  + status/errors back into `listings` and the pipeline UI).
- **X · US-1682 — Ban-risk telemetry + operator dashboard + alerts** (per-user
  challenge/suspension signals surfaced in `/admin`).
- **Y · US-1683 — Consent / ToS / legal UX + data-handling docs** (per-marketplace
  disclosure of user responsibility + our no-credential-storage stance; acceptance
  stored, surfaced in the composer).
- **Z · US-1684 — Extension distribution & release governance** (Chrome Web Store
  listing, auto-update, per-marketplace recipe feature-flag kill switches).

---

## 4. What this epic explicitly does NOT do

- **No server-side automation of API-less marketplaces.** No uploaded-cookie
  scraping, no headless-browser-on-our-servers listing. That is the one path with
  real CFAA/ToS exposure and the highest ban rate; the whole extension tier exists
  to avoid it.
- **No dependency on a competitor's product as a backend.** Vendoo/List Perfectly/
  Crosslist expose no developer API; we build the plumbing ourselves.
- **No promise the extension won't break.** Marketplace UIs change; Module V makes
  breakage a fast data fix and Module X makes it observable, but ongoing selector
  maintenance is an accepted operating cost, not a bug.
- **No bypassing our own tenant-isolation / migration discipline.** Every new edge
  route is tenant-scoped with a test; every migration follows the US-1108 triple.
