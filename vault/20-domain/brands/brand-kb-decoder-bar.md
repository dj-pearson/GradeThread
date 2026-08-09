---
title: The decoder bar — three tests, all required
aliases: [decoder bar, decoder]
type: contract
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00460_luxury_outerwear_brand_knowledge.sql
  - supabase/migrations/00574_headwear_brand_knowledge.sql
  - supabase/migrations/00575_eyewear_brand_knowledge.sql
  - supabase/migrations/00576_jewelry_brand_knowledge.sql
reviewed: 2026-08-09
tags: [brands, grading, decoder, contract]
summary: A style code becomes a decoder only if it is tag-printed AND regular AND brand-unique in format; the third test is the one that fails, and failing it mints false positives.
---

# The decoder bar — three tests, all required

A **decoder** is a seeded pattern that recovers a brand from a style code on a
tag. It is powerful precisely because it works when the brand tag has been cut
off — and dangerous for the same reason.

Established in `00460` (US-1736 / US-1740) and applied by every later pack:

> **tag-printed AND regular AND brand-unique IN FORMAT**

All three. The bar is quoted verbatim across at least eight packs, which is how a
rule written once became the corpus's standard.

## The third test is the one that fails

Tag-printed and regular are easy. **Brand-unique in format** is what most codes
fail, and failing it does not merely lose a signal — it *mints a false positive*
from any tag that happens to carry a similar-shaped string.

| Code | Tag-printed | Regular | Brand-unique | Seeded? |
|---|:--:|:--:|:--:|---|
| Canada Goose `4660MA` (4 digits + M/L) | ✓ | ✓ | ✓ | **Yes** — names the model outright, recoverable from a cut tag |
| ASICS 8-char article (digits-then-letter) | ✓ | ✓ | ✓ | **Yes** — a shape Nike/adidas/Reebok/New Balance do not use |
| Fossil `ES5331` / `FTW1234` | ✓ | ✓ | ✓ | **Yes** — on the metal case back; a watch is not a bag |
| Reebok `GY7434` (2 letters + 4 digits) | ✓ | ✓ | **✗** | **No** — that format is *adidas's* |
| PUMA 6-digit `380190` | ✓ | ✓ | **✗** | **No** — bare digit run |
| Lee `101`, Chanel serial, Moncler serial, Balenciaga tab | ✓ | ✓ | **✗** | **No** — bare digit runs |
| Canada Goose hologram number | ✓ | ✓ | **✗** | **No** — bare digit run, and not proof of anything |
| New Era `5950` | ✓ | ✓ | **✗** | **No** — bare digit run, *and* it names the silhouette (see below) |
| Ray-Ban `RB3025` / Oakley `OO9102` / Persol `PO0714S` | ✓ | ✓ | ✓ | **Yes** — per-brand prefixes, despite one shared parent (see below) |
| Ray-Ban `RX5154` / Oakley `OX8046` (optical) | ✓ | ✓ | **✗** | **No** — `RX` is the whole industry's word for a prescription |
| Eyewear size triplet `58□14 135` | ✓ | ✓ | **✗** | **No** — an industry standard, so it identifies nobody |
| Metal purity hallmark `925` / `750` | ✓ | ✓ | **✗** | **No** — on nearly all fine jewelry; a fact about the alloy |
| Maker's marks `ALE`, `T&CO.`, `D.Y.` | ✓ | ✓ | ✓ | **No** — passes the bar and is still not a decoder (see below) |
| Warby Parker `Percey` / `Durand` | ✓ | ✓ | **✗** | **No** — a bare surname; the Rag & Bone `Fit 2` refusal |

### The Reebok case is the clearest argument for the third test

Reebok's modern codes are tag-printed and perfectly regular. They are still not
seeded, because **adidas owned Reebok from 2006 to 2021 and the two ran a shared
corporate coding system**. A pattern over that format would mis-brand adidas
shoes as Reebok *and* Reebok shoes as adidas — "the tag's own brand would lose to
a format guess."

Two of three tests passing is not a near miss. It is the failure mode.

## The fourth question: WHICH ENTITY does the identifier name?

Added 2026-07-19 when the Ralph brand-KB log was reconciled into the vault
(US-2061). The three tests above are necessary and **not sufficient**.

URBN's `OB######` style number is primary-sourced (URBN's own vendor manual),
tag-printed, and regular. US-1986 still seeded **no decoder** for it:

> "the code is URBN-wide and Anthropologie (00457) + Free People (00449) already
> own packs, so a hit would spell 'Urban Outfitters' onto a sibling with DECODER
> AUTHORITY (which outranks the AI on conflict)."

A **parent-wide identifier can never attribute a sibling.** The same applies to
the shared RN 66170. This is the Reebok/adidas refusal in a new costume: there
the format belonged to another brand, here the *code* belongs to the parent.

So before seeding a decoder or an RN, ask **which entity the identifier names**,
not merely whether it is regular.

> **Decoder authority outranks the AI on conflict.** That is why a false decoder
> is worse than no decoder — it does not merely add a wrong guess, it overrides a
> correct one.

### An existing row that models the bad practice

`00399` seeds an informational Louis Vuitton `date_code`, which "reads as a
licence to decode any serial." It survives only because `SD1160` (2 letters + 4
digits) happens to be distinctive. Do not treat it as precedent — a bare digit
run is an ordinary number, which is why Chanel's 7–8 digit serial is deliberately
decoder-less (US-1736) and why Lee's `101` is too.

Where a code carries era information but fails the bar, put the fact in
`tag_eras` or `authentication_tells`, which is where it belonged anyway.

### A code can name the SILHOUETTE, which is a fourth way to fail

Added 2026-08-09 from the headwear pack (`00574`, US-2221). The story called New
Era 59FIFTY one of the two strongest decoder candidates in the whole grading-KB
review. It is refused, and the second reason is new to this note:

`5950` has been printed on New Era's main tag since 1993, and it is perfectly
regular. But **every 59FIFTY ever made carries it.** Decoding it recovers "this
is a New Era 59FIFTY" — which the tag says in words a line above — and never a
style. So it is a bare digit run *and* it answers the wrong question.

This is the [[#The fourth question WHICH ENTITY does the identifier name]] test
one level lower than URBN's `OB######`. There the code named the *parent* and
could not attribute a sibling; here it names the *model line* and cannot
attribute a unit. Both are "regular, tag-printed, and useless for the field you
wanted to fill."

The pack's other refusal is [[brand-kb-negative-findings]]-shaped and is 00468's
hangtag rule verbatim: New Era's per-cap size and style live on the **visor
sticker**, which is removable by design — New Era does not sell replacements, so
loose stickers circulate. The mark that identifies the unit is on the part that
comes off before resale, exactly like a handbag hangtag. A sticker is not
evidence about the cap under it.

### A shared parent does not always sink a code — ask whose prefix it is

Added 2026-08-09 from the eyewear pack (`00575`, US-2221 AC3), which is the
counter-example to the URBN refusal and worth holding beside it.

Ray-Ban, Oakley and Persol are all Luxottica brands. That is the same corporate
shape as URBN's `OB######`, where a parent-wide identifier could not attribute a
sibling — so the expectation going in was another refusal. **All three passed.**

The difference is whose mark the prefix is. `OB` was URBN's, so it named the
parent and could have spelled "Urban Outfitters" onto a Free People. `RB` is
Ray-Ban's, `OO` is Oakley's, `PO` is Persol's; no sibling emits another's
prefix. *The parent is shared; the identifier is not.*

Three properties made these the strongest decoders in the corpus:

- **The mark is on the frame, not on a tag.** The code is imprinted inside the
  temple arm — Ray-Ban's own site states the format and the location. There is no
  tag to cut and no hangtag to lose. That beats even 00468's Fossil case-back.
- **The pattern is prefix-anchored**, which is the Fossil safety rule at a much
  larger blast radius. Luxottica makes licensed frames for houses that are
  *already canonical in this KB* (Prada `PR`, Versace `VE`, Michael Kors `MK`), so
  a permissive `[A-Z]{2}\d{4}` would decode one and then spell "Ray-Ban" over a
  correct answer with decoder authority. The anchors are asserted by running them
  against those sibling codes, not by comment.
- **The optical prefixes are refused.** `RX5154` and `OX8046` are just as
  tag-printed and just as regular — and `RX` is the universal abbreviation for a
  prescription. It names the *category*. Losing the optical line is a real cost
  and it is correct: declining beats false-firing.

### Passing the bar is still not enough: a decoder needs something LEFT TO SAY

Added 2026-08-09 from the jewelry pack (`00576`, US-2221), which produced the
first mark in the corpus that **passes all three tests and is still not seeded**.

Pandora's `ALE` is the initials of Algot Enevoldsen, documented by Pandora
itself. It is struck into the metal, it is on every genuine piece, and no other
house uses it. Tag-printed ✓ regular ✓ brand-unique ✓ — and which entity does it
name? Pandora, correctly. It passes the fourth question too.

It gets no decoder anyway, because of *where decoders run*:

> `decodeTagCode` runs specs **inside an already-resolved pack.** A decoder's job
> is to pull a style, size or colorway out of a code once the brand is known.

A maker's mark carries the brand *and nothing else*. By the time a spec could
fire, its entire payload is the thing that selected the pack. There is no field
left for it to fill.

So the bar has an implicit fourth requirement that had never needed stating,
because until now every candidate that passed also carried a model: **a decoder
must recover something the pack does not already know.** Marks that only name the
maker belong in `authentication_tells`.

The same pack supplies the third instance of a different shape, which is now
frequent enough to name: **stamped, perfectly regular, identifies nobody.**
Eyewear's `58□14 135` size triplet was the second; the metal purity hallmark
(`925`, `585`, `750`, `950`) is the third. Both are industry standards, which is
exactly what makes them useless for attribution — universality is the opposite of
brand-uniqueness.

> ⚠ **Jewelry is where "never auto-authenticate" bites hardest.** A hallmark is a
> few characters struck into soft metal and is the first thing a counterfeiter
> copies. The honest asymmetry: a wrong or missing mark is evidence *against*; a
> correct-looking one is not evidence *for*. See [[brand-kb-negative-findings]].

## What to do with a code that fails the bar

**Transcribe it, never let it recover a brand.** A PUMA six-digit number is worth
carrying into a listing verbatim — buyers search it — but it must never be the
evidence that the item *is* a PUMA.

Where a code is an ordinary English phrase, it additionally needs corroboration:
Rag & Bone's men's denim runs `Fit 1`–`Fit 4`, printed on the tag and genuinely
regular, but "Fit 2" would false-recover the brand from any tag using those two
words. Carry it into the title; require a Rag & Bone tag before treating it as
brand evidence.

## Related

- [[brand-kb-alias-refusals]] — the same false-positive logic applied to brand names
- [[brand-kb-negative-findings]] — traps recorded so they are not re-introduced
- [[brand-taxonomy-overview]] — why these rules live here and not in the database
- [[grading-scale-and-weights]] — what consumes brand identification
