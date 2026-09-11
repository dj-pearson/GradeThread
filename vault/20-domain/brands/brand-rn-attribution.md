---
title: Attributing an RN to a brand — the tests, in the order they were learned
aliases: [RN attribution, registered number rules, FTC register, substring trap, vintage rule]
type: contract
status: current
source_of_truth: vault
code_refs:
  - supabase/migrations/00730_peter_millar_registrant_and_era_source.sql
  - supabase/migrations/00741_fifteen_more_brands.sql
  - supabase/migrations/00742_nineteen_more_brands.sql
  - supabase/migrations/00743_heritage_and_workwear_brands.sql
  - supabase/migrations/00744_womenswear_swim_and_wool_brands.sql
  - supabase/migrations/00746_outdoor_running_and_kids_brands.sql
  - supabase/migrations/00747_skate_surf_and_streetwear_brands.sql
  - supabase/migrations/00748_workwear_sleepwear_and_sport_brands.sql
  - supabase/migrations/00749_outdoor_field_and_formal_brands.sql
  - supabase/migrations/00750_sleep_baby_and_hosiery_brands.sql
  - supabase/migrations/00751_running_intimates_and_bag_brands.sql
  - supabase/migrations/00752_dtc_womenswear_and_training_brands.sql
  - supabase/migrations/00753_snow_surf_and_bike_brands.sql
  - supabase/migrations/00754_golf_denim_and_british_menswear_brands.sql
  - supabase/migrations/00755_merino_cashmere_and_slow_fashion_brands.sql
  - supabase/migrations/00757_registered_numbers_for_held_brands.sql
  - supabase/migrations/00761_brands_whose_feeds_refused_us.sql
  - scripts/ops/ftc-rn-lookup.mjs
  - services/edge-functions/src/lib/registered-numbers.ts
reviewed: 2026-09-10
tags: [brands, provenance, authentication, rn, contract]
summary: The FTC register matches on substring, so a hit that looks perfect is not evidence — eight accept/refuse tests were built across fifteen brand packs, and the newest one (an RN cannot predate its holder) is the only one that can choose between two equally good names.
---

# Attributing an RN to a brand

A Registered Identification Number is printed on a garment's care label and is
the closest thing to a public maker's mark that US textile law produces. It is
also the single easiest fact in this project to get confidently wrong, because
**`https://www.ftc.gov/rn-database/search` matches on SUBSTRING**. "Roxy" returns
`P-ROXY- APPAREL`, `ROXY RUG CORP`, `ROXY HOSIERY` and `RoxyNell llc`, for a
brand that holds no registration at all.

So the register never answers "which RN is this brand's". It answers "which
registrant strings contain these characters", and everything below is the work of
turning the second into the first.

The specific traps already caught live in [[brand-kb-negative-findings]] — RN
17257 is not Longchamp, RN 13765 names Fruit of the Loom rather than Screen
Stars, and a handbag has no RN to find. **This note is the procedure; that note
is the casebook.** The rules were built one pack at a time from `00741` through
`00761`, each refusal argued in the header of the migration that made it.

## The eight tests

### 1. The name test is the rule

The registrant must keep the label's **distinctive tokens**. Adding purely
generic trade words is fine: Inc, LLC, Ltd, Corp, Group, USA, North America,
Apparel. `Fair Harbor Clothing Inc`, `KATIN USA, INC.`, `MISSION WORKSHOP, LLC`,
`TEREZ UNIVERSE LLC` all pass on the string alone. So do founder initials, which
are an addition rather than a swap: `JP BODEN USA LLC` for Boden, `C. C. FILSON`
for Filson.

**Replacing a distinctive token fails**, however good the rest looks. Ingrid &
Isabel returns `URSULA INGRID CARNEY`, whose product line reads MATERNITY
BODYWEAR — precisely what the label invented — and it is refused, because
"Isabel" is not there.

`00757` splits the acceptances into two tiers and the split is load-bearing:

- **Tier A** — defensible from the registrant string alone. 66 of the 80 brands
  it seeded.
- **Tier B** — accepted using knowledge of the company's **legal name**, which
  the string does not establish. 14 brands, listed by name in that header so a
  reader can audit exactly those and no others: Burberry, Coach, Dior, Dr.
  Martens, Filson, Hollister, Kith, Madewell, Mammut, Marmot, Nautica, New
  Balance, Pendleton, The Children's Place.

A tier-B row is not a guess, but it is a weaker claim, and collapsing the two
would hide that.

### 2. A product line breaks a TIE. It never stands in for a name

This is the distinction the whole set rests on.

Where several registrants share a name, the product line picks the one in the
business: "Hurley" returns six, five of them people, and `HURLEY INTERNATIONAL
LLC` is the only company and the only SPORTSWEAR entry. "Noah" returns nineteen,
and `NOAH CLOTHING LLC` wins because the nearest rival lists no product line at
all and so cannot enter a tie-break. "Simms" returns five sharing the surname and
only `SIMMS FISHING PRODUCTS CORPORATION` is in the business.

Where the name does **not** match, a perfect product line changes nothing.
Billabong returns `BURLEIGH POINT, LTD.` with "MEN'S WOMEN'S AND CHILDREN'S SURF
LIFESTYLE APPAREL", which is very probably the operating company, and it is
refused. Same answer for Smartwool (`VF OUTDOOR, LLC`), Eberjey (`WORLD THREADS
INC`, product line LINGERIE SLEEPWEAR SWIMWEAR), BRUNT Workwear, Dovetail
Workwear, Truewerk, POPFLEX, Club Ride, Mountain Khakis, Devereux and Straight
Down.

### 3. An exact name is not enough when the business is wrong

Monos (`00749`) and BEIS (`00750`) each return an exact-name registrant with a
broad women's-apparel product line. Both make **luggage**. Both refused.

Hold that against `CINCH, LLC` in `00748`, which was **accepted** on a product
line that also disagreed — WOMEN'S ACTIVEWEAR for a western menswear denim house
— and the difference is the size of the gap. Register product lines are often
narrow or stale, so a mismatch *inside* apparel is a narrowing. A mismatch that
crosses industries is not: a luggage maker has no reason to register women's
apparel.

`00752` sharpened it once more with POSSE, an Australian womenswear label whose
only exact match lists Men's apparel. Men's-only for a womenswear-only label is
not a narrowing, it is a contradiction.

### 4. The vintage rule: an RN cannot predate its holder

Written down in `00750` and the most useful thing this loop produced.

RNs are issued in sequence and are not reused, so a number issued long before a
company existed belongs to an older namesake. Sheertex (founded 2017) returns
`RN 14756 SHEERTEX HOSIERY MILL INC` — exact name, exact industry — and the
number refuses it.

The anchors are **measured across this corpus**, not read off a published
issue-date table:

| RN | holder |
|---:|---|
| 16045 | Rockmount |
| 29685 | Pendleton |
| 39126 | Filson |
| 94974 | Stussy |
| 99458 | Brooks Brothers |
| 150833 | Kyte Baby |
| 172568 | Cozy Earth |
| 177847 | Hill House Home (the highest this corpus has seen) |

The sequence tracks when a company **registered**, not when it was founded —
Brooks Brothers dates from 1818 and sits high, Rockmount from 1946 and sits low.
Only the one-way direction is safe. **This is a check to APPLY, not a fact to
cite.**

It paid immediately. `00751` refused Altra's `RN 73198 ALTRA CORP., INC.`, an
exact name plus a generic word that every other test on this list would have
passed. `00761` refused norda twice over on independent grounds. And `00754` used
it for the harder job — **choosing between two hits rather than rejecting one**.
Fair Harbor returns `RN 155448 Fair Harbor Clothing Inc` and `RN 72499 FAIR
HARBOR SPORTSWEAR, INC.`; both keep the label, both add only a generic word, and
on the name test alone the honest answer is to refuse both. 72499 sits below
Stussy's 94974 and so predates a brand founded in 2014.

### 5. Two equally good candidates and no discriminator means refuse

Not too few, too many. `PRIMITIVE, INC.` (hats, jackets, pants) and `Primitive
Company` (unisex, men's, women's, children's apparel) both pass the name test and
neither product line rules the other out. Parachute returns five Parachute
companies and none is the bedding brand. Picking either would be a coin flip
wearing a citation.

### 6. A parent's ownership is not evidence; the registrant STRING is

`00755` settled a question `00748` left looking over-strict. VF Outdoor owns both
Smartwool and Icebreaker. It registered one as bare `VF OUTDOOR, LLC` and the
other as `Icebreaker, A Division of VF Outdoor LLC`. Smartwool is refused,
Icebreaker accepted, and the rule reaches both answers without knowing anything
about VF: **keep the ones that name the label, refuse the ones that do not.**

### 7. A founder's registration is usable only when the founder's name is the brand

Ulla Johnson was accepted in `00749` — registrant `ULLA VASILIA JOHNSON`, product
line LADIES GARMENTS. A middle name the label drops is an addition, and the label
*is* the person.

`00753` refused three that look identical in shape: SHREDLY (`ASHLEY RANKIN`),
Coal (`BRAD SCHEUFFELE`) and Birdwell (`HEATHER DENISE BIRDWELL`). Each is a
natural person registering for exactly the goods the brand makes. None of their
names appears in the brand's. Birdwell is the close one — the surname *is* the
label — but Birdwell Beach Britches was founded by Carrie Birdwell Mann, so a
different Birdwell registering for generic "CLOTHING" is a namesake until
something says otherwise.

### 8. A brand may legitimately hold two numbers, and both are kept

Dakine (`RN 91245` and `RN 163341`), Jetty (`115296`, `158050`) and Icebreaker
(`152785` pre-acquisition, `159200` post) are each one company registered twice,
decades apart — which is exactly what the sequence in test 4 predicts for an old
brand that re-registered. A garment can carry either number, so the KB has to
hold both. This is not the ambiguity of test 5, where two *different* companies
fit.

## An absent RN says something about age and supply chain, not legitimacy

`00752` is the clearest measurement. Heritage and outdoor batches returned
numbers for roughly half the brands. That batch was social-first DTC labels, most
founded after 2015, and the hit rate collapsed to **two of seventeen** — thirteen
returned nothing at all. `00754` found the same thing from another angle: seven
of its nine no-result brands are British or Australian, and a label that does not
manufacture for the US market has no reason to hold a US registered number.

Read a missing RN as a fact about the brand's history, never as a doubt about the
brand.

Across `00757`'s 170-brand sweep the split was 80 accepted (91 numbers) and 86
refused, of which **33 returned nothing at all**. Most of the rest were
one-word brand names, which are close to unusable in a substring register: Lee,
Express, Jordan, Brooks, Celine, Chanel, Columbia, Mother, Paige, Palace, Pink,
Supreme and Theory all return a page of unrelated companies containing the word.

## Two independent sources meeting from opposite directions is the strongest case

`00730` is the pattern worth copying. `00467` had seeded Peter Millar's RN 100308
from an aside in the **brand's own shipping FAQ** and said plainly that the FTC
registrant could not be confirmed. Searching the register by **number** returns
`RN 100308 CHESTER GREGG, L.L.C. [KNIT SHIRTS]` — a knit-polo registrant for a
knit-polo house. Neither source was derived from the other.

It still does not name the brand. `CHESTER GREGG, L.L.C.` is the registrant, and
the standing rule holds unchanged: **an RN corroborates, it never proves, and a
counterfeit prints it too.** `registered-numbers.ts` encodes that by having no
`resolvedBrand` field at all.

Searching by number also works where searching by name does not: `search=Peter
Millar` returns nothing while `search=100308` answers.

## Record the register's own oddities as seen

Do not tidy them, and do not treat them as a reason to refuse:

- `APPARELL` — the register's spelling, in Hunter Bell's entry (`00761`).
- `SYS_LIST_PROD` — a database placeholder printed where AFTCO's product line
  belongs (`00749`).
- `Stateside Merchancts, LLC` — the register's own typo (`00748`).
- `Towels / Washcloths / Dishcloths` for Picture Organic, a ski and snowboard
  brand whose registrant is plainly the company (`00753`).

## Writing an RN trips a constraint about something else

`brand_knowledge_tag_eras_sourced` is NOT VALID, so it never inspected existing
rows — but Postgres checks any row an UPDATE touches. Adding a registered number
to a brand seeded in 2026-07 therefore fails on a constraint about tag eras.
`00748` hit it with two rows, `00757` with eighty, and `00730` could not touch
Peter Millar at all until its one datable era was sourced. All three carried a
provenance fix they were not otherwise about. See [[brand-kb-provenance]] for the
constraint itself and for the state it is in now.

## Related

- [[brand-kb-negative-findings]] — the traps themselves, and why absence is sometimes correct
- [[brand-kb-provenance]] — the source_url and confidence rules every seeded number must satisfy
- [[brand-colorway-harvest]] — the other half of what these same fifteen packs seeded
- [[brand-taxonomy-overview]] — the value/rule split these notes exist to hold
- [[INDEX]]
