# GradeThread - AI-Powered Clothing Condition Grading

## Project Overview

GradeThread is a SaaS platform that provides standardized, AI-powered condition grading for pre-owned clothing. Sellers upload garment photos and receive a numerical condition grade (1.0–10.0), a detailed condition report, and a shareable certificate. Built by Pearson Media LLC.

**Domain:** gradethread.com
**Supabase:** Self-hosted at api.gradethread.com
**Edge service:** Deno/Hono on Coolify at functions.gradethread.com (separate container from Supabase — `/api/*` paths on `api.gradethread.com` are Supabase Kong and will 404 anything outside Supabase's routes; all Hono routes including `/api/grade/*`, `/api/payments/*`, `/api/webhooks/*`, `/api/flipdesk/*` are served from `functions.*`)
**Repo:** github.com/dj-pearson/GradeThread

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript (strict), Vite 7 |
| Styling | Tailwind CSS v4, shadcn/ui (New York style, Slate base) |
| State | Zustand (auth), TanStack Query (server state) |
| Routing | React Router v7 (createBrowserRouter) |
| Auth/DB/Storage | Supabase (self-hosted, PKCE flow) |
| Edge Functions | Deno + Hono (`services/edge-functions/`) |
| AI | Claude Vision API (Anthropic) |
| Payments | Stripe (client + server) |
| Hosting | Cloudflare Pages |
| Monitoring | Sentry (errors), PostHog (analytics) |

## Commands

```bash
npm run dev        # Start dev server (localhost:5173)
npm run build      # TypeScript check + Vite production build
npm run lint       # ESLint
npm run preview    # Preview production build locally
npx tsc --noEmit   # Type check only (no emit)
```

### Edge Functions (services/edge-functions/)
```bash
cd services/edge-functions
docker-compose up          # Start with Docker
deno run --allow-net --allow-env --allow-read src/main.ts  # Direct run
```

## Project Structure

```
src/
├── main.tsx                    # App entry: StrictMode, QueryClient, Router, Sentry, PostHog
├── index.css                   # Tailwind v4 + brand theme CSS variables
├── vite-env.d.ts
├── routes/
│   └── index.tsx               # All route definitions (createBrowserRouter)
├── layouts/
│   ├── root-layout.tsx         # Outlet + Toaster (sonner)
│   ├── auth-layout.tsx         # Centered card, redirects if authenticated
│   └── dashboard-layout.tsx    # Sidebar + header + scrollable main
├── pages/                      # One file per route
│   ├── landing.tsx             # Public landing page
│   ├── login.tsx               # Email/password + Google OAuth
│   ├── signup.tsx              # With email confirmation flow
│   ├── auth-callback.tsx       # OAuth redirect handler
│   ├── reset-password.tsx      # Request + update password forms
│   ├── dashboard.tsx           # Overview with stats cards
│   ├── submissions.tsx         # Submissions list
│   ├── submission-detail.tsx   # Grade report display
│   ├── settings.tsx            # Profile management
│   ├── billing.tsx             # Plan management
│   ├── api-keys.tsx            # API key management
│   ├── certificate.tsx         # Public grade certificate
│   └── not-found.tsx           # 404
├── components/
│   ├── ui/                     # shadcn/ui components (DO NOT manually edit)
│   ├── auth/
│   │   └── protected-route.tsx # Route guard: redirects to /login if unauthenticated
│   └── dashboard/
│       ├── sidebar.tsx         # Nav links with active state (brand navy bg)
│       └── header.tsx          # Plan badge + avatar dropdown
├── lib/
│   ├── supabase.ts             # Typed Supabase client (Database generic)
│   ├── auth.ts                 # Auth functions: signUp, signIn, signInWithGoogle, signOut, resetPassword
│   ├── stripe.ts               # loadStripe with publishable key
│   ├── constants.ts            # All enums, plans, grade factors, pricing
│   └── utils.ts                # cn() utility (clsx + tailwind-merge)
├── types/
│   └── database.ts             # Full DB types: 7 enums, 6 tables, Row/Insert/Update variants, Database interface
├── stores/
│   └── auth-store.ts           # Zustand: user, session, profile, isLoading
└── hooks/
    └── use-auth.ts             # Session listener + profile fetch

services/edge-functions/
├── deno.json                   # Deno config with import map
├── Dockerfile                  # Deno 1.42 container
├── docker-compose.yml
├── .env.example
└── src/
    ├── main.ts                 # Hono app with CORS, logger, routes
    ├── routes/
    │   ├── health.ts           # GET /health
    │   ├── grade.ts            # POST /submit, GET /status/:id
    │   └── webhooks.ts         # POST /stripe
    └── lib/
        └── supabase.ts         # Service-role client (bypasses RLS)

supabase/
├── config.toml                 # Auth, OAuth, site URL config
└── migrations/
    └── 00001_initial_schema.sql  # Enums, tables, indexes, triggers, RLS, storage

public/
├── logo_primary.png            # Dark text wordmark (1806×376) — canonical for in-app
├── logo_white.png              # White text wordmark (1806×376) — for dark backgrounds
├── logo_icon.png               # GT square icon (512×512)
├── logo_icon_{192,256,384,512,1024}.png  # Sized PWA icons; eBay app icon uses 512
├── logo_icon_maskable_512.png  # PWA maskable variant (no rounded corners, safe-zone)
├── logo_primary.svg            # Source SVG of dark wordmark — kept as source asset, NOT referenced
├── logo_white.svg              # Source SVG of white wordmark — kept as source asset, NOT referenced
├── logo_icon.svg               # Source SVG of icon — kept as source asset, NOT referenced
├── favicon.svg                 # Favicon (still SVG — modern best practice; no PNG fallback)
├── manifest.webmanifest        # PWA manifest — references PNG icons only
├── _redirects                  # SPA routing for Cloudflare Pages
└── _headers                    # Security headers + asset caching
```

## Architecture Decisions

### Auth Flow
- Supabase Auth with PKCE flow (secure for SPAs)
- `onAuthStateChange` listener in `useAuth()` hook syncs session globally via Zustand
- `handle_new_user()` Postgres trigger auto-creates user profile on signup
- Protected routes via `<ProtectedRoute>` component wrapping `<Outlet>`
- Guest-only routes (login/signup) via `<AuthLayout>` which redirects authenticated users

### Data Fetching
- TanStack Query for all server state (5-minute stale time, 1 retry)
- Supabase client used directly in components/hooks (no API layer needed for reads)
- Edge functions for writes requiring server-side logic (grading, payments, webhooks)

### Styling
- Tailwind v4 with `@tailwindcss/vite` plugin (no config file needed)
- Brand colors defined as CSS custom properties in `src/index.css` `:root` and `.dark`
- Available as Tailwind utilities: `bg-brand-navy`, `text-brand-red`, `bg-brand-night`, `bg-brand-gray`
- shadcn/ui semantic tokens: `--primary` = navy, `--accent` = red, `--destructive` = red
- `cn()` utility for conditional class merging

### Database
- Row Level Security (RLS) enabled on all tables
- Users can only access their own data
- Grade reports with `certificate_id` are publicly viewable
- Storage bucket `submission-images` with per-user folder RLS
- All `updated_at` columns auto-managed by trigger

## Brand

| Color | Hex | Usage |
|---|---|---|
| Deep Navy | `#0F3460` | Primary, headers, sidebar, trust indicators |
| Vibrant Red | `#E94560` | Accent, CTAs, destructive, highlights |
| Dark Night | `#1A1A2E` | Dark mode bg, light mode foreground |
| Soft Gray | `#F5F5F5` | Light mode bg |

**Font:** Inter (400 regular, 500 medium, 700 bold)

## Grading System

- **Scale:** 1.0–10.0 in half-point increments
- **Tiers:** NWT (10), NWOT (9), Excellent (8), Very Good (7), Good (6), Fair (5), Poor (3-4)
- **5 Factors:** Fabric Condition (30%), Structural Integrity (25%), Cosmetic Appearance (20%), Functional Elements (15%), Odor & Cleanliness (10%)
- **Confidence:** 0.0–1.0 score; below 0.75 triggers human review
- **Required photos:** front, back, label, 1+ detail; optional: detail 2, up to 3 defect shots

## Environment Variables

### Frontend (.env)
```
VITE_SUPABASE_URL=https://api.gradethread.com
VITE_SUPABASE_ANON_KEY=
VITE_STRIPE_PUBLISHABLE_KEY=
VITE_SENTRY_DSN=
VITE_POSTHOG_KEY=
VITE_POSTHOG_HOST=https://us.i.posthog.com
```

### Edge Functions (services/edge-functions/.env)
```
SUPABASE_URL=https://api.gradethread.com
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
PORT=8787
```

## Conventions

### File Naming
- Components: `kebab-case.tsx` (e.g., `protected-route.tsx`)
- Pages: `kebab-case.tsx` matching route segment (e.g., `submission-detail.tsx`)
- Hooks: `use-kebab-case.ts` (e.g., `use-auth.ts`)
- Stores: `kebab-case-store.ts` (e.g., `auth-store.ts`)
- Types: `kebab-case.ts` in `src/types/`
- Migrations: `NNNNN_description.sql` (e.g., `00001_initial_schema.sql`)

### Component Patterns
- Export named functions (not default exports): `export function MyComponent()`
- Use `@/` import alias for all project imports
- Icons from `lucide-react` only
- Toasts via `sonner` (not shadcn toast - deprecated in v4)
- Forms use controlled inputs with local state, not form libraries
- Loading states: spinner div with `animate-spin rounded-full border-4 border-primary border-t-transparent`

### Database Patterns
- UUIDs for all primary keys (`gen_random_uuid()`)
- `created_at` and `updated_at` timestamps on all tables
- RLS on every table - users access only their own data
- Service-role client in edge functions for admin operations
- Enum types for all fixed value sets
- **SECURITY (US-268): the edge service uses the service-role client, which BYPASSES RLS.** Every query against a multi-tenant table (submissions, grade_reports, inventory_items, listings, sales, item_photos, marketplace_connections, api_keys, etc.) MUST be tenant-scoped — either `.eq("user_id", c.get("workspaceOwnerId") ?? c.get("userId"))` directly, or via a parent row whose ownership was already verified (see `loadListingOwned` / `assemblePublishContext` in flipdesk-ebay.ts). NEVER `update`/`delete`/`select`-by-`id` on these tables using an id from the request body without first confirming the caller owns it. Cross-tenant regression tests live in `services/edge-functions/src/tests/tenant-isolation_test.ts`.
  - **Per-request RLS-client — decision (US-268):** we evaluated forwarding the caller's JWT to a per-request RLS-respecting client as defense-in-depth, and deliberately kept the service-role client. Rationale: (1) many flows have no user JWT to forward — Stripe/eBay webhooks resolve the user from a verified provider payload, scheduled jobs (token refresh, repricing scans) and the in-process FlipDesk→grading bridge run unattended; (2) workspace features legitimately read/write across the *owner's* tenant on behalf of members, which RLS keyed to `auth.uid()` would block; (3) it would require threading the raw JWT through every lib helper, leaving the no-JWT paths unprotected anyway. Defense is therefore enforced by the mandatory explicit-scoping rule above **plus** the cross-tenant regression suite — not by RLS at the edge. A per-request RLS client MAY be layered onto purely user-initiated read endpoints later as additional defense-in-depth; it is not a substitute for explicit scoping.

### Error Handling
- Auth functions throw on error, callers catch and show toast
- Supabase queries check `{ data, error }` response pattern
- Edge functions return `{ error: string }` with appropriate HTTP status
- Frontend shows toast notifications for user-facing errors

## FlipDesk Module

FlipDesk is the reseller-management surface inside GradeThread. It's a section under `/dashboard/flipdesk/*` that handles the full eBay lifecycle: source → catalog → measure → photograph → grade → comp → draft → list → sell → ship → reconcile. Source-of-truth PRD: `FlipDesk_PRD_v1.docx`.

### Database
- Migration `00008_flipdesk_schema.sql` extends `inventory_items`, `listings`, `sales` and adds `sources`, `item_photos`, `marketplace_connections`, `payout_imports`, `flipdesk_grading_submissions`.
- Pipeline statuses added to `item_status`: `sourced, cataloged, measured, photographed, comped, drafted, archived`.

### Frontend
- Pages: `src/pages/flipdesk/{pipeline,sources,marketplaces,reconciliation}.tsx`.
- Sidebar group: "FlipDesk" in `src/components/dashboard/sidebar.tsx`.
- Constants: `FLIPDESK_PIPELINE`, `FLIPDESK_SOURCE_TYPES`, `LISTING_STATUSES`, `MARKETPLACE_LABELS` in `src/lib/constants.ts`.

### Edge service (consolidated; deploys to Coolify)
- Single Deno/Hono container at `services/edge-functions/` hosting BOTH GradeThread and FlipDesk endpoints.
- Coolify compose: `services/edge-functions/docker-compose.coolify.yml` with Traefik labels, healthcheck, restart policy.
- FlipDesk route modules under `services/edge-functions/src/routes/flipdesk-*.ts` mounted at `/api/flipdesk/*`.
- The **eBay module (`flipdesk-ebay.ts`) is fully wired**: OAuth + token refresh (AES-GCM), Inventory API create/offer/publish, Taxonomy category+aspects (cached), Browse comps, business policies, `assemblePublishContext`/`loadListingOwned`. Some other flipdesk-* handlers still return 501 — wire up incrementally (PRD section 15.2).
- **AutoLister** (bulk photos → AI eBay listings → publish) is being built as US-310..US-325; new edge module `flipdesk-autolister.ts`, prompt in `ai-listing.ts`, migrations 00052/00053.
- See `services/edge-functions/COOLIFY.md` for deploy instructions.

## PRD & Roadmap

The full product roadmap is in `prd.json` (Ralph AI format). 100 user stories across 11 phases:
- **US-001 → US-021:** Foundation (complete)
- **US-022 → US-025:** DB extensions for inventory + admin
- **US-026 → US-029:** Backend infrastructure
- **US-030 → US-037:** AI grading engine + submission flow
- **US-038 → US-046:** Submissions, payments, certificates, analytics
- **US-047:** Settings
- **US-048 → US-061:** Inventory management + financial tracking + reporting
- **US-062 → US-066:** Disputes + public API
- **US-067 → US-075:** Admin platform + AI refinement
- **US-076 → US-082:** Notifications + UX polish
- **US-083 → US-100:** Advanced features + final integration

## Gotchas

- shadcn v4 requires `@import "tailwindcss"` in CSS file before `npx shadcn init` will work
- shadcn v4 requires `paths` alias in root `tsconfig.json`, not just `tsconfig.app.json`
- `toast` component is deprecated in shadcn v4 — use `sonner` instead
- `eslint-plugin-react-hooks` v5 required for eslint 9 compatibility (v7+ needs eslint 10)
- Supabase client throws if `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` env vars are missing
- Storage paths use format `{userId}/{submissionId}/{imageType}_{timestamp}.{ext}`
- The `handle_new_user()` trigger runs as `SECURITY DEFINER` to bypass RLS when creating profiles

## SEO / GEO (US-291..US-309)

- **Indexable routes are registered** in `src/lib/seo/public-routes.ts` (`PUBLIC_ROUTES`). Adding a public static page means adding it there AND to `src/prerender/entry-server.tsx` — a CI guard test (`src/lib/seo/__tests__/public-routes.test.ts`) and the prerender sync-guard both fail the build otherwise. `dist/seo-manifest.json` is emitted from this registry by a Vite plugin.
- **Static public pages are prerendered at build time** by `scripts/prerender.mjs` (runs in `npm run build`). It SSR-renders each page (`entry-server.tsx`), builds the `<head>` from `head-builder.ts`, and writes `dist/<route>/index.html`. No headless browser — none is available in CI/Cloudflare builds. Same HTML to humans and bots (no cloaking); the SPA mounts over it with `createRoot`.
- **GOTCHA: `react-helmet-async` v3 renders NO head server-side and injects NO `<script>` client-side** (verified). So: (1) the `<SEO>` component injects JSON-LD via `useEffect` for the live SPA; (2) the prerender builds the crawlable `<head>` deterministically from the registry + `src/lib/seo/json-ld.ts`, and strips the inline Helmet tags the fork leaks into the SSR body. Add structured data via `<SEO jsonLd=...>`, and mirror it in `head-builder.ts` `jsonLdForRoute()` so it appears in prerendered HTML.
- **Don't mark up data that doesn't exist** (Google policy): no `SearchAction` until a real site-search endpoint exists, no `aggregateRating` placeholder until real ratings exist.
- `index.html` has `prerender:head:start`/`prerender:head:end` markers and a `<!--prerender:body-->` marker — don't remove them.
- Dynamic public surfaces (blog, certificates) are NOT prerendered; they're edge-SSR'd by Cloudflare Pages Functions in `functions/` (blog done; cert SSR = US-294). robots.txt/llms.txt/sitemap.xml/rss.xml are dynamic Pages Functions, not static files.
