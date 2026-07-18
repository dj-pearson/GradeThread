---
title: Brand taxonomy — overview and extraction status
type: reference
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00457_contemporary_womens_brand_knowledge.sql
  - supabase/migrations/00458_basics_mall_brand_knowledge.sql
  - supabase/migrations/00459_footwear_brand_knowledge.sql
  - supabase/migrations/00467_preppy_contemporary_mens_brand_knowledge.sql
  - supabase/migrations/00468_handbags_accessories_brand_knowledge.sql
reviewed: 2026-07-18
tags: [grading, brands, taxonomy]
summary: Where brand and garment taxonomy currently lives, why that is a problem, and how it gets extracted in US-2058.
---

# Brand taxonomy — overview and extraction status

This folder will hold the brand and garment taxonomy that grounds grading and
listing. **It is largely empty on purpose** — the extraction is US-2058, and this
note exists to explain the situation until then.

## Where the knowledge lives today

Roughly **830 lines** of brand taxonomy sit in the leading comments of five
migrations:

| Migration | Header lines |
|---|---|
| `00468_handbags_accessories_brand_knowledge.sql` | 196 |
| `00467_preppy_contemporary_mens_brand_knowledge.sql` | 182 |
| `00458_basics_mall_brand_knowledge.sql` | 167 |
| `00457_contemporary_womens_brand_knowledge.sql` | 143 |
| `00459_footwear_brand_knowledge.sql` | 141 |

## Why that is a problem

**Applied migrations are immutable.** Correcting a fact in one of those headers is
not possible — the file has already run against production, and editing it after
the fact breaks the guarantee that migrations describe what actually happened. The
only way to "amend" the knowledge is to write another migration whose sole purpose
is to carry a corrected comment, which nobody does.

So this taxonomy is effectively **write-once**: not indexed, not searchable
alongside other grading knowledge, and invisible to anyone working on grading who
does not already know it is there.

It is also flat. SQL comments cannot express that a brand appears in two tiers, or
why a tier boundary sits where it does — relationships that wikilinks handle
naturally.

## The split this folder maintains

When US-2058 lands, each brand-family note owns the **reasoning** — why a brand
sits in a tier, what the authentication tells are, how eras are distinguished. The
`brand_knowledge` **table rows** remain the source of truth for the **values** the
grader actually reads at runtime.

Keep that split explicit in every note here. A note that starts restating row data
will drift from the table silently, and the grader will never notice.

## Open question for the extraction

US-2058 includes an audit comparing the header content against the rows actually
present in production. Any taxonomy documented in a header but never inserted as a
row is **documented knowledge the grader has never seen** — worth knowing about
before treating these headers as a description of live behaviour.

## Related

- [[grading-scale-and-weights]] — what consumes this taxonomy
- [[adr-0001-knowledge-vault]] — why extraction is worth doing
- [[INDEX]]
