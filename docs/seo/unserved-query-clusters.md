# Four query clusters earning impressions and zero clicks

From the same Search Console export as `US-9001-VERDICT.md`. 110 queries,
**750 impressions, 0 clicks** between them. That is 12% of everything the site
earns, converting at nothing.

Data: `docs/seo/unserved-query-clusters.csv`.

## 1. Marketplace migration: "X to Y"

**19 queries, 202 impressions, 0 clicks, average position 19.5.**

`mercari to grailed` (21), `grailed to mercari` (18), `grailed to poshmark` (18),
`whatnot to poshmark` (17), `mercari to vinted` (17), `poshmark to whatnot` (17),
`ebay to grailed` (16), `poshmark to grailed` (16), `grailed to ebay` (14),
`vinted to mercari` (14), and nine more.

These are not comparison searches. "Vinted vs Mercari" asks which is better.
"Mercari to Vinted" asks **how do I move my listings there**. Google is landing
them on the `/compare/` pages, which answer the first question, so they bounce
before they click.

GradeThread already has the answer built. FlipDesk does crosslisting. There is
no page that says so for this intent.

**This is the clearest unserved intent in the export.** Filed as US-9018.

## 2. Crosslisting, commercial intent

**42 queries, 162 impressions, 0 clicks, average position 49.9.**

`cross listing software` (32, position 58), `cross listing app` (13, position 47),
`best cross listing app` (11, position 42), `crosslisting app` (11, position 49),
`best cross listing app for resellers` (7, position 45).

Position 50 is page five. Nobody goes to page five.

`/reselling/best-crosslisting-apps` exists and sits at position 51.5 on 203
impressions with zero clicks. The page is there. It does not rank.

This is US-9009's territory: `multi channel listing software` was priced at
$34.51 top-of-page in the Planner pull. It is the highest commercial intent in
the whole export, GradeThread sells the product, and the page is on page five.

**US-9009 should move up. Evidence added to the story.**

## 3. Luxury and designer resale

**16 queries, 237 impressions, 0 clicks, average position 43.3.**

`authenticated luxury resale platforms` (55, position 37), `luxury resale
platforms comparison` (51, position 47), `trusted luxury resale platforms` (28,
position 70), `reliable luxury resale platforms` (25, position 60), `secure
luxury resale platform` (22, position 74).

Note the shape: one head term with adjectives swapped in front of it. Authenticated,
trusted, reliable, secure. That is not how people type. That is how an assistant
expands a query.

All of it lands on `/blog/best-resale-apps-designer-luxury-clothing`, the
highest-impression page on the site (1,136 impressions, position 21, 3 clicks).

The three short queries in this cluster behave completely differently:
`designer resale apps` (11) and `designer resale app` (10) rank at position 10,
and `which app has the most listings for a second-hand designer handbag?` (12)
ranks at 10.2. Those are winnable now. The adjective variants at position 40-74
are not.

## 4. Long pasted prompts

**33 queries, 149 impressions, 0 clicks, average position 42.6.**

Real query strings, verbatim from the export:

> "i buy pre-owned fashion regularly and gravitate toward well-known premium
> labels and quality brands can you recommend some online marketplaces? give me
> pros and cons for each online marketplaces."

> "i shop for high-end and designer pieces and am willing to pay a premium..."

> "can you recommend some jacket brands that have the best resale value?"

People are pasting assistant-shaped prompts into Google search. Thirty-three of
them, all landing on GradeThread, all at position 28-60.

This is the GEO surface the strategy note keeps referring to, showing up as
measurable traffic for the first time. It is small and it is real. Worth watching
in US-9016's cluster table, not worth a build yet.

## What to do

1. **File the migration intent.** New story, US-9018. 202 impressions of demand
   for a thing the product already does.
2. **Promote US-9009 and point it at crosslisting first.** 162 impressions of
   commercial intent, $34.51 top-of-page bid, product already built, current
   page on page five.
3. **Leave the luxury cluster alone for now,** except the three short queries
   already at position 10.
4. **Track the pasted-prompt cluster** in US-9016 rather than building for it.
