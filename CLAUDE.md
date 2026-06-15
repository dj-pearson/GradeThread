# GradeThread — AI-Powered Clothing Condition Grading

> **⚠️ TEMPORARY WORKFLOW OVERRIDE (pre-production sprint) — added 2026-06-04**
> Until production launch, work directly on `main`. Do NOT create feature branches or open PRs for changes. Commit straight to `main` and push to `origin/main` when work is complete. `main` is intentionally not branch-protected during this period. **Delete this block to restore the normal branch-and-PR workflow.**

SaaS for standardized, AI-powered condition grading of pre-owned clothing: sellers upload garment photos → numerical grade (1.0–10.0) + condition report + shareable certificate. Built by Pearson Media LLC. **FlipDesk** is the reseller-management surface inside it (full eBay lifecycle).

**Domain:** gradethread.com · **Repo:** github.com/dj-pearson/GradeThread

### ⚠️ DNS / routing (mixing these up = silent 404s)
- **Supabase (self-hosted):** `api.gradethread.com` — Kong; ONLY Supabase routes exist here.
- **Edge service (Deno/Hono on Coolify):** `functions.gradethread.com` — ALL Hono routes (`/api/grade/*`, `/api/payments/*`, `/api/webhooks/*`, `/api/flipdesk/*`). Hitting `/api/*` on `api.*` 404s.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript (strict), Vite 7 |
| Styling | Tailwind CSS v4, shadcn/ui (New York, Slate base) |
| State | Zustand (auth), TanStack Query (server state) |
| Routing | React Router v7 (createBrowserRouter) |
| Auth/DB/Storage | Supabase (self-hosted, PKCE) |
| Edge Functions | Deno + Hono (`services/edge-functions/`) |
| AI | Claude Vision API (Anthropic) |
| Payments | Stripe (client + server) |
| Hosting | Cloudflare Pages |
| Monitoring | Sentry (errors), PostHog (analytics) |

## Commands

```bash
npm run dev        # Dev server (localhost:5173)
npm run build      # tsc check + Vite production build
npm run lint       # ESLint
npx tsc --noEmit   # Type check only
# Edge:
cd services/edge-functions && deno run --allow-net --allow-env --allow-read src/main.ts
```

## Local Verification (CI parity — run before committing)

`npm run verify` mirrors GitHub Actions (`scripts/verify.mjs`, prints ✓/✗):
`verify:web` (eslint, tsc -b, vitest+coverage, build, npm audit) · `verify:edge` (deno lint/check/test, frozen lockfile) · `verify:db` (supabase db start+reset, needs Docker) · `verify:security` (npm audit + edge image + trivy, needs Docker) · `node scripts/verify.mjs --e2e|--all`.

- **Docker** needed for `db`/`security` lanes; if down they're skipped with a warning (turn it on before pushing migration / edge-Dockerfile changes). **gitleaks + trivy** via `scoop install gitleaks trivy`.
- **Self-hosted Supabase caveat:** the `db` lane boots a THROWAWAY local stack only to prove migrations apply on a fresh schema. It NEVER touches prod (`api.gradethread.com`). Don't `supabase link`/`db push` expecting prod — prod migrations apply via the self-hosted deploy process. `config.toml` configures only the local stack.
- **Git hooks** (auto via `prepare` → `core.hooksPath .githooks`): `pre-commit` = gitleaks; `pre-push` = `npm run verify` (bypass with `git push --no-verify`).
- **iOS:** can't build/test on Windows (Swift/xcodebuild is macOS-only); `iOS CI` on macOS runners is the safety net. Only `python3 ios/Scripts/no-ungated-print.py` runs locally.
- Hook/shell scripts pinned to LF via `.gitattributes` (a CRLF shebang breaks Git-for-Windows `sh`). Don't remove that rule.

## Key Paths

- `src/lib/{supabase,auth,stripe,constants,utils}.ts` · `src/stores/auth-store.ts` · `src/hooks/use-auth.ts` · `src/types/database.ts` · `src/routes/index.tsx`
- `src/pages/` = one file per route · `src/components/ui/` = shadcn (DO NOT hand-edit)
- Edge: `services/edge-functions/src/{main.ts, routes/, lib/}` — `lib/supabase.ts` = service-role client (bypasses RLS)
- DB: `supabase/migrations/NNNNN_*.sql` · `supabase/config.toml`

(Navigate with Glob/Grep — this list is a map, not an inventory.)

## Architecture

- **Auth:** Supabase PKCE; `onAuthStateChange` in `useAuth()` → Zustand; `handle_new_user()` trigger (SECURITY DEFINER, bypasses RLS) auto-creates profile on signup; `<ProtectedRoute>` guards, `<AuthLayout>` redirects authed users.
- **Data:** TanStack Query for server state (5-min stale, 1 retry); Supabase client direct for reads; edge functions for writes needing server logic (grading, payments, webhooks).
- **Styling:** Tailwind v4 (`@tailwindcss/vite`, no config file); brand colors as CSS vars in `src/index.css`; utilities `bg-brand-{navy,red,night,gray}`; shadcn tokens `--primary`=navy, `--accent`/`--destructive`=red; `cn()` to merge.
- **DB:** RLS on all tables (users see only own data); grade reports with `certificate_id` are public; storage `submission-images` per-user-folder RLS; `updated_at` via trigger.

## Brand

Navy `#0F3460` (primary/headers/sidebar) · Red `#E94560` (accent/CTA/destructive) · Night `#1A1A2E` (dark bg / light fg) · Soft Gray `#F5F5F5` (light bg). Font: Inter (400/500/700).

## Grading System

- Scale 1.0–10.0, half-points. Tiers: NWT 10, NWOT 9, Excellent 8, Very Good 7, Good 6, Fair 5, Poor 3–4.
- 5 factors: Fabric 30%, Structural 25%, Cosmetic 20%, Functional 15%, Odor/Cleanliness 10%.
- Confidence 0–1; **< 0.75 → human review**. Photos: front/back/label/1+ detail required; +detail2 and ≤3 defects optional.

## Conventions

- **Files:** components/pages `kebab-case.tsx`; hooks `use-*.ts`; stores `*-store.ts`; types `kebab-case.ts`; migrations `NNNNN_description.sql`.
- **Components:** named exports (`export function X()`); `@/` import alias; icons from `lucide-react` only; toasts via `sonner` (not shadcn toast); controlled inputs (no form libs); spinner = `animate-spin rounded-full border-4 border-primary border-t-transparent`.
- **DB:** UUID PKs (`gen_random_uuid()`); `created_at`/`updated_at` everywhere; enums for fixed sets; service-role client in edge for admin ops.
- **Errors:** auth fns throw → caller toasts; check `{ data, error }`; edge returns `{ error }` + HTTP status; frontend toasts user-facing errors.

### 🔒 SECURITY — tenant isolation (US-268) — MANDATORY

The edge service uses the **service-role client, which BYPASSES RLS.** Every query on a multi-tenant table (submissions, grade_reports, inventory_items, listings, sales, item_photos, marketplace_connections, api_keys, …) MUST be tenant-scoped — either `.eq("user_id", c.get("workspaceOwnerId") ?? c.get("userId"))`, or via a parent row whose ownership was already verified (see `loadListingOwned` / `assemblePublishContext` in `flipdesk-ebay.ts`). NEVER `update`/`delete`/`select`-by-`id` using an id from the request body without first confirming ownership. Regression suite: `services/edge-functions/src/tests/tenant-isolation_test.ts`.

> Per-request RLS was evaluated and deliberately rejected: many flows have no JWT to forward (Stripe/eBay webhooks, scheduled jobs, the in-process FlipDesk→grading bridge) and workspace features legitimately cross the *owner's* tenant on behalf of members. Defense = the explicit-scoping rule above **+** the regression suite, NOT edge RLS.

## FlipDesk

Reseller surface under `/dashboard/flipdesk/*`: source → catalog → measure → photograph → grade → comp → draft → list → sell → ship → reconcile. PRD: `FlipDesk_PRD_v1.docx`.

- **DB:** `00008_flipdesk_schema.sql` extends inventory_items/listings/sales + adds sources, item_photos, marketplace_connections, payout_imports, flipdesk_grading_submissions. New `item_status`: sourced, cataloged, measured, photographed, comped, drafted, archived.
- **Frontend:** `src/pages/flipdesk/{pipeline,sources,marketplaces,reconciliation}.tsx`; sidebar group in `sidebar.tsx`; constants `FLIPDESK_PIPELINE`, `FLIPDESK_SOURCE_TYPES`, `LISTING_STATUSES`, `MARKETPLACE_LABELS`.
- **Edge:** single Deno/Hono container hosts both apps; flipdesk routes `src/routes/flipdesk-*.ts` at `/api/flipdesk/*`. **eBay module (`flipdesk-ebay.ts`) is fully wired** (OAuth+refresh AES-GCM, Inventory create/offer/publish, Taxonomy cached, Browse comps, business policies). Some other flipdesk-* handlers still 501 — wire incrementally. Deploy: `services/edge-functions/COOLIFY.md` + `docker-compose.coolify.yml`.

## Storage & upload hardening (US-276)

Server uploads MUST go: `validateImageUpload()` (magic-byte sniff, not client MIME; rejects SVG/non-images; size+dimension caps) → `stripImageMetadata()` (drops EXIF/GPS) → `storage.upload()`. See `lib/upload-validation.ts` + `lib/image-metadata.ts` (wired in `grade.ts`, `api-v1.ts`).

- `submission-images` = **PRIVATE**: read only via `createSignedUrl` TTL ≤ 900s — NEVER `getPublicUrl`.
- `item-photos` = the only public bucket; seller listing imagery only (front/back/tag/detail/defect/flatlay) — never grading `label`s, receipts, or PII.
- Per-user-folder RLS `(storage.foldername(name))[1] = auth.uid()::text` on both, against `{userId}/...` paths. Path format: `{userId}/{submissionId}/{imageType}_{timestamp}.{ext}`.

## SEO / GEO (US-291..US-309)

- Indexable routes registered in `src/lib/seo/public-routes.ts` (`PUBLIC_ROUTES`). New public static page → add there AND to `src/prerender/entry-server.tsx` (a CI guard test + the prerender sync-guard fail otherwise). `dist/seo-manifest.json` is emitted from this registry by a Vite plugin.
- Static public pages prerendered at build by `scripts/prerender.mjs` (in `npm run build`) — SSR render + `<head>` from `head-builder.ts`, no headless browser. Same HTML to humans & bots; SPA mounts over via `createRoot`.
- **GOTCHA:** `react-helmet-async` v3 renders NO server-side head and injects NO client-side `<script>`. So `<SEO>` injects JSON-LD via `useEffect` (live SPA) AND the prerender builds the crawlable `<head>` from the registry + `src/lib/seo/json-ld.ts` (and strips Helmet tags leaked into the SSR body). Add structured data via `<SEO jsonLd=…>` AND mirror it in `head-builder.ts` `jsonLdForRoute()`.
- No markup for data that doesn't exist (no `SearchAction`/`aggregateRating` placeholders). Keep `index.html` prerender markers (`prerender:head:start/end`, `<!--prerender:body-->`).
- Dynamic surfaces (blog, certificates) are edge-SSR'd by Cloudflare Pages Functions in `functions/` (cert SSR = US-294). robots.txt/llms.txt/sitemap.xml/rss.xml are dynamic Pages Functions, not static files.

## Gotchas

- shadcn v4: needs `@import "tailwindcss"` in CSS before init; needs `paths` alias in ROOT `tsconfig.json` (not just `tsconfig.app.json`); `toast` deprecated → use `sonner`.
- `eslint-plugin-react-hooks` v5 for eslint 9 (v7+ needs eslint 10).
- Supabase client throws if `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` missing.

## Env vars, deploy & roadmap (read on demand — not loaded here)

- **Env vars:** `ENVIRONMENT.md` + `.env.example` (frontend) / `services/edge-functions/.env.example` (edge). Critical edge: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PORT=8787`.
- **Deploy/launch:** `DEPLOY.md` (order DB→edge→frontend + rollback) · `LAUNCH_CHECKLIST.md` (env gate, Coolify scheduled tasks, backup drill, smoke). Also `BACKUPS.md`, `ROLLBACK.md`, `INCIDENT_RESPONSE.md`, `SECURITY.md`, `MIGRATIONS.md`, `SCALING.md`, `KEY_ROTATION.md` in repo root.
- **Roadmap:** `prd.json` (Ralph format) is **~1.8 MB / 1000+ stories — NEVER read whole** (it will blow up context). Query with targeted `node -e` scripts (count, filter by id/`passes`). US-001→021 = foundation (done).
