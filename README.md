# GradeThread

**AI-powered condition grading for pre-owned clothing.** Sellers upload garment
photos and receive a numerical condition grade (1.0–10.0), a detailed condition
report, and a shareable certificate. Built by Pearson Media LLC.

- **Web:** [gradethread.com](https://gradethread.com)
- **Edge API:** `functions.gradethread.com` (Deno/Hono on Coolify)
- **Supabase:** self-hosted at `api.gradethread.com`

GradeThread also ships **FlipDesk**, a reseller-management surface that runs the
full eBay lifecycle (source → catalog → measure → photograph → grade → comp →
draft → list → sell → ship → reconcile).

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript (strict), Vite 7 |
| Styling | Tailwind CSS v4, shadcn/ui |
| State | Zustand (auth), TanStack Query (server state) |
| Routing | React Router v7 |
| Auth/DB/Storage | Supabase (self-hosted, PKCE) |
| Edge functions | Deno + Hono (`services/edge-functions/`) |
| AI | Claude Vision API (Anthropic) |
| Payments | Stripe |
| Hosting | Cloudflare Pages |
| Monitoring | Sentry (errors), PostHog (analytics) |

## Getting started

```bash
npm install          # installs deps + enables the gitleaks pre-commit hook
cp .env.example .env # fill in your keys
npm run dev          # dev server at localhost:5173
```

### Common commands

```bash
npm run dev      # start the dev server
npm run build    # type-check + production build (+ prerender static pages)
npm run lint     # ESLint
npm run test     # vitest
npm run preview  # preview the production build
```

### Edge functions

```bash
cd services/edge-functions
cp .env.example .env
deno task dev    # or: docker-compose up
deno test --allow-net --allow-env
```

## Project layout

```
src/                      React app (pages, components, hooks, stores, lib, types)
services/edge-functions/  Deno/Hono API (grading, payments, webhooks, FlipDesk)
supabase/migrations/      Postgres schema, RLS, triggers
functions/                Cloudflare Pages Functions (blog/cert SSR, robots, sitemap)
docs/                     Operational + security runbooks
```

A fuller architecture overview lives in [`CLAUDE.md`](CLAUDE.md); the product
roadmap (100+ user stories) is in [`prd.json`](prd.json).

## Security

We take security seriously and welcome responsible disclosure.

- **[SECURITY.md](SECURITY.md)** — how to report a vulnerability, scope, safe
  harbor, and supported versions.
- **[docs/INCIDENT_RESPONSE.md](docs/INCIDENT_RESPONSE.md)** — severity levels,
  the first-60-minutes playbook, mass marketplace-token revocation, the
  notification chain, emergency consoles, and the quarterly security-review
  checklist.
- **[docs/KEY_ROTATION.md](docs/KEY_ROTATION.md)** — key-rotation runbook,
  including the `EDGE_ENCRYPTION_KEY` `v1:` → `v2:` re-encryption procedure.

Secrets are kept out of git: every `.env` variant is gitignored (only the
`*.env.example` placeholders are tracked), a [gitleaks](https://github.com/gitleaks/gitleaks)
pre-commit hook (`.githooks/pre-commit`, auto-enabled by `npm install`) and a
CI job (`.github/workflows/secret-scan.yml`) block secrets from landing.

## License

Proprietary © Pearson Media LLC. All rights reserved.
