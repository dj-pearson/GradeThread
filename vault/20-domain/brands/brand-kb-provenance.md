---
title: A brand fact must say where it came from
aliases: [brand provenance, source_url, confidence, tag_eras provenance]
type: contract
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00572_tag_eras_provenance.sql
  - supabase/migrations/00578_brand_kb_provenance_required.sql
  - services/edge-functions/src/routes/admin-brand-knowledge.ts
reviewed: 2026-08-09
tags: [brands, provenance, contract]
summary: Every brand-KB row carries a non-blank source_url and a non-null confidence, and every datable tag_eras entry carries its own — both enforced by NOT VALID constraints so the documented legacy exceptions stay readable.
---

# A brand fact must say where it came from

The brand knowledge base is the input to identification and to what a certificate
prints. A fact in it that nobody can trace is indistinguishable from one somebody
invented — and it will be believed, because it is sitting in a curated table.

Two rules, at two levels, both enforced in the database.

## The row rule (`00578`, US-1996 AC5)

Every row in all five brand-KB tables must carry:

- **`source_url`** — non-null and non-blank. `seed:<file>.ts` is an accepted form
  for rows lifted from an in-code table: it names a real, readable origin.
- **`confidence`** — non-null.

**Presence, not value.** `00389` already bounds confidence to `[0,1]`, and a low
number is an honest answer — `00576` deliberately seeds two dating claims at 0.4
and 0.45 because their sourcing is a buyer guide rather than the maker. The
requirement is that somebody *said how sure they were*.

## The entry rule (`00572`, US-2212 AC5)

`tag_eras` is jsonb, so its per-entry provenance needed no schema change to
*write* — what needed one was the rule that it must be there. Every **datable**
entry (one whose `years` names a year or a decade) carries its own `source_url`
and numeric `confidence`.

Entries whose `years` is `all` / `current` / `ongoing` are **format notes**, not
dating claims. They have nothing to cite and are exempt; requiring a source there
would push an author to invent a URL for a true statement.

Era is the price on a vintage piece, which makes this the highest-liability
content in the KB. An uncited era may be rendered as prompt reference and must
never be published.

## Both are NOT VALID, and that is the design

Neither constraint validates existing rows, for the same two reasons each time:

1. **Documented legacy exceptions exist and must stay readable.** ~220 `tag_eras`
   entries predate `00572`. Eleven `brand_size_charts` rows predate `00578` —
   seeded by `00498`, whose own header says the in-code chart seed carried no
   per-chart provenance to copy. Those are the values the resolver has always
   used, moved somewhere an operator can correct them. A plain `CHECK` would
   force a choice between fabricating sources and deleting curated data.
2. **Production is not the seeded stack.** The measured counts below are what the
   *migrations* produce. Prod also holds whatever the admin curation surface has
   written, and that path permitted a null confidence until `00578` shipped. A
   `VALID` constraint could pass every local check and still fail to apply in
   production — the worst shape a migration can have.

So: new content cannot arrive unsourced; legacy rows stay readable and stay
honestly marked (`verified = false` already says so).

### The measured baseline

Taken from a from-zero throwaway stack, which holds exactly what the migrations
seed:

| table | rows | missing provenance |
|---|---:|---:|
| `brand_knowledge` | 204 | 0 |
| `brand_styles` | 735 | 0 |
| `brand_style_codes` | 30 | 0 |
| `brand_colorways` | 159 | 0 |
| `brand_size_charts` | 316 | **11** |

> **The definition of done for the backfill** is
> `ALTER TABLE public.<t> VALIDATE CONSTRAINT <t>_sourced;` per table, once prod
> has been counted and the residue sourced or retired. Until then the constraint
> is a floor on new writes, not a claim about old ones.

## The write path is where a rule like this actually leaks

`buildPatch` in `admin-brand-knowledge.ts` used to carry an explicit branch
passing a null confidence straight through. That single line is why US-1716 AC4's
claim that provenance was "schema-enforced" was untrue for as long as it was: the
columns are nullable and nothing upstream said no.

Both are now refused there too, with an error that says why. **The database
constraint is the backstop, not the first line** — without the route check a null
arrives as a constraint violation surfacing as a 500 instead of a clean 400.

## Related

- [[brand-taxonomy-overview]] — why per-brand values live in the DB and rules live here
- [[brand-kb-decoder-bar]] — the same discipline applied to what may be inferred from a code
- [[brand-kb-negative-findings]] — recorded absences, which are themselves facts worth sourcing
