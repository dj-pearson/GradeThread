---
title: Negative findings — the traps, and why absence is sometimes correct
type: contract
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00468_handbags_accessories_brand_knowledge.sql
  - services/edge-functions/src/lib/registered-numbers.ts
  - services/edge-functions/src/lib/tag-era.ts
  - supabase/migrations/00572_tag_eras_provenance.sql
  - supabase/migrations/00579_vintage_tee_blanks_brand_knowledge.sql
reviewed: 2026-08-09
tags: [brands, sourcing, authentication, contract]
summary: Facts that look right and are wrong, plus the statutory reason a missing RN on a handbag is correct rather than suspicious.
---

# Negative findings — the traps

A negative finding is a fact recorded **so that nobody discovers it again and
gets it wrong**. Each of these looks like a gap in the data. None of them is.

## RN 17257 is not Longchamp

The single most dangerous fact in the brand KB, and the exact shape the sourcing
policy exists to catch: **a real federal record, the right brand string, and
completely the wrong company.**

The FTC register returns exactly one hit for "longchamp":

> RN 17257 — **LONGCHAMP FABRICS CORP** — product line "Material" —
> 1412 Broadway, New York NY 10018 — a NYC garment-district **fabric wholesaler**.

The French maison's registrant would be S.A.S. Jean Cassegrain, which has **no
RN**. A scraper that searched the register for "longchamp" and took the hit would
seed an authoritative-looking lie. It is seeded as an explicit negative, and
fixtured.

## RN 13765 is real, is on the tag, and still cannot name Screen Stars

Recorded 2026-08-09 with the vintage-tee pack (`00579`, US-2220). A third RN
trap, and the first one where the number is **genuinely the brand's own tag**.

RN 13765 is a real Registered Identification Number and it is printed on Screen
Stars collar tags. It is refused anyway, because it belongs to the **parent** —
Union Underwear / Fruit of the Loom — and FOTL's *generic* 1970s blanks carry the
same RN under a completely different tag, which defunkd documents separately. A
pattern over it would spell "Screen Stars" onto an unbranded Fruit of the Loom
tee.

Hold this beside the two RN entries around it, because the three fail
differently:

| | why it fails |
|---|---|
| RN 17257 (Longchamp) | right string, **wrong company** |
| a missing RN on a handbag | **statutorily correct** absence, not a gap |
| RN 13765 (Screen Stars) | right company, **wrong granularity** — it names the parent |

The third is [[brand-kb-decoder-bar]]'s fourth question in RN form: *which entity
does the identifier name?* A parent-wide identifier can never attribute a
sibling, whether it is URBN's `OB######` style number or Fruit of the Loom's RN.

> The category's other refusals are absences with reasons, not gaps: **no size
> chart**, because four decades of washing destroyed the precision an alpha size
> once had — measure the garment; and **no `brand_styles` rows** for Brockum,
> Giant and Winterland, because a blank maker has no model identity. On a band
> tee the model is the *band and the print*, which live on the item. That is the
> Gildan/Hanes call in its sharpest form.

### ⚠ And the category grades backwards

Not a sourcing trap, but it belongs with them because it is the same kind of
mistake — confidently applying a rule that does not hold here.

Screen Stars blanks are 50/50 cotton-poly. Washing fades the cotton and spares
the polyester, producing the thin, translucent, feather-soft shirt the category
is bought **for**. Collectors pay a premium for precisely the state a condition
rubric marks down.

**A vintage tee graded on crispness reads a 9 as a 4.** The real defects are
holes, stains, a print flaked to illegibility, and a collar with no recovery
left. This is the Bosca patina call ([[small-leather-goods]]) with much higher
stakes, because here it is not one line of the grade — it is most of it.

## A missing RN on a handbag is correct, not a red flag

Earlier packs recorded "no RN — the FTC database is a JS shell that returns
nothing to automation." That is an **access** excuse. For bags the real reason is
**statutory**:

An RN is issued to firms handling products covered by the Textile / Wool / Fur
Acts, and the FTC excludes textiles used in **handbags and luggage** from textile
labeling unless a fiber claim is made. **A leather handbag is not a covered
product, so there is no RN to find.**

The exemption is proven by its own exception: Marc Jacobs is the only brand in
the handbag pack with a sourced RN, and it has one *because it sells
ready-to-wear*. **The RN lives where the textile lives. It is not on the bag.**

Absence here must never be read as suspicious.

## The RN cross-check exists, and it will almost always say "no reference"

Added 2026-07-28 (US-2211), because the mechanism and the data will be discovered
at different times and the gap between them reads like a bug.

`registered-numbers.ts` now compares a transcribed RN/CA against
`brand_knowledge.registered_numbers` and classifies the result. **Exactly six
brands in the corpus carry a seeded number** — Alo Yoga, Zara, Urban Outfitters
(shared), Lucky Brand, and the handbag pack's Marc Jacobs pair. Every other pack
omitted them deliberately as unsourced.

So the overwhelmingly normal outcome is `no_reference`, and the code models it as
a **distinct outcome from `contradicts`** for that reason. Collapsing the two —
treating "we have no reference" as "this RN is wrong" — would turn the emptiest
column in the KB into a fake fraud signal on almost every graded garment.

The three sections above are why the column is nearly empty, and none of them is
fixable by trying harder: the FTC register is auth-gated to automation, most
circulating RNs trace only to eBay listing text (00467 refuses Vineyard Vines'
and Brooks Brothers' on exactly that ground), and for handbags there is
**statutorily no RN to find**. Seeding more is a sourcing problem, not a scraping
one.

Two further rules the checker encodes, both from the corpus:

- **An RN names a registrant, not a brand.** URBN's RN 66170 covers Urban
  Outfitters, Anthropologie *and* Free People, so a match is `ambiguous` —
  consistent with the item, unable to pick between siblings.
- **An RN never mints or rewrites a brand.** It is public, a counterfeit prints
  it too, and the assessment deliberately has no `resolvedBrand` field — a test
  pins the returned key set so one cannot be added by accident.

## tag_eras is two different things in one column

Added 2026-07-28 (US-2212), when the column got its first consumer.

`brand_knowledge.tag_eras` is documented as tag/label generations for dating. In
practice it holds **220 entries across 32 packs, and only ~174 can date
anything.** The rest carry `years: "all"`, `"current"` or `"ongoing"` — Nike's
`style-number` entry, adidas's `article-number` entry, Ralph Lauren's `label`
entry. Those describe a code FORMAT that has never changed. That is real, useful
knowledge and it is **not dating evidence**.

Nothing is wrong with the rows; the column simply absorbed both kinds of fact
because there was nowhere else to put the format notes. But a consumer that
offers them as datable eras invites a confident *"this is from the all era"*, so
`tag-era.ts:datingEras()` filters on whether `years` names a year or a decade and
only the survivors are ever shown or matchable.

**There is no per-entry provenance.** `source_url`, `confidence` and `verified`
live on the brand ROW, so a single unsourced era inside an otherwise-verified
brand is indistinguishable from a sourced one. Dating claims are the highest-
liability content in the KB — era is the price in vintage — so this is the gap to
close before any era reaches a public certificate. Adding per-entry sourcing
means a schema change, not a data pass, which is why US-2212 did not close it.

## A style code is not on a bag — it left with the hangtag

In apparel the code is printed on the sewn care label, which is why cut-tag
decoders work. A bag has no care label; its code lives on a **removable paper
hangtag** or only in the web catalogue, and hangtags come off before resale.

This is checkable against the KB rather than merely asserted: Coach **sews** a
creed patch carrying the style number into the bag, and got a decoder. A bag
*can* carry a code. Most simply do not.

## Folklore that survives repetition

- **Johnnie-O has no "hangover collar".** It is not a snap and it is not on the
  collar — all three are folklore. The real mechanism is patented (US 9,538,791B2,
  "shirt garment with hidden button") and trademarked (TWEENER BUTTON): a smaller
  intermediate button concealed inside a fly-front placket segment. It is
  **invisible in a photo by design** — concealment is the patent's purpose — so it
  is positive-evidence-only. Seeing it is a weak positive; *not* seeing it means
  nothing. Seeding it as a visual fingerprint would produce confident false
  negatives on genuine garments. It is also absent from the original 4-button
  polo, the very product it is assumed to define.
- **Quilting is no longer definitional for the Tory Burch Edie.** The line is
  described as "distinguished by the quilted leather chevron pattern", but the
  current Edie Medium Crossbody is woven straw with no quilting. A quilt-based
  rule produces false negatives on current stock. Grade to brand, not to style.

## Two rules that recur across the whole corpus

**Never auto-authenticate.** Where no serial or published authentication standard
exists — PUMA, Reebok, Rag & Bone, and most of the KB — grade condition only and
route authenticity to human review. Canada Goose is explicit: the holographic
disc is reproduced by fakes and is a manufacturer-side device we cannot verify,
so **the hologram is not proof**.

**A shared corporate parent is not a counterfeit signal.** Moncler owns Stone
Island. PUMA and adidas were founded by the Dassler brothers in the same town —
seventy-seven years of shared ancestry, not a copy — though their comps must
never be mixed. 7 For All Mankind's co-founder went on to found Citizens of
Humanity, which is why their pocket arcs resemble each other.

## Related

- [[brand-kb-decoder-bar]] — why most codes are refused
- [[brand-kb-alias-refusals]] — the same reasoning applied to names
- [[brand-taxonomy-overview]]

## An era we cannot cite is invention — and enforcing that needed NOT VALID

**Added 2026-08-09 (US-2212 AC5).** `brand_knowledge` carries `source_url`,
`confidence` and `verified` on the **row**. `tag_eras` is a jsonb array of
entries. So an uncited era sitting inside an otherwise-verified brand was
indistinguishable from a cited one — and era **is** the price on a vintage
piece, which makes it the highest-liability content in the whole knowledge base.

The registered-number work already settled the principle: an RN we cannot cite
is invention, which is why 00457 and 00458 **omit** RNs rather than seed them
unsourced. A decade is no different.

### The rule is enforced on new content and not retroactively, on purpose

All ~220 seeded entries predate this and carry no per-entry provenance. A plain
`CHECK` refuses to apply against them, so shipping one would have meant
fabricating sources — the exact thing the rule prevents — or deleting curated
knowledge that is still **useful as prompt reference** even when it cannot be
published.

`brand_knowledge_tag_eras_sourced` is therefore `NOT VALID`: every INSERT and
UPDATE from now on must cite a datable era, and the legacy rows stay readable
and stay honestly marked. The backfill is done when this succeeds:

```sql
ALTER TABLE public.brand_knowledge VALIDATE CONSTRAINT brand_knowledge_tag_eras_sourced;
```

### Reference and claim are different liabilities

This is the split that made the rule shippable instead of a switch that turns
the feature off. AC5's words are about *"an unsourced era claim on a public
certificate"* — a statement about what we **publish**, not about what the model
may **read**.

| | uncited era | cited era |
|---|---|---|
| rendered into the tag-OCR reference block | **yes** | yes |
| matched, and used for the era-vs-decoder consistency flag | **yes** | yes |
| persisted and surfaced as a dating claim | **no** | yes |

`datingEras()` is the reference list; `claimableEras()` is the publishable
subset; `matchTagEra()` returns `sourced: false` rather than dropping the
match, so the caller decides knowingly. Dropping it would have silently disabled
the consistency check on every legacy entry — a different feature switched off
by a change about publishing.

### Format notes are exempt, and that is not a loophole

The column carries two kinds of fact. Roughly 174 of the 220 entries can date a
garment; the rest have `years` of `all` / `current` / `ongoing` and describe a
code **format** that never changed (Nike style-number, adidas article-number,
Ralph Lauren label). A format note makes no dating claim and has nothing to
cite, so requiring a source on one would push an author to invent a URL for a
true statement. Both the constraint and `datingEras()` test whether `years`
names a year or a decade.

### Postgres will not take a subquery in a CHECK

Worth knowing before writing the next one of these. Walking a jsonb array means
`jsonb_array_elements` inside `NOT EXISTS`, which is a subquery, and a `CHECK`
rejects it with `0A000`. The predicate lives in an `IMMUTABLE` function
(`public.tag_eras_all_sourced`) that the constraint calls. The first draft did
it inline and the `db` verify lane caught it on a from-zero re-apply.
