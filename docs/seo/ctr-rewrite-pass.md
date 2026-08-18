# US-9017 CTR pass — what shipped and what the operator still has to run

Worklist: `docs/seo/ctr-rewrite-worklist.csv` (19 URLs, `shipped` column).
Applied 2026-08-18.

## The bet, stated plainly

149 URLs sit at position 3-10 and convert at 0.85% against a 3-10% baseline
(`US-9001-VERDICT.md`). Closing the whole gap across these 19 URLs is worth
about **66 clicks over six months**, against the 55 the site earned. It roughly
doubles a small number. It cost a day. It is not the growth plan, and the
calculators (US-9002 to US-9007) still are.

## What changed, by surface

The 19 URLs are not one thing. They live on three surfaces with three different
title budgets and three different deploy paths.

| Surface | URLs | Budget | Ships when |
|---|---|---|---|
| Registry routes (`PUBLIC_ROUTES`) | 11 | 46 chars, plus the " \| GradeThread" suffix the `<SEO>` layer appends | next build |
| Pages Function template (`/value/{brand}/{item}`) | 1 | 60 chars, no suffix | next build |
| `blog_posts` rows | 7 | 60 chars, no suffix | when the script below is run |

Registry copy is in `reseller-glossary.ts`, `flaw-library.ts`,
`platform-standards.ts`, `comparison-guides.ts` and `public-routes.ts`.
`src/test/ctr-rewrite-worklist.test.ts` asserts the shipped copy equals the
reviewed copy in the CSV, so neither side can move without the other.

## The one thing left to run

```
node scripts/apply-blog-ctr-rewrites.mjs                      # dry run, prints the diff
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
  node scripts/apply-blog-ctr-rewrites.mjs --apply
```

It writes `seo_title` and `seo_description` only. The `title` column, which is
the on-page H1 and every internal link label, is untouched: the blog SSR reads
`post.seo_title || post.title`, so this changes what Google shows and nothing a
reader sees on the page. To undo a rewrite, null the two columns.

A post edited in the admin UI since the worklist was captured is reported and
skipped rather than clobbered. Re-running after a successful pass is a no-op.

## Two decisions worth recording

**Comparison titles are now overridable per pair.** `templatedComparison()`
took `intro`/`verdict`/`h1` overrides; it now takes `title`/`description` too.
Four pairs got bespoke titles. The other twelve keep
"X vs Y for Resellers (2026)", because they earn no impressions yet and there is
nothing to learn from rewriting a page nobody sees.

**Definition pages got titles that promise what the snippet cannot.** Nineteen
glossary pages earn 1,087 impressions and 4 clicks, because Google answers
"what does VGUC mean" inside the results page. "VGUC Meaning (Very Good Used
Condition)" cannot beat that; "VGUC: What It Means and What It's Worth" at least
offers something the snippet does not contain. If the follow-up read shows this
did nothing, the honest conclusion is that the class is unwinnable and the
glossary should be maintained, not extended.

## Follow-up: 2026-10-17

Sixty days after the pass. Re-export Search Console for the same 19 URLs and
compare CTR against the `ctr_actual_pct` column captured here. Record the
result against US-9016's threshold table. Two months is the minimum for a title
change to re-crawl, re-rank and accumulate enough impressions to read.
