---
title: A brand fact must say where it came from
aliases: [brand provenance, source_url, confidence, tag_eras provenance]
type: contract
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00572_tag_eras_provenance.sql
  - supabase/migrations/00578_brand_kb_provenance_required.sql
  - supabase/migrations/00760_validate_brand_provenance_constraints.sql
  - services/edge-functions/src/routes/admin-brand-knowledge.ts
reviewed: 2026-09-10
tags: [brands, provenance, contract]
summary: Every brand-KB row carries a non-blank source_url and a non-null confidence, and every datable tag_eras entry carries its own — enforced NOT VALID until 00760 cleared the last 45 rows and VALIDATED all three, which also ended the trap where a migration about registered numbers failed on a constraint about eras.
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

> **The definition of done for the backfill** was
> `ALTER TABLE public.<t> VALIDATE CONSTRAINT <t>_sourced;` per table, once prod
> had been counted and the residue sourced or retired. `00760` did that. See the
> section below.

## All three are VALIDATED now (`00760`, US-3126, 2026-09-09)

Three constraints had sat NOT VALID since they were created:

    brand_knowledge_sourced            brand_fact_is_sourced(source_url, confidence)
    brand_colorways_sourced            brand_fact_is_sourced(source_url, confidence)
    brand_knowledge_tag_eras_sourced   tag_eras_all_sourced(tag_eras)

**The two `brand_fact_is_sourced` constraints failed on ZERO rows the whole
time.** Nothing was ever blocking them; they were left NOT VALID and never
revisited. Only the `tag_eras` one had a real residue, and that number moved
under its own work rather than staying put:

| measured at | rows failing `tag_eras_all_sourced` |
|---|---:|
| `00748` | 90 |
| after `00748` | 88 |
| after `00757` | 45 (it fixed 43 as a side effect of writing registered numbers) |
| after `00760` | **0** |

US-3126 estimated 11. The estimate was wrong in both directions over time, which
is the argument for measuring rather than inheriting a figure.

The fix for the last 45 is the narrow one `00748` and `00757` used: every one of
those rows already carries a row-level `source_url` and `confidence` — checked,
not assumed — so each datable era inherits what the row itself asserts. That
**restates an existing claim rather than inventing a citation**, and it raises no
confidence: an era inherits the row's own number, whatever that number is.

`VALIDATE CONSTRAINT` takes a SHARE UPDATE EXCLUSIVE lock. It does not block
reads or writes, only concurrent schema changes on the same table.

### The trap this ended, and why it cost real time

**NOT VALID means Postgres never checked the rows that already existed. It does
not mean the constraint is inert.** Postgres checks any row an UPDATE *touches*,
so a migration adding a registered number to a brand row seeded in 2026-07 fails
on a constraint about tag eras — an error about something the migration was not
doing.

`00730` could not touch Peter Millar at all until its one datable era was sourced.
`00748` hit it with two rows and `00757` with eighty. Each had to carry a
provenance fix it was not otherwise about. See [[brand-rn-attribution]] for the
work those migrations were actually doing.

Validated, the constraints stop being a trap that fires on unrelated work and
become what they were meant to be: a rule that new rows must carry provenance,
reported immediately rather than discovered while trying to write something else.

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
- [[brand-rn-attribution]] — the tests a registered number must pass before it is written
- [[brand-colorway-harvest]] — what a harvested colorway row carries and why some stay NULL
