---
title: Clothing condition grading and authentication landscape
type: reference
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-09-08
tags: [competitors, grading, authentication, condition]
summary: Who grades garments (nobody per item), what authentication costs, every marketplace's exact condition wording with a proposed 1-10 band, and what buyers and sellers say about condition disputes.
---

> Research snapshot taken 2026-09-08 for [[competitor-landscape-2026-09]]. Prices, ratings and quotes are as fetched that day; anything marked "(unverified)" could not be confirmed from a primary source.

# Clothing condition grading and authentication landscape

Research date: 2026-09-08. External research only; nothing in the GradeThread repo was read or changed.
Method: 28 web searches (the session's search budget ran out after that) and 40+ page fetches, of which
about 20 returned usable content. Reddit is blocked from direct fetch in this environment, so the
"what people say" section leans on Mumsnet, MoneySavingExpert, eBay Community, Trustpilot and reseller
blogs that quote Reddit. Everything not confirmed on a fetched page is marked (unverified).

Bottom line up front: nobody sells a numeric, factor-weighted, shareable condition GRADE for a single
garment to an individual reseller. The field splits into (a) B2B AI sorting/grading for bulk secondhand
supply chains (Fleek, Recloth), (b) marketplace-owned 3-5 tier condition labels that sellers self-assign
and that buyers do not trust, and (c) authentication services that certify REAL vs FAKE and explicitly do
not certify condition. The card and sneaker analogs (PSA, StockX) show that a numeric grade plus a
verifiable certificate moves price and reduces disputes, but both require physical custody of the item.

---

## 1. Who does AI or third-party condition grading for clothing

### Direct competitors / adjacent AI grading

| Company | What it grades | Customer | Scale / money | Grade output | Source |
|---|---|---|---|---|---|
| Fleek (London, YC) | "Fleek Sort", a vision-language model that "identifies, categorises, grades and merchandises secondhand garments from a photograph or video" | B2B: wholesale graders and sorting hubs (Pakistan, India, Dubai); pilots in UK/EU/US. Fleek says its supply chain feeds Vinted, Depop and Whatnot sellers | $25M Series B July 2026 led by Burda Principal Investments with eBay Ventures, FJ Labs, H14, a16z, HV Capital, YC; $45M total. 2,000+ suppliers, 50,000+ buyers, 100+ countries. Frames the market as 24 billion garments/year, $200B+ | Wholesale bale grades (A/B/C style), no per-item consumer grade published | thenextweb.com, fortune.com, techfundingnews.com |
| Recloth.io (Warsaw) | "AI instantly identifies brand, type, condition, and estimated value"; generates listing in ~20 s; up to 500 items/hour for businesses | Both consumers ("digital wardrobe") and businesses; publishes to OLX and Allegro (Poland) | 100,000+ garments/year claim; Masters & Robots Award 2026. No pricing shown | Condition label inside a listing; no scale published | recloth.io |
| EcoGrading (beta 2024) | Model "trained on 12,000 lab-tested garments" weighting durability factors | Unknown | (unverified; single source is an Alibaba insights article) | Unknown | alibaba.com product-insights |
| ThredUp, Vestiaire, TheRealReal | In-house human inspection at intake; grade is a tier label plus free-text flaw notes ("minor pilling", "light fading") | Their own consignment/managed marketplaces | ThredUp Athleta Preloved standard: "no signs of wear (pilling, shrinkage, fading), no damage (missing parts, rips, stains, odors), and no alterations" | Tier labels only, not numeric | athleta.thredup.com FAQ, therealreal.com/faq |

Nobody in this list issues a portable, shareable per-garment certificate that a seller can attach to an
eBay/Poshmark listing. The B2B graders (Fleek, Recloth) grade for the supply-chain owner, not for the
end buyer. Companies the brief asked about that I could not confirm are doing CONDITION grading:
Archive, Trove, Recurate, Reflaunt, Rebelle (all resale-as-a-service / brand-owned resale
infrastructure; they inspect at intake but publish tier labels, not grades) (unverified).

### The analogs resellers already trust

- Trading cards (PSA / CGC / Beckett): a numeric 1-10 grade with sub-grades, a tamper-evident slab, a
  cert number and an online lookup. PSA's cheapest tiers were in the $20-25 per card range with a
  declared-value cap around $500 and turnaround of weeks; higher tiers price on declared value
  (unverified: psacard.com/pricing returned 403). The lesson is not the price, it is that the grade is
  ISSUED BY A THIRD PARTY WITH THE ITEM IN HAND, has a public registry, and that a 9 vs a 10 changes price
  by multiples.
- Sneakers (StockX): "Every item on StockX must be in new condition and never worn." StockX has
  "inspected over 60 million items" and "rejected over 1.4 million items valued at more than $400 million".
  The output is a green tag with a QR code linking to the product's details. It is a pass/fail
  authenticity-plus-newness gate, not a condition grade. GOAT does accept used sneakers with its own
  condition tiers (unverified; not fetched).
- eBay Authenticity Guarantee (sneakers): "From sole to stitching, our team of authenticators will perform
  a multi-point physical inspection to ensure your items are authentic and match the listing." Threshold
  $75 for sneakers, $500+ for eligible shoes in Men's/Women's; free to buyer and seller; verified "within
  two business days" of arrival; buyer gets an "eBay Authenticity Guarantee QR tag" that shows the
  authenticity report. Streetwear/apparel has a separate AG program (search snippets said $200+
  threshold; unverified on the fetched page).

Takeaway: every trusted analog is custody-based. A photo-only grade has to earn trust a different way:
consistency (same photos -> same grade), transparency (factor breakdown), and a public verify URL.

---

## 2. Authentication services resellers use

| Service | Price | Turnaround | Certificate | Guarantee / accuracy | Marketing angle | Source |
|---|---|---|---|---|---|---|
| Entrupy | Subscription only. Petit $139/mo (25 tokens) or $1,499/yr (300); Moyen $599/mo (125) or $6,469/yr; Grand $1,049/mo (250) or $11,329/yr; per token $3.78-$5.60. Tokens shared across bags, footwear, apparel. Hermes is Premium at $119/auth, 24 h (search snippet) | "Typically within minutes" for apparel; Hermes 24 h | "Entrupy Certificate of Authenticity"; Enterprise gets "unlimited Letters of Evidence" that are "accepted by major resale platforms" | "100% financial-backed" for a full year; apparel page claims 99.86% accuracy. Result is "Authentic" or "Unidentified" (never "fake") | B2B: "AI evaluates the highly-magnified images against millions of records". 40+ apparel brands incl. Supreme, BAPE, Off-White, Nike, Canada Goose, The North Face. Search snippet: moved to device-free authentication from May 18, 2026 (unverified) | entrupy.com/pricing, /apparel-authentication |
| Legit App | Luxury handbags/clothes/shoes/accessories from $10; Hermes $20; watches $15; sneakers $3; streetwear/collectibles/cosmetics $4. Speed pricing: clothes 3 h $10, 1.5 h $15, 30 min $20; sneakers 30 min $3, 10 min $5 | 10 min to 12 h | "FREE certificate of authenticity", described as tamper-proof and usable "to safeguard purchases against fraudulent claims on PayPal, eBay, and credit cards" | "Financial Guarantee"; "two or more expert authenticators" plus AI | Consumer/prosumer app; merchant discounts 25% at $500+ spend, 30% at $2,500+, custom at 2,000+ items/month | legitapp.com/pricing |
| LegitGrails | Clothing $15-$50; example Balenciaga hoodie $35 for 30 min or $15 for 12 h | 30 min, 2 h, 6 h, 12 h | "unique certificate of authenticity" emailed, verifiable on a portal | "refund guarantee"; "2 to 4 professional authenticators" | Streetwear/hype focus | legitgrails.com |
| Real Authentication | "$20 and up depending on the brand and if a certificate is needed"; certificates +$10, physical card +$10; 1 h expedite +$30, 12 h +$20 | 24 h standard, 1 h expedited (10am-8pm PST) | Digital or mailed physical card | Two or more authenticators plus AI QA; REAL+ volume tiers up to 30% off | Luxury handbags, sneakers, watches, jewelry | realauthentication.com (search snippet), verifyluxenow.com |
| eBay Authenticity Guarantee | Free to buyer and seller above threshold; UK from end of April 2026 sells it as a GBP 20 add-on for items under GBP 200 (search snippet, unverified) | 2 business days at facility | QR tag on item, online report | eBay-backed | Marketplace-integrated, custody-based | ebay.com/authenticity-guarantee/sneakers |
| Poshmark Posh Authenticate | Free for orders "$500 or higher"; all categories except Electronics, Home, Pets, Toys, Games | "1-3 business days once the item arrives at Poshmark" | None specified; buyer sees status on order tracking | If not verified, "the order is cancelled and a full refund will be immediately processed" | Authenticity only: experts examine "logos, tags, and overall quality to confirm the item matches the listing" | poshmark.com/posh_authenticate |
| StockX | Seller fee model (no separate auth fee) | At verification center before ship | Green tag with QR | Pass/fail; new-only | "Verified" brand | stockx.com/about/our-process |
| Whatnot | Luxury bags pre-authentication program (Entrupy-based per search snippet; page 403) | (unverified) | (unverified) | (unverified) | Live-selling | help.whatnot.com |
| Others in the verifyluxenow roundup | Lollipuff ~$25 base, cert ~$50 ($75 Hermes); Authentic Detective $7-$90 with QR-coded digital cert; TuSee from $0.99 "instant"; Zekos $50+ with "lifetime warranty on certificates" | 24-72 h typical | Digital, some with QR | Varies | Long tail | verifyluxenow.com |

Patterns that matter for a grading certificate:
- Price anchor for a per-item, photo-based expert opinion on CLOTHING is $10-$20 (Legit App, LegitGrails,
  Real Authentication). Sneaker/streetwear opinions are $3-$5. Entrupy's B2B token is ~$4-$6.
- Turnaround is sold as a tier: 30 min / 3 h / 12 h with a 2x price spread. Speed is a paid feature.
- Every service ships a free digital certificate with a verify URL; two charge extra for a physical card
  ($10). Certificates are marketed as DISPUTE ARMOR ("safeguard purchases against fraudulent claims on
  PayPal, eBay"), not as a sales tool.
- Every service says "two or more experts plus AI". None sells AI-only. The human-in-the-loop is the trust
  claim; GradeThread's confidence < 0.75 -> human review maps onto this convention.
- None of them grades condition. Poshmark's page says authenticity only. eBay AG checks that condition
  "match[es] the listing" but issues no grade. That is the open lane.

---

## 3. How each marketplace defines condition

Exact wording where fetched; paraphrase marked. Right-hand column is a proposed mapping onto
GradeThread's 1.0-10.0 scale and tier names (NWT 10 ... Poor 3-4), for the composer to use when it
pushes a listing. The mapping is my proposal, not anything any marketplace publishes.

| Marketplace | Tier (exact label) | Definition (exact where quoted) | Proposed GradeThread band |
|---|---|---|---|
| eBay (Clothing, since 4 Feb 2025; 12 clothing categories) | New with tags | "This item is brand new and has never been worn. It still has the original tags and/or original packaging" | 10.0 NWT |
| | New without tags | "This item is brand new and has never been worn, but doesn't have tags and/or is missing the original packaging." | 9.5-10.0 |
| | New with imperfections (was "New with defects") | "This item is brand new, has never been worn, but has some type of defect. New irregular items may fall into this category." | 8.0-9.0 with defect flagged |
| | Pre-owned - Excellent | "This item has been previously worn; however, it is in excellent condition. Any signs of wear should be shown and described in the seller's listing" (seller-center short form: "Like new, previously worn, but with little to no signs of wear") | 8.5-9.5 |
| | Pre-owned - Good | "This item has been gently used but is in good condition. It might have a few signs of wear, but all imperfections should be shown and described in the seller's listing" (short: "Gently used with light signs of wear and/or visible flaws") | 6.5-8.4 |
| | Pre-owned - Fair | "This item has significantly visible imperfections and signs of wear. All imperfections should be shown and described in the seller's listing" (short: "Significantly visible flaws, heavy signs of wear, and/or missing or damaged components") | 3.0-6.4 |
| Poshmark (listing field; blog definitions) | NWT | "Brand new, never worn, with the tags still attached." | 10.0 |
| | NWOT | Brand new, no tags | 9.5-10.0 |
| | Like New / Excellent Used Condition (EUC) | "Worn once or twice but has little to no signs of wear." | 8.5-9.5 |
| | Good Used Condition | "gently used, with little signs of wear" | 6.5-8.4 |
| | Very Used / Fair | Document "signs of wear, fading or discoloration" (Poshmark's listing UI offers New with tags / Like new / Good / Fair per resale guides; exact in-app labels unverified) | 3.0-6.4 |
| Mercari (help center) | New | "unworn, unaltered, and still have the original tags attached. Items should not show any signs of wear or damage." | 10.0 |
| | Like New | "worn lightly but shows no signs of damage or significant wear. These items are typically without tags." | 8.5-9.5 |
| | Good | "gently worn and may have minor flaws, such as slight pilling, stretching, minor fading, or loose threads." | 6.5-8.4 |
| | Fair | "multiple signs of wear, such as small rips, stains, fading, or heavy pilling. While still wearable, these items will have noticeable flaws." | 5.0-6.4 |
| | Poor | "heavily worn, with major flaws such as large holes, heavy stains, or significant fading. These items may still be wearable for casual use or repurposing." Sold as-is, returns generally not accepted | 3.0-4.9 |
| Depop (Selling API enum; in-app labels are the human versions) | brand_new | "Item has never been worn or used" | 10.0 |
| | used_like_new | "Item appears unused but may have been tried on" | 9.0-9.9 |
| | used_excellent | "Item is in excellent condition with minimal signs of wear" | 8.0-8.9 |
| | used_good | "Item shows some wear but remains in good condition" | 6.5-7.9 |
| | used_fair | "Item has noticeable wear and imperfections" | 3.0-6.4 |
| | (dispute standard) | "significantly not as described" = "significantly different compared to the photos or description used in the original listing" | n/a |
| Vinted (help page; clothing uses the first five) | New with tags | "A brand-new, unused, and unopened item in its original condition, with all its original packaging and accessories" | 10.0 |
| | New without tags / Like new | "A brand-new, unused item in its original condition, either opened or without its original packaging" | 9.5-10.0 |
| | Very good | "A gently-used item in excellent condition, with minor imperfections that don't affect its overall appearance or use" | 8.0-9.4 |
| | Good | "A regularly-used item in good condition that shows wear, but still works well for its intended purpose" | 6.5-7.9 |
| | Satisfactory | "A well-used item that shows clear signs of wear and imperfections, but still works as intended" | 3.0-6.4 |
| Grailed (filter labels seen on seller profiles; help page 403) | New/Never Worn | (no published definition found) | 9.5-10.0 |
| | Gently Used | (no published definition found) | 7.5-9.4 |
| | Used | (no published definition found) | 5.5-7.4 |
| | Very Worn | (no published definition found) | 3.0-5.4 |
| TheRealReal (FAQ, consignment; TRR grades, not the seller) | Pristine | New, original condition, may include tags/dustbag/box | 10.0 |
| | Excellent | Like new or gently worn; "may have been tried on or lightly worn, but are in great condition" | 8.5-9.5 |
| | Very Good | "show minor sign(s) of wear ... Clothing and shoes may show wear such as light markings or fading" | 7.0-8.4 |
| | Good | "show moderate sign(s) of wear" | 5.5-6.9 |
| | Fair (added 2022) | "heavy sign(s) of wear. Items must be clean and wearable ... Clothing may show wear such as seam splitting or missing embellishments." Fair items price ~33% below higher grades | 3.0-5.4 |
| ThredUp (in-house grading) | New With Tags | Tags attached | 10.0 |
| | Like New | "no signs of wear (pilling, shrinkage, fading), no damage (missing parts, rips, stains, odors), and no alterations" | 9.0-9.9 |
| | Gently Used | "limited signs of wear, including pilling, fading and shrinkage, with no damage, such as missing parts, rips, stains or odors" plus item-level notes like "minor pilling" (from search snippets; ThredUp's own help page not fetched, unverified) | 7.0-8.9 |
| Vestiaire Collective | Never worn with tag / Never worn / Very good / Good / Fair (unverified; not fetched) | | same bands as Vinted |
| Whatnot | Free text; no structured tier for clothing (unverified) | | |

Three things the table shows:
1. Every scale is 3-5 buckets and every bucket boundary is a phrase ("a few signs of wear" vs
   "significantly visible"). A 0.1-step numeric grade can be projected onto all of them with one lookup
   table per marketplace, and the factor report supplies the "shown and described" text eBay demands.
2. Odor is named only by ThredUp and Poshmark's blog. Structural (seam splitting) is named only by TRR.
   GradeThread's five factors are richer than any marketplace field, which is the wedge: the grade can
   FILL the free-text condition box, not just pick the dropdown.
3. eBay auto-migrated every existing "Pre-owned" clothing listing to "Pre-owned - Good" on 4 Feb 2025.
   Millions of listings therefore carry a default tier the seller never chose. eBay's own stated reason
   for the tiers was to "reduce returns due to condition-related issues" and it offered free return
   labels through 15 April 2025 in case INAD rates rose.

---

## 4. What resellers and buyers say about condition disputes

Reddit could not be fetched directly (blocked host) and the search engine did not surface Reddit threads,
so the quotes below come from Mumsnet, MoneySavingExpert, eBay Community, Trustpilot and reseller blogs
that quote Reddit. All quotes are verbatim from fetched pages unless marked.

### Buyers do not trust seller-chosen tiers

Mumsnet, "To be annoyed with vinted sellers choice of condition"
(https://www.mumsnet.com/talk/am_i_being_unreasonable/4719642-to-be-annoyed-with-vinted-sellers-choice-of-condition):
- Blinkingheckythump (OP): "surely 'satisfactory' is for anything marked, 'good' for faded or bobbled, very good for well very good condition"
- SavoirFlair: "90% of sellers will post their stuff as 'good' or better to obtain the best price!"
- mummyp1gs: "most people tend to only search for the very good option, so people just list those items to flog"
- Lamentations: "The Vinted description of 'good' for sellers means it has wear and tear but that won't necessarily be clear to buyers"
- FuckoffeeBeforeCoffee: "I bought three 'good condition' items from one seller. One Item was covered in felt tip pen marks and another had holes"
- xyzandabc: "I don't expect good to be in excellent condition. I'd expect good condition items to probably only be suitable for messy play"

MoneySavingExpert, "Vinted descriptions" (https://forums.moneysavingexpert.com/discussion/6505462/vinted-descriptions):
- rose_sparky: "Twice today I've seen items described as 'new without tags' and then go on to say only worn for a few hours."
- soolin: "I agree that new means new, not worn once or washed - I would actively avoid any seller that mis described items."
- Pollycat: "It's annoying - and dishonest (imho). But at least Vinted do give you pointers how to describe the condition of an item."

EcommerceBytes reader ZZ on eBay's new tiers (https://www.ecommercebytes.com/2025/01/27/ebay-seeks-to-differentiate-gently-used-clothing/):
- "They have used this system for ever for video games, and most of the classifications are done inaccurately by the sellers and nobody enforces it."
- "Buyers generally don't trust eBay sellers anyways, and thus new items outsell used by a wide margin."

### Sellers feel INAD (item not as described) is unwinnable

eBay Community, "Buyer made several contradicting statements about item condition"
(https://community.ebay.com/t5/Returns/Buyer-made-several-contradicting-statements-about-item-condition/m-p/34296792):
- simba6: "A buyer needs no basis, only three magic words, not as described. Sellers have no say in the matter."
- mtgraves7984: "Yes, you are at a disadvantage when a buyer claims 'Not as Described'."
- (unnamed member): "It doesn't matter what the buyer is saying. Bottom line is the buyer isn't happy with the item."

Posh to Profit, "Case Opened Against You on Poshmark"
(https://www.poshtoprofit.com/blog/case-opened-against-you-on-poshmark-heres-what-to-do): seller shipped an
NWOT A&F sweatshirt; buyer posted photos claiming stains and pilling; seller attached her other listings
"to show that I don't hide things"; Poshmark approved the return anyway. Her overall rate: "In all of the
cases I've had opened against me, only four have resulted in a return. Since I've sold thousands of
items, I'd say that's a pretty decent track record!"

eBay Community advice surfaced in search snippets (thread pages 404'd on fetch; unverified wording):
sellers "should state the flaws and repeat them in the Item Condition box, as if there is an INAD claim
and flaws aren't mentioned in that box, eBay will not consider that the seller has informed the buyer";
"Buyers almost always win 'not as described' disputes."

r/Depop via AOL (https://www.aol.com/articles/depop-seller-accepted-return-125-194519656.html, page
404'd on fetch; search snippet): a seller accepted a return on a $125 jacket and received a different
item back; the community lesson quoted was that "once a seller hits 'refund,' their leverage is gone".

### Price effect of a tier

Worthmore UK (https://worthmore.uk/blog/vinted-condition-grades-explained-uk): "For most categories on
Vinted, a Good condition item will sit 20-35% lower than the same item in Very Good condition." Also:
buyers "pay a little more for" sellers whose reviews say "exactly as described" because they are "buying
certainty as much as the item itself."

TheRealReal 2023 report (via coveteur.com): Fair items are 33% cheaper than higher grades; Chanel, LV,
Gucci, Hermes and Prada are 60% of the Fair market; TRR only accepted "good" or higher before 2022.
Senior Fashion Lead Noelle Sciacca: "We realized there was an opportunity just below good and before
rejecting something."

### Does anyone ask for a standard grade? Would they pay? Would buyers trust it?

- Nobody in the fetched threads asks for a PSA-style grade by name. What they ask for is the thing a
  grade would provide: an enforced, shared meaning for "good". The Mumsnet OP literally drafts her own
  rubric. That is latent demand, not expressed demand.
- Willingness to pay is inferable from two facts: sellers already pay $10-$20 per item for a photo-based
  authenticity opinion whose main selling point is dispute armor, and a Very Good vs Good label is worth
  20-35% of the sale price on Vinted. A $1-$3 grade that lifts a $40 item one tier or blocks one INAD
  pays for itself. No direct "I'd pay for a condition grade" quote was found (unverified).
- Trust: buyers distrust SELLER-assigned tiers ("90% of sellers will post their stuff as 'good' or
  better"). A third-party grade removes the seller's thumb from the scale, which is exactly the trust
  gap. The risk is the opposite one: a photo-only grade that a seller can game with lighting. The
  authentication services answer this with "two or more experts plus AI" and a financial guarantee; a
  grading product will need an equivalent (human review at low confidence, a public verify page, and a
  visible "graded from N photos on DATE" provenance line).

---

## 5. Certificate and trust products adjacent to grading

### Certilogo (Avery Dennison)
Site pages returned only the header "Connecting Products with People for Brands"; details below are
from prior knowledge and are (unverified): brand-embedded QR/NFC codes on the care label; consumer scans
to get an authenticity check and, for participating brands, a digital Certificate of Authenticity that
can be transferred on resale ("Resell"/"Care" flows). Acquired by Avery Dennison in 2023. B2B pricing
per tag, not sold to individual resellers. Relevance: proves brand-issued authenticity travels with the
garment; it says nothing about condition.

### Eon (eon.xyz)
Fetched. Cloud-based Digital Product Passport per item recording "granular product and material data,
certifications, and sustainability information" and lifecycle events. Named customers: H&M, Balenciaga,
Chloe, Zalando, Coach, Mulberry, Vestiaire Collective, PANGAIA, Nanushka. Resale features: Chloe x
Vestiaire "instant resale"; Poshmark + Eon + Coachtopia "Instant Resale in the U.S." (2024). Selected for
CIRPASS-2 (Feb 2024). Positioned as "Prepare for EU's upcoming regulation". Relevance: the DPP is the
container a condition grade would naturally be written INTO as a lifecycle event; Eon has the brand
relationships and no condition-grading capability of its own.

### EU Digital Product Passport for textiles
From the Commission's ESPR page (fetched) plus prior knowledge:
- ESPR (Regulation (EU) 2024/1781) entered into force 18 July 2024.
- "ESPR and Energy Labelling Working Plan 2025-30" adopted 16 April 2025. Textiles (apparel) is listed as
  a first-wave priority product group alongside furniture, tyres, mattresses, iron/steel and aluminium
  (unverified: the fetched page did not name the list; this is from the published working plan).
- Textiles delegated act: preparatory study running; adoption expected 2027, with DPP obligations
  applying roughly 18 months after adoption, so 2028-2029 for apparel placed on the EU market
  (unverified; no official date exists yet).
- DPP data the Commission names: "Product's technical performance", "Materials and their origins",
  "Repair activities", "Recycling capabilities", "Lifecycle environmental impacts"; the exact fields are
  per-product and still to be decided. Nothing in ESPR mandates a CONDITION field; secondhand condition
  would be a voluntary lifecycle event.
- Ban on destroying unsold textiles and footwear: the fetched page says it "takes effect 9 February 2026,
  established through delegated and implementing acts adopted on that date"; ESPR Article 25 sets the
  ban for large enterprises at 19 July 2026 (unverified which date governs; medium enterprises follow in
  2030).
- Relevance: from ~2028 every new EU garment will carry a scannable ID with a data carrier. A grading
  certificate keyed to that ID (or to a brand code like Certilogo) becomes a lifecycle attestation rather
  than a stand-alone PDF. Not a near-term requirement; a 2027-2028 integration story.

### Authenticity QR tags in the wild
eBay AG QR tag (authenticity report), StockX green QR tag, LegitGrails and Authentic Detective
certificates with QR verify links, Legit App "tamper-proof" digital cert. The format convention resellers
already recognize is: a tag or card with a QR, a public verify page, and a plain "Authentic" verdict.
GradeThread's certificate should look like that convention (verify URL, grade, date, photo count) and not
like a lab report.

---

## Cross-cutting takeaways

1. The lane is empty. AI condition grading for apparel exists only as B2B sorting infrastructure (Fleek,
   Recloth). No one issues a per-garment numeric grade with a shareable certificate to an individual
   reseller or buyer.
2. Trust is the whole product. Buyers say seller tiers are inflated ("90% of sellers will post their
   stuff as 'good' or better"); sellers say INAD is unwinnable ("three magic words, not as described").
   Both sides want a referee. The authentication industry sells exactly that for $10-$20 per item and
   never claims to be AI-only.
3. Price the grade against dispute cost, not against authentication. A one-tier lift on Vinted is worth
   20-35% of the sale; TRR's Fair sits 33% below. A grade that is right about the tier pays for itself
   on a $30 item.
4. Ship marketplace mapping as a first-class feature. The table above shows every marketplace uses 3-5
   phrase-bounded buckets; a per-marketplace lookup from the 0.1 grade plus the factor text that fills
   the "all imperfections should be shown and described" requirement is the integration eBay itself is
   asking sellers to do by hand.
5. Copy the certificate conventions resellers already recognize: QR, public verify page, plain verdict,
   date, financial-guarantee language. Charge for physical cards ($10 is the going rate) and for speed
   (30 min vs 12 h is a 2x spread everywhere).
6. Custody is the credibility gap. PSA, StockX, eBay AG and Posh Authenticate all hold the item. A
   photo-only grade must compensate with consistency proof (regrade the same photos, same grade),
   confidence gating with human review, and a visible provenance line. Consider a "graded by human
   reviewer" badge tier at a higher price.
7. eBay's Feb 2025 auto-migration of every pre-owned clothing listing to "Pre-owned - Good" means
   millions of listings carry an unchosen tier. "Re-grade your eBay closet" is a concrete acquisition hook.
8. Watch Fleek. $45M, eBay Ventures on the cap table, a grading VLM, and pilots in the US. If it turns its
   grader consumer-facing or licenses it to eBay, it becomes the incumbent overnight. Its current output is
   wholesale bale grades, not per-item certificates.
9. The EU DPP is a 2028+ integration, not a 2026 requirement, and it does not mandate condition. Design
   the certificate so a grade can be attached to a product ID later; do not build for it now.

---

## Sources

Fetched (content read):
- https://www.ebay.com/help/selling/listings/creating-managing-listings/item-conditions-category?id=4765
- https://www.ebay.com/sellercenter/resources/seller-updates/2025-january/new-item-conditions
- https://community.ebay.com/t5/Announcements/Introducing-new-conditions-for-pre-loved-clothing/ba-p/34883800
- https://www.ecommercebytes.com/2025/01/27/ebay-seeks-to-differentiate-gently-used-clothing/
- https://www.valueaddedresource.net/ebay-pre-loved-fashion-conditions-2025-updates/
- https://www.ebay.com/authenticity-guarantee/sneakers
- https://community.ebay.com/t5/Returns/Buyer-made-several-contradicting-statements-about-item-condition/m-p/34296792
- https://www.vinted.com/help/50-choosing-item-condition
- https://worthmore.uk/blog/vinted-condition-grades-explained-uk
- https://www.mumsnet.com/talk/am_i_being_unreasonable/4719642-to-be-annoyed-with-vinted-sellers-choice-of-condition
- https://forums.moneysavingexpert.com/discussion/6505462/vinted-descriptions
- https://www.trustpilot.com/reviews/688dcbd3d0192c923856bb50
- https://www.mercari.com/us/help_center/product-info/item-conditions/
- https://partnerapi.depop.com/api-docs/reference/
- https://partnerapi.depop.com/api-docs/getting-started/your-first-listing/
- https://blog.poshmark.com/2014/06/19/posh-tip-how-to-describe-the-condition-of-your-item/
- https://poshmark.com/posh_authenticate
- https://www.poshtoprofit.com/blog/case-opened-against-you-on-poshmark-heres-what-to-do
- https://athleta.thredup.com/pages/faq
- https://coveteur.com/beat-up-handbag-trend
- https://stockx.com/about/en-gb/our-process-en-gb/
- https://legitapp.com/pricing
- https://www.entrupy.com/pricing/
- https://www.entrupy.com/apparel-authentication/
- https://legitgrails.com/products/clothing-authentication
- https://www.verifyluxenow.com/guides/best-designer-authentication-platforms
- https://luxedetect.com/blog/entrupy-vs-legitcheck-comprehensive-comparison
- https://www.recloth.io/
- https://thenextweb.com/news/fleek-25m-series-b-secondhand-fashion-ai
- https://www.eon.xyz/
- https://environment.ec.europa.eu/strategy/circular-economy/ecodesign-sustainable-products-regulation_en

Search-snippet only (not fetched, treat as unverified):
- https://fortune.com/2026/07/08/fleek-an-online-marketplace-connecting-vintage-clothing-wholesalers-and-retailers-raises-25-million-in-new-funding/
- https://techfundingnews.com/fleek-raises-25m-series-b-ebay-burda-secondhand/
- https://www.alibaba.com/product-insights/ai-fashion-resale-pricing-tools-are-they-helping-sustainability-or-inflating-hype-cycles.html (EcoGrading)
- https://www.entrupy.com/hermes-pricing/ and https://www.entrupy.com/the-new-entrupy-experience/ (device-free, May 18 2026)
- https://realauthentication.com/
- https://pages.ebay.co.uk/authenticity-guarantee-sneakers/ (GBP 20 add-on)
- https://help.whatnot.com/hc/en-us/articles/40551460883213-Luxury-Bags-Accessories-Pre-Authentication-Program
- https://www.therealreal.com/faq and https://realstyle.therealreal.com/inside-the-fair-condition-boom/
- https://depophelp.zendesk.com/hc/en-gb/articles/360038455993-What-does-Depop-consider-significantly-not-as-described
- https://www.aol.com/articles/depop-seller-accepted-return-125-194519656.html
- https://support.grailed.com/hc/en-us/articles/30299286841101-Listing-FAQ (403)
- https://www.psacard.com/pricing (403)
- https://www.certilogo.com/ (header only)

Blocked or 404 in this environment: reddit.com, old.reddit.com, several community.ebay.com thread URLs,
wwd.com (tollbit redirect), gs1.eu and cirpassproject.eu DPP timeline pages.
