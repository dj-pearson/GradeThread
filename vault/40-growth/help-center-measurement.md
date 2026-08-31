---
title: Help Center measurement — two systems, never summed
type: contract
status: current
source_of_truth: code
code_refs:
  - supabase/migrations/00606_help_analytics.sql
  - services/edge-functions/src/lib/help-analytics.ts
  - functions/_shared/help-analytics.ts
  - src/lib/analytics-events.ts
reviewed: 2026-08-31
tags: [help-center, analytics, seo, contract]
summary: PostHog cannot see the public help pages because they are server-rendered, so views are counted in Postgres for the public surface and in PostHog for the app, and adding the two together produces a wrong number rather than a bigger one.
---

# Help Center measurement

> **Re-reviewed 2026-08-31.** Drift flagged `src/lib/analytics-events.ts` for US-9033, which adds two RN
> tool events. Nothing about the help centre's split counting — Postgres for
> the server-rendered public pages, PostHog for the app — is touched by it.

Two numbers decide whether the help centre was worth building: the organic
traffic it earns, and the tickets it prevents. Both are measured, and they are
measured in different places for a reason that is easy to forget and expensive
to forget.

## PostHog cannot see the public pages

Every public help URL is served by a Cloudflare Pages Function
(`functions/help/[[path]].ts`) that returns complete standalone HTML. The React
app never mounts on it. That is deliberate and it is why those pages index well.

It also means `posthog-js` is not on them. There is no consent decision, no
`window.posthog`, and no event. A "top articles" chart built from the
`help_article_view` PostHog event is therefore a chart of **in-app reading only**
— it omits exactly the traffic the section exists to earn.

## So the split is

| Surface | Counted by | Grain | Identity |
|---|---|---|---|
| Public SSR pages (`/help/...`) | `help_article_views`, surface `public` | article, surface, day | none at all |
| In-app reader (`/dashboard/help`) | `help_article_views`, surface `app` | article, surface, day | none at all |
| In-app interaction (search, votes, deflection, contextual sheet) | PostHog | event | the session, with consent |

**The two `surface` values are never summed.** An article everybody opens from
inside the product and nobody ever finds through a search engine is a different
result from one that ranks, and adding the columns is how you conclude the help
centre is earning traffic it is not.

**The admin report reads Postgres, not PostHog.** A report that required somebody
to log into a third-party dashboard would not be a report the product has. It
lives at `/admin/content/help/report`.

## Rules the counting depends on

**The view is counted in `onRequestGet`, not in the renderer.** `withEdgeCache`
can return a stored response without the renderer running at all, so a counter
inside `renderArticle` would miss every cache hit — under-reporting exactly the
articles popular enough to stay cached.

**Crawlers are filtered by user agent before the call is made**, and an EMPTY
user agent is not counted. Real browsers always send one; treating the unknown as
human is how a views table becomes a table of whatever ran that week. These
numbers will read LOWER than a raw server log, and that is the intent.

**The `.md` mirror is not counted.** It exists for answer engines to ingest
whole; counting it would put whatever a crawler happened to fetch at the top of a
list meant to show what people read.

**The SPA help pages count nothing server-side.** A full page load is answered by
the Pages Function, which counts it there; counting again on hydration would
double every first visit. The SPA fires the PostHog event only.

**`record_help_article_view` requires the article to exist.** The endpoint is
reachable anonymously, so without that check it would be a way to fill the table
with invented slugs and the top-articles list would stop being a list of
articles.

## Deflection rate

Deflections divided by **deflections plus tickets**, never by tickets alone.
Over tickets alone the rate passes 100% the moment the help centre works, and it
rises whenever ticket volume falls for reasons that have nothing to do with it.

No data returns null, not zero. A dashboard printing "0%" for a quiet week is
reporting a failure that did not occur.

## The zero-result backlog

`help_search_misses` (00603) is a log, ordered by when somebody typed.
`help_zero_result_queries` groups it by the normalized query so the ranking is by
how many people wanted it, which is the order an author needs. The signed-out
share is split out: a miss from a search-engine visitor is an SEO gap, a miss
from a signed-in customer is usually a product one.

## Tickets before and after

The category in that panel is the **triage** category (`support_tickets.
triage_category`, six values assigned by the support agent, 00370), not the help
category (fourteen values chosen by an author). There is no mapping between them
and none is invented: a mapping would produce a chart precise enough to believe
and wrong in a way nobody could check. Untriaged tickets are counted under
`untriaged` rather than dropped, so the totals agree with the ticket queue.

The report says out loud when the "after" window has not elapsed. Comparing a
full 30 days against 4 elapsed days always shows a fall, and it is not a result.

## Grouping for organic reporting

Two mechanisms, one per tool:

- **GA4**: every help page sets `content_group: "help"` on its config call, so
  the section is a dimension rather than a URL-prefix filter somebody has to
  remember to apply.
- **Search Console**: `sitemap-help.xml` is already its own sitemap, and Search
  Console reports per sitemap. No further tagging needed.

## Related

- [[help-center-gating]] — which articles are public at all
- [[help-center-map]] — the article inventory
