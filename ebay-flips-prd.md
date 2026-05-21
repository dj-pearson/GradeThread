# Flips — eBay Reseller Management Platform

**Status:** Draft v1
**Owner:** Dan Pearson (Pearson Media LLC)
**Audience:** Build agent (Claude Code or equivalent)
**Last updated:** 2026-05-21

---

## 1. Context

Solo eBay reselling operation currently managed in a Google Sheets flip tracker. Inventory volume and listing complexity (measurements per category, comps, photos, status states) have outgrown the spreadsheet. Goal: a single-user web app that replaces the spreadsheet and optionally integrates with the eBay Sell APIs to push listings live and reconcile sales.

## 2. Goals

1. Replace the existing flip tracker spreadsheet with a structured data store and UI.
2. Capture all listing data (title, description, photos, measurements, condition, comps, cost basis) **before** pushing to eBay.
3. One-click publish from the app to a live eBay listing.
4. Pull orders and sales back from eBay and reconcile against inventory (status, profit).
5. Track per-item, per-source, per-category profitability for sourcing decisions.

## 3. Non-goals (v1)

- Multi-user / multi-tenant. Single seller only.
- Other marketplaces (Mercari, Poshmark, Whatnot).
- Native mobile app. Mobile-responsive web is sufficient.
- Automated sold-comp scraping. Embed Terapeak link per item instead.
- Tax / accounting software. CSV export is enough.

## 4. Tech stack (locked)

| Layer | Choice |
|---|---|
| Frontend | React + Vite + TypeScript + TailwindCSS |
| Hosting | Cloudflare Pages |
| Backend / DB | Self-hosted Supabase (Contabo, existing) |
| Edge functions | Supabase Edge Functions (Deno) |
| Storage | Supabase Storage (photos) |
| Auth | Supabase Auth (magic link, single user) |
| Secrets | Infisical |
| CI/CD | GitHub Actions → Cloudflare Pages + Supabase CLI |

No deviations without explicit approval.

## 5. Phased roadmap

### Phase 1 — Spreadsheet replacement (no eBay API)

**Features**
- Item CRUD with kanban board grouped by `status`
- Photo upload to Supabase Storage (drag-drop + mobile camera capture)
- Category-aware measurement form templates (e.g. tops: pit-to-pit, length, sleeve; pants: waist, inseam, rise)
- Cost basis, source, acquired date, location bin
- Search, filter, bulk status update
- CSV import (from existing flip tracker spreadsheet)
- CSV export

**Acceptance criteria**
- All existing spreadsheet rows imported with zero data loss
- Items can be moved between statuses via kanban drag-and-drop
- Photo upload works from iPhone Safari and desktop Chrome

### Phase 2 — eBay read integration

**Features**
- OAuth User Access Token flow with refresh
- Required `marketplace_account_deletion` webhook endpoint (eBay production requirement)
- Order sync via Fulfillment API on a 15-minute cron
- Match orders to inventory by SKU
- Auto-status transitions: `listed → sold → shipped`
- Profit calc: `sold_price - ebay_fees - shipping_cost - cost_basis`

**Acceptance criteria**
- Past 90 days of sales back-filled on first sync
- New sales reflected within 15 min
- Net profit accurate to within $0.01 of eBay payout statement

### Phase 3 — eBay write integration

**Features**
- One-time setup wizard: opt-in to business policies, create inventory location, select fulfillment/payment/return policies
- Category picker backed by Taxonomy API `getCategorySuggestions`
- Dynamic item-specifics form via `getItemAspectsForCategory`
- Image upload from Supabase Storage to eBay (pass public URLs to `inventory_item`)
- Three-step publish: `createOrReplaceInventoryItem` → `createOffer` → `publishOffer`
- Pre-flight validation surfacing missing required fields before API call

**Acceptance criteria**
- A complete app draft publishes to a live eBay listing in under 5s (excluding image transfer)
- Failed publishes surface the specific missing/invalid field
- Published listing on eBay matches app draft (title, photos, price, item specifics)

### Phase 4 — Analytics

- Profit dashboard by month, brand, category, source
- Sell-through rate by category
- Days-to-sell histogram
- Sourcing recommendations (top categories/brands by net margin)
- Year-end COGS export for taxes

## 6. Data model

```sql
-- Inventory
create table items (
  id uuid primary key default gen_random_uuid(),
  sku text unique not null,
  title text,
  brand text,
  category text,
  size text,
  condition text,
  cost_basis numeric(10,2),
  source text,                -- thrift|goodwill_auction|estate_sale|gift|other
  acquired_date date,
  location_bin text,
  notes text,
  status text not null default 'sourced',
    -- sourced|measured|photographed|comped|drafted|listed|sold|shipped|returned
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table measurements (
  item_id uuid references items(id) on delete cascade,
  key text,                   -- pit_to_pit|inseam|waist|length|sleeve|rise|...
  value_inches numeric(5,2),
  primary key (item_id, key)
);

create table photos (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references items(id) on delete cascade,
  storage_path text not null,
  display_order int not null default 0,
  is_primary boolean default false,
  created_at timestamptz default now()
);

create table comps (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references items(id) on delete cascade,
  sold_price numeric(10,2),
  sold_date date,
  source_url text,
  condition text,
  notes text
);

-- eBay state
create table ebay_listings (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references items(id) on delete cascade,
  ebay_listing_id text unique,
  offer_id text,
  inventory_item_sku text not null,
  listed_price numeric(10,2),
  listed_at timestamptz,
  views int default 0,
  watchers int default 0,
  status text                 -- draft|active|ended|sold
);

create table sales (
  id uuid primary key default gen_random_uuid(),
  ebay_order_id text unique not null,
  listing_id uuid references ebay_listings(id),
  sold_price numeric(10,2),
  ebay_fees numeric(10,2),
  shipping_collected numeric(10,2),
  shipping_cost numeric(10,2),
  buyer_username text,
  sold_at timestamptz,
  shipped_at timestamptz,
  tracking text
);

create table ebay_auth (
  id int primary key default 1, -- enforced single row
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  scopes text[]
);

create table ebay_policies (
  id text primary key,          -- eBay policy ID
  kind text,                    -- fulfillment|payment|return
  name text,
  cached_at timestamptz
);
```

All tables get RLS enabled. Single-user policy: `auth.uid() is not null`.

## 7. eBay API integration spec

### Auth
- OAuth User Access Token flow
- Scopes: `sell.inventory`, `sell.account`, `sell.fulfillment`, `sell.marketing`
- Refresh tokens valid 18 months; refresh access token via edge function cron when `expires_at - now() < 1 hour`

### Prerequisites (Phase 3 setup wizard)
1. Opt in to business policies via Account API `optInToProgram`
2. Create inventory location via `createInventoryLocation` (home address)
3. Verify at least one fulfillment, payment, and return policy exists

### Publish sequence
```
PUT  /sell/inventory/v1/inventory_item/{sku}       → product, condition, availability, images
POST /sell/inventory/v1/offer                       → sku, marketplaceId, pricingSummary,
                                                       listingPolicies, categoryId, format
POST /sell/inventory/v1/offer/{offerId}/publish     → returns listingId
```

**Note:** eBay does not expose API-created drafts in Seller Hub → Drafts. Treat the app's local `status='drafted'` as the source of truth; do not call the unpublished-offer endpoints until the user clicks publish.

### Order sync (Phase 2)
```
GET /sell/fulfillment/v1/order?filter=creationdate:[<since>..]
```
Run every 15 min via Supabase cron + edge function. Upsert into `sales` keyed on `ebay_order_id`.

### Required webhook
Endpoint: `POST /functions/v1/ebay-notifications`
- Verify HMAC signature with `EBAY_VERIFICATION_TOKEN`
- Handle `MARKETPLACE_ACCOUNT_DELETION` (log + acknowledge)
- Return 200 within 3s or eBay disables production access

## 8. Directory structure

```
flips/
├── apps/
│   └── web/                          # React + Vite
│       ├── src/
│       │   ├── components/
│       │   ├── pages/
│       │   │   ├── Inventory.tsx     # kanban view
│       │   │   ├── ItemDetail.tsx    # edit form
│       │   │   ├── Sales.tsx
│       │   │   ├── Analytics.tsx
│       │   │   └── Settings.tsx      # eBay OAuth, policies, location
│       │   └── lib/
│       │       ├── supabase.ts
│       │       └── ebay.ts
├── supabase/
│   ├── migrations/
│   └── functions/
│       ├── ebay-oauth-callback/
│       ├── ebay-publish-offer/
│       ├── ebay-sync-orders/
│       ├── ebay-notifications/
│       └── ebay-token-refresh/
└── .github/workflows/
    ├── deploy-pages.yml
    └── supabase-migrate.yml
```

## 9. Environment variables

```
# Supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# eBay
EBAY_APP_ID=
EBAY_CERT_ID=
EBAY_DEV_ID=
EBAY_RU_NAME=              # OAuth redirect URL name
EBAY_VERIFICATION_TOKEN=   # notifications endpoint
EBAY_ENVIRONMENT=production
```

All managed in Infisical, injected at build time (Cloudflare Pages) and runtime (Supabase Edge Functions).

## 10. Open questions

1. Has eBay Production API access been requested and approved, or is sandbox-only acceptable for v1?
2. Subdomain choice — `flips.dpearsonmedia.com` or something else?
3. Single Apple Sign-In, Google Sign-In, or just magic link for auth?
4. Bulk-listing flows: priority for v1 or defer to v2?

## 11. References

- eBay Inventory API: https://developer.ebay.com/api-docs/sell/inventory/overview.html
- eBay OAuth: https://developer.ebay.com/api-docs/static/oauth-tokens.html
- eBay Taxonomy (categories + item specifics): https://developer.ebay.com/api-docs/commerce/taxonomy/overview.html
- eBay Fulfillment API: https://developer.ebay.com/api-docs/sell/fulfillment/overview.html
- Marketplace account deletion notifications: https://developer.ebay.com/marketplace-account-deletion
