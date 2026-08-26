---
title: Help Center gating — what is public, what is not, and why
type: contract
status: current
source_of_truth: code
code_refs:
  - supabase/migrations/00602_help_center_articles.sql
  - services/edge-functions/src/lib/help-center.ts
  - services/edge-functions/src/routes/help-center.ts
  - src/pages/help-reader.tsx
reviewed: 2026-08-25
tags: [help-center, seo, security, contract]
summary: Help articles have three visibilities, not two; the wall is RLS plus one edge function, and public by default is the rule that pays for the whole feature.
---

# Help Center gating

Every help article carries a `visibility`. There are **three** values, and the
distinction between the last two is the reason this note exists.

| visibility | Who reads it | Indexed | In sitemap / llms.txt |
|---|---|---|---|
| `public` | anyone, signed in or not | yes | yes |
| `members` | any authenticated account | never | never |
| `internal` | `is_admin()` only | never | never |

## Public by default

The default is `public`, and that is a commercial decision, not a shrug.
Documentation is the content answer engines quote most readily, because it is
specific and checkable in a way marketing copy is not, and a help centre behind
a login earns nothing: no organic traffic, no citations, and no reassurance to
somebody deciding whether to sign up.

**Competitor copying is not a reason to gate.** Anyone can create an account and
screenshot the product in an hour. The moat is the grading model and the eBay
wiring, not the manual.

## What is gated, and which level

`members` — content that is only meaningful to somebody who already has an
account, and where publishing it would mostly generate confusion rather than
risk. Billing mechanics tied to a specific plan, workspace administration.

`internal` — content that describes how the company defends itself:

- the admin review queue and the human-review workflow
- grading prompt versions and the canary process
- refund and dispute handling internals
- key rotation and incident-response summaries
- abuse and rate-limit thresholds
- unreleased feature notes

**`members` deliberately stops short of `internal`.** An authenticated session
belongs to a *customer*. Collapsing the two would publish operator runbooks to
every customer the first time anything needed to be readable in-app — which is
exactly what happened to the original two-value design in US-2572, and why it
became three.

**No gated article contains a secret VALUE.** It names where the secret is
stored. See [[env-reference]].

## The wall is three things, and each fails silently alone

1. **RLS in `00602`.** The Cloudflare Pages SSR worker reads with the **anon**
   key, so the anon policy is what keeps non-public rows off the public web. A
   handler bug cannot leak one through the public renderer, because the anon
   role never sees the row.
2. **`visibilitiesFor(viewer)` in the edge lib.** The edge reaches Supabase with
   the **service-role** client, which *bypasses* RLS — so inside that process
   this one function is the wall. It lives in `lib/help-center.ts`, not in the
   route file, and a guard test greps the routes for a hand-rolled
   `.eq("visibility", …)` so it cannot grow a second copy.
3. **Every public surface calling only the anonymous endpoint.** The SSR pages,
   `/help.md`, `sitemap-help.xml`, `llms.txt` and the OG card all call
   `/api/content/public/help`, which *cannot* return a non-public row. Tests in
   `src/test/help-gating.test.ts` assert each of them.

## Two rules that are easy to undo

- **A row the viewer may not see returns 404, never 403.** A 403 confirms the
  slug exists, which turns the members-only list into something an anonymous
  caller can enumerate one guess at a time.
- **Search is filtered by the same function.** `help_search`'s
  `p_visibilities` argument has **no default**, on purpose: a default would make
  the safe call and the unsafe call identical at the call site, and the unsafe
  one would be shorter to type. Search is the most tempting way around a
  permission wall, because it reads like a query against "the index" rather than
  against the articles.

## Writes are gated by the same function

Two endpoints let a reader write against an article, and both resolve the
article through `loadArticle(viewer, slug)` before they insert anything:

- `POST /api/content/public/help/:slug/feedback` — anonymous, so it can only
  accept a vote on a `public` article.
- `POST /api/help/:slug/feedback` — authenticated, so a customer can rate a
  `members` article and an admin an `internal` one. The vote records the
  viewer's TIER, never who they are.

`POST .../:slug/view` is the same shape: the counter RPC requires the article to
exist, so neither endpoint is a way to write arbitrary slugs into a table. See
[[help-center-measurement]].

## Where it is read

- Public: `/help` and below, edge-SSR'd by `functions/help/[[path]].ts`.
- Members and internal: `/dashboard/help`, `noindex`, never prerendered, and not
  in `PUBLIC_ROUTES` — see [[seo-public-route-registry]] for why an edge-SSR
  surface stays out of that registry.

## Related

- [[seo-public-route-registry]] — why `/help` is not a registered static route
- [[ai-crawler-policy]] — which crawlers may cite the public half
- [[help-center-measurement]] — how reads and deflections are counted
- [[service-role-tables]] — the same bypasses-RLS hazard, elsewhere
