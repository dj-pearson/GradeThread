---
title: Negative findings — the traps, and why absence is sometimes correct
type: contract
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00468_handbags_accessories_brand_knowledge.sql
  - services/edge-functions/src/lib/registered-numbers.ts
  - services/edge-functions/src/lib/tag-era.ts
reviewed: 2026-07-28
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
