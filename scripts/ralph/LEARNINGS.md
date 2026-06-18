# Ralph Learnings — durable gotchas playbook

Read every iteration. Keep it SMALL (target < 150 lines). One terse bullet per
durable, non-obvious trap. Prune anything stale. This is cheap persistent
memory — not a progress log (the harness records progress separately).

## Build / verify
- `npm run build` does NOT run vitest — it only typechecks + builds. Run
  `npm test` separately or you ship a red `main`.
- Two web tests are red on clean `main` independent of your change (verified by
  stashing): `seo/__tests__/not-found.test.ts` (missing SPA-shell rule for
  /dashboard) and `prerender/__tests__/prerender.test.ts` (expects
  `dist/how-it-works/index.html`, but that route isn't prerendered — fails even
  after a fresh build). Don't chase either as your regression.
- `npx tsc --noEmit` is NOT enough — the build runs `tsc -b` (project refs),
  which is stricter and catches casts `--noEmit` lets slide (e.g.
  `x as Record<string,unknown>` on a typed interface needs
  `x as unknown as Record<…>`). Always confirm with `npm run build:locked`.
- Use `npm run build:locked`, never bare `npm run build`, when another loop may
  run concurrently (shared cross-loop build lock; see `docs/AGENT_COHABITATION.md`).
- `npm run build` does NOT apply migrations. After any SQL change run
  `npm run verify:db` (throwaway Supabase in Docker) — broken migrations
  otherwise only fail in CI after you've committed.
- Verify quietly: pipe build/test to a log and only read the tail on failure;
  don't ingest passing logs into context.

## Architecture / routing
- Two hosts, easy to confuse: Supabase/Kong = `api.gradethread.com` (Supabase
  routes only); Hono edge = `functions.gradethread.com` (ALL `/api/*` routes).
  Hitting `/api/*` on `api.*` silently 404s.
- Edge service uses the **service-role client which BYPASSES RLS**. Every query
  on a multi-tenant table MUST be tenant-scoped
  (`.eq("user_id", c.get("workspaceOwnerId") ?? c.get("userId"))`) or via an
  already-ownership-verified parent row. Never update/delete/select-by-id from a
  request-body id without confirming ownership. See
  `services/edge-functions/src/tests/tenant-isolation_test.ts`.

## Sync provenance epic (US-1076…1086)
- The `listings.listing_origin` column (US-1077) is NOT persisted yet, though
  the registry `lib/sync-precedence.ts` (US-1076) and downstream stories are
  committed. Until US-1077 lands the column, derive provenance with
  `deriveListingOrigin()` from existing signals (`batch_id`/`synced_to_ebay_at`
  ⇒ gradethread; an eBay `platform_listing_id` we never published ⇒ ebay) — do
  NOT `select("listing_origin")` (PostgREST 400s on the missing column).
- `listings.source_of_truth` (US-148 pin) is deprecated (US-1078); new sync code
  must not read it — provenance drives precedence now.

## Frontend conventions
- shadcn: don't hand-edit `src/components/ui/*`. Toasts via `sonner`, not shadcn
  toast. Icons from `lucide-react` only. Named exports + `@/` imports.
- New public static page → register in `src/lib/seo/public-routes.ts` AND
  `src/prerender/entry-server.tsx`, or the prerender sync-guard test fails.
- `react-helmet-async` v3 renders no SSR head; add structured data via `<SEO
  jsonLd=…>` AND mirror it in `src/lib/seo/head-builder.ts` `jsonLdForRoute()`.

## Storage / uploads
- Server uploads: `validateImageUpload()` → `stripImageMetadata()` →
  `storage.upload()`. `submission-images` is PRIVATE (signed URLs ≤900s, never
  `getPublicUrl`); `item-photos` is the only public bucket.

## prd.json / Ralph workflow
- Never read or edit `prd.json` from inside an iteration — the harness selects
  the story (`current-story.json`) and flips `passes:true` for you.
- New stories use `prd.json.nextId` then bump it (NOT `max(id)+1` — done stories
  live in `prd.archive.json`, so that would reuse ids).
- Optional per-story fields the harness understands:
  - `"hard": true` → iteration runs on `$HARD_MODEL` (Opus). The default model
    is now Opus too, so this is a no-op unless `RALPH_DEFAULT_MODEL` is lowered.
  - `"model": "opus"|"sonnet"|"haiku"` → exact model for that story (overrides
    `hard`). Env `RALPH_FORCE_MODEL` overrides all stories for a one-off sweep.
  - `"relevantPaths": ["src/...", "..."]` → file/glob hints the agent reads
    first instead of sweeping the tree (see GRAPHIFY_PILOT for auto-populating).
