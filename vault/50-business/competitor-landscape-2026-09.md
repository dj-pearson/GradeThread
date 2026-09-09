---
title: Competitor landscape, September 2026
type: reference
status: current
source_of_truth: vault
code_refs:
  - src/lib/constants.ts
  - extension-unified/lister/selectors.js
  - vault/50-business/pricing.md
reviewed: 2026-09-08
tags: [strategy, competitors, flipdesk, grading, seo, pricing]
summary: Who GradeThread and FlipDesk compete with, what resellers say about those tools in their own words, where FlipDesk already wins, and the ranked list of things competitors do better as of 2026-09-08.
---

# Competitor landscape, September 2026

Nine research passes ran on 2026-09-08: one per competitor cluster, one for
forum sentiment, one for search, and one that inventoried the FlipDesk code
so that nothing below proposes rebuilding a feature that already exists (on
2026-09-08 a Sidekick Tools teardown produced seven stories of which five were
already built here). The per-cluster evidence,
with quotes and URLs, sits in `vault/50-business/competitors/`:

- [[vendoo]], [[list-perfectly]], [[crosslisters-tier2]] (Crosslist, Flyp,
  PrimeLister, Nifty, Zipsale, ExportYourStore, Mercari's importer)
- [[bots-and-ai-listers]] (Sidekick Tools, OneShop, Closet Tools/Resellbot,
  PosherVA, Reeva, SellerAider, Photoroom, the ChatGPT-wrapper tier, and the
  marketplaces' own free AI)
- [[analytics-bookkeeping-sourcing]] (My Reseller Genie, Flipwise, Seller
  Ledger, Terapeak, WorthPoint, Pirate Ship, the $5/mo thrift scanners)
- [[grading-and-authentication]] (Fleek, Recloth, Legit App, Entrupy, eBay
  Authenticity Guarantee, every marketplace's condition scale)
- [[forum-sentiment]] (30 Reddit threads read in full, Trustpilot, eBay
  Community, YouTube comments; themes with source counts)
- [[seo-landscape]] (20 SERPs mapped, 11 content engines profiled, 20 ranked
  page opportunities)
- [[flipdesk-inventory]] (what the code does today, by area, with file paths)

Method caveats, stated once: Reddit blocks server fetches, so the Reddit
material was read through a live browser and dated approximately. The shared
web-search budget ran out partway, so some claims are marked "(unverified)" in
the cluster notes. Crosslister threads are heavily astroturfed with referral
codes; praise was discounted, complaints were not.

## 1. The ten findings that change what we build

1. **Nobody has built the all-in-one.** Every tool is anchored on one job
   (crosslisting, a Poshmark bot, a ledger, an aisle scanner) and treats the
   rest as manual entry. FlipDesk already spans sourcing to taxes; the gap is
   that nobody outside the repo knows it.
2. **Auto-delist that does not fire is the number one complaint for every
   competitor**, 14 independent sources, and it is the top item on the wish
   list. Double-sells cause eBay defects and Poshmark bans. Whoever is
   reliable here wins the switchers; whoever promises it and misses inherits
   the loudest complaint in the category.
3. **The switching flow in 2025-26 is Vendoo to Nifty** (7 sources), and the
   stated reason is Nifty's cloud automation that runs with the laptop
   closed. That collides with [[adr-no-server-side-marketplace-automation]].
   The ADR is defensible (Nifty carries shadow-ban warnings and outages) but
   it needs to be marketed as a choice, not left as a silent limitation.
4. **Thin copies defeat the purpose**, 7 sources: tools that move title and
   photos and leave category, size and specifics to be retyped. Our
   extension does exactly this on Poshmark and Mercari today: it fills every
   text field and deliberately leaves the four pickers (category, size,
   condition, colour) to the seller (`extension-unified/lister/selectors.js`
   around line 119). That is safe, and it is the complaint.
5. **Free native AI has commoditised title, description and category.** eBay,
   Poshmark, Mercari and Depop all do photo-to-listing for free. Buyers
   despise the result (three r/Ebay threads, 900+ upvotes: "a license to
   return"). What survives as paid value is sync, automation the marketplace
   forbids, sold-comp pricing, and verifiable facts about the garment:
   condition, measurements, authenticity. That last one is us.
6. **Nobody asked for a grade.** Zero forum threads requested a numeric
   condition grade. They asked for fewer INAD returns, timestamped evidence a
   bot adjudicator will accept (676-upvote thread on buyers faking damage
   with image models), and a way to stop typing measurements. The grade has
   to be sold as those three outcomes, never as a new object.
7. **Measurements cut returns "by almost 70%"** and are the task clothing
   sellers hate most (9 sources). Most put a tape measure in the photo
   instead of typing. MeasureCard exists and is a brochure with no path into
   the flow (US-2231); List Perfectly shipped text-only measurement templates
   in May 2026 because they see the same gap.
8. **The lane for per-garment condition grading is empty.** Fleek ($45M
   raised, eBay Ventures on the cap table, July 2026) grades bales for
   sorting hubs; nobody issues a per-item grade with a certificate to a
   reseller. Every trusted analog (PSA, StockX, eBay AG) holds the item, so a
   photo-only grade must earn trust with consistency, factor transparency and
   a public verify page, all of which exist.
9. **Price: under $25 is the part-timer ceiling, $35-45 is accepted for
   reliable sync, $60-70 is questioned even by fans, $100 is rejected in
   every thread it appears in.** Listing-count cliffs ("100 to 1,000 with
   nothing in between") read as predatory (8 sources). Vendoo dropped
   per-item tiers for unlimited items at $14.99 in early 2026. Our Starter is
   $29 for 250 listings and Pro is $59 for 1,000.
10. **gradethread.com appears in zero of 19 non-brand search results**
    despite 846 indexed URLs, and the condition, measurement and flaw SERPs
    are the weakest in the category (2019 bale-sorting wholesalers, 2014
    Poshmark posts, forum threads). No competitor has a page there.

## 2. Market map

Prices are monthly USD as published on 2026-09-08. "Method" is how the tool
touches the marketplaces that have no API (Poshmark, Mercari, Grailed,
Vinted, Facebook, Depop until recently).

| Tool | Entry / full price | Method | Channels | Mobile | Status and what it is known for |
|---|---|---|---|---|---|
| Vendoo | $14.99 / $59.99, unlimited items; Shopify +$9.99 | Chrome extension; Depop via API since 2026-07-20 | 11 | iOS + Android (4.5) | Incumbent everyone positions against. Trustpilot 4.2 bimodal: five stars for support speed, one star for double-sells and billing after cancel. Bulk cap 240. |
| List Perfectly | $29 / $69 / $99-249, monthly only | Chrome extension only, no APIs | 10 | None after seven years | Unlimited listings; auto-delist only at $99+; Listing Party community is the moat; reliability load visible (a Current Issues page, daily live support). |
| Crosslist | $29.99 / $44.99 unlimited; AI +$4.99 | API for eBay/Etsy/Shopify, extension for the rest | 11 | iOS + Android (4.7) | Trustpilot 4.5 on 1,061 reviews. Fastest, fewest tier games; "EU not supported"; a Vinted detection warning in Sept 2026. |
| Nifty (ex Auto Posher) | $39.99 / $89.99 bundle; 1,500 active-item cap | Cloud runner plus passwordless session handoff | 6 | PWA only | Where Vendoo refugees go. "Just works" for delist; outages and shadow-ban warnings; AI metered in "smart credits". |
| Flyp | $9 flat after 100 free days | Extension | 8 | Consignment app only | Consignment marketplace funding a loss-leader crosslister. "Crude but functional"; delist lag; ships weekly. |
| Sidekick Tools | $9.99 crosslister to $59.99 all-in; add-on credits | Cloud bot plus apps | 7 | iOS 4.7 (2.3K) | Category leader for Poshmark bots. App Store negatives are all crosslister bugs (duplicates, items not delisted). Posts 1-2 SEO articles a day, seven fee calculators. |
| PrimeLister | $49.99 crosslister; bots $15-25 each | Extension; iOS bot | 8 | Bot only | About $100/mo for everything; no AI at all; bot app 4.9 (2.3K). |
| Zipsale | GBP 25 + VAT; credits from GBP 0.18/item | Extension | Vinted-first | Desktop web | The UK default despite Trustpilot 3.4 with 52% one-star, because nobody else does Vinted properly. |
| OneShop | - | - | - | - | Domain parked for sale; last App Store review May 2026 says the crosslister "loses items". |
| Reeva | - | - | - | - | Domain now an unrelated industrial AI company; a $59 to $249 overnight repricing in 2025 is still cited as the category's rug-pull. |
| Closet Tools / Resellbot | $30 (3 closets) | Cloud | Poshmark | - | Rebranded July 2025; no AI, no crosslister; monthly data reports and two fee calculators. |
| My Reseller Genie / Seller Ledger | $9.99-19.99 / $10-100 | eBay API; CSV for Poshmark and Mercari | Ledger only | - | The accepted bookkeeping band. Tax export is the purchase trigger. |
| Flipwise | $19.99 (100-499 listings) | eBay API | eBay only | - | Aging reports plus auto-reprice-on-relist; "my accountant never saw a first-year owner do as good a job". |
| ThriftAI / Cluzy / Thrifted / Underpriced | $0-5/mo | Photo comps | Scanner only | iOS + Android | 2025-26 growth category (ThriftAI claims 230K users). No condition input, no inventory hand-off, eBay-only comps. |

Three things the map hides:

- **Only eBay, Etsy, Shopify and (since July 2026) Depop have real listing
  APIs.** Every competitor's Poshmark, Mercari, Grailed, Vinted and Facebook
  support is browser automation, whatever the page says. Crosslist's
  "API-first" is true for four channels and marketing for the rest.
- **The architecture predicts the complaint.** Extension form-fillers get
  "ties up my computer" and "disconnected again"; cloud runners get "went
  down" and "shadowban"; first-party importers (Mercari's April 2024 tool)
  have no sync at all.
- **Every competitor's name is owned in search by its rivals.** "Vendoo
  review" is three nifty.ai pages; three of the four ranking "Flyp reviews"
  are by Vendoo, Nifty and Closo. Expect to be reviewed by competitors before
  customers.

## 3. What resellers say, by theme

Source counts are independent threads or pages from [[forum-sentiment]].

**Why they pay at all (9):** manual crossposting became exhausting at 200+
items a month; a double-sell or an eBay "below standard" hit; Poshmark pulled
bulk share; a day job plus a big closet; a YouTuber's ranking video (Mogi
Beth's 2025 ranking drove at least eight visible "I went with Nifty"
comments).

**Why they cancel (12):** 80-95% of sales come from eBay anyway, so
crosslisting "wasn't worth the return" (7). The exception, said in the same
threads, is clothing: "If I did clothes only it could make more sense."
Second reason: the auto-delist could not be trusted, so they stopped
crosslisting one-offs (3).

**Top complaints (ranked):** auto-delist not firing (14); browser and tabs
must stay open (3); predatory tiers and gated basics (8); thin copies (7);
support that denies and never refunds (8); data-destroying bugs, square
photos, overwritten descriptions, duplicated listings (6); lag (6); feature
churn (2); bans and the Poshmark deletion cap (5); desktop-only or
mobile-only, never both (5).

**The wish list (ranked):** reliable sale detection that delists everywhere
without a browser open (9); linear pricing with no cliffs (7); copy
everything including category, size and specifics (5); real analytics,
profit after fees (5); one tool for crosslisting and Poshmark sharing (4);
phone and desktop with continuity (4); Facebook and Vinted that do not break
(4); defaults that prefill shipping and policies (2); lot-cost splitting and
a take-home calculator (2); per-platform price floors that know each site's
fees (3); a month-long trial (3).

**Clothing-specific (18):** measurements are the hated task and the return
cure; flaws are missed until the "loser lights" come on; disclosure
placement (title, specifics, photos) decides INAD outcomes; condition tiers
are subjective and the platforms now adjudicate by AI and side with the
buyer; colour and sizing disputes even with measurements; photos, not
descriptions, are the time bottleneck (6 to 6.5 minutes per garment end to
end).

**AI attitudes (12):** buyers scroll past AI descriptions; sellers using
photo-to-draft AI with a human edit are quietly positive ("would not go back
to drafting manually") and never trust it unsupervised on flaws; the
documented failure modes are wrong item identity, missed size from a clear
tag photo, "linen blend" invented from nothing, condition buried in the last
line. The market wants AI output "that looks like it was generated by a
template and not AI".

## 4. Where FlipDesk already wins (verified in code)

These are shipped, per [[flipdesk-inventory]], and most are things the wish
list asks for. The problem with each is that nobody outside the repo knows.

- **eBay lifecycle depth.** 124 routes: publish, revise, bulk, relist, end,
  import, orders via webhook, payouts, returns, INR, MBG cases, disputes,
  cancellations, feedback, Promoted Listings, markdowns, coupons. Competitors
  stop at publish and delist.
- **Sale detection on eBay is API-driven, not scraped.** The 14-source
  complaint is about scraping. eBay sale to Poshmark and Mercari delist is
  the reliable direction and the one to advertise.
- **Poshmark sharing, following and offers with hard caps and consent,
  included on Starter.** Wish item 5 (one subscription for crosslisting and
  sharing); Vendoo gates this at $59.99 and List Perfectly at $69-99.
- **Books and taxes.** Ledger, P&L, COGS, 1099-K, Schedule C mapping, mileage,
  home office, receipts, QuickBooks. This is My Reseller Genie and Flipwise
  territory, already built, inside the same subscription.
- **Three clients** (web PWA, iOS, Android) plus the phone-to-desktop
  extension queue. Wish item 6; List Perfectly and Nifty have no app at all.
- **Automations with margin floors**, scheduled drops, auto-relist,
  auto-counter offers, per-item price floors (partial, US-3192). Wish item 10.
- **Sourcing** (Scout, Prospect, Thrift Radar, demand board) on all three
  clients, with condition as an input. The $5/mo scanners have none of that.
- **Grade as an object**: certificate, verify page, passport, disclosure
  text, Return Shield evidence pack, grading ROI analytics, buyer guarantee.
  Nobody else has any of it.
- **No-password, own-IP architecture.** PosherVA is recommended on Reddit for
  exactly this. The ADR gives us the same line, and US-3130 built the page.
- **Import presets for Vendoo and List Perfectly exports, with undo.** The
  migration path switchers need, but none of the presets has been verified
  against a real export.

## 5. What competitors do better, ranked

Each row names the competitor evidence, what the code does today, and the
action. Story ids are open in `prd.json` unless marked new. Rank is by
(how often resellers raise it) times (how far we are from it).

| # | Gap | Competitor evidence | FlipDesk today | Action |
|---|---|---|---|---|
| 1 | Cross-listing is unreachable for a real customer | Every competitor is in the Chrome Web Store; Flyp updated its extension the day before this research | `extension-unified/` v1.1.0 is in no store (US-1757, US-3058); the Listing Kit button was compiled out of the live build (US-2718) | Ship the store listing. Everything in rows 2-6 is invisible until this lands. |
| 2 | Copy everything, not just text | Vendoo and Crosslist set category, size and condition on Poshmark and Mercari, imperfectly; "thin copies defeat the purpose" (7 sources) | Poshmark and Mercari fills are text-only by design; category, size, condition and colour are left to the seller (`selectors.js`) | Drive the four pickers from the eBay aspects we already normalise, with a per-field confidence and a "we picked, you confirm" review state. Keep the no-auto-submit rule. New story. |
| 3 | Revise and relist on extension channels | All major tools automate all four verbs on 8-11 channels | Revise and relist are "verifying" (manual) on every extension channel; Grailed delist is impossible by design (US-3071) | Finish US-3071 for Poshmark and Mercari first; those two are where clothing crosslisting pays. |
| 4 | Sale detection off eBay | Nifty's cloud detection is the stated reason for the dominant switch flow; Vendoo's Depop API sync every 30 min | Poshmark and Mercari sold-sync is passive (the seller must open their sales page); Grailed and Vinted have none (US-2702) | Two moves. (a) Turn the eBay-side certainty into the pitch: "sold on eBay, gone from Poshmark within N minutes, and here is the log". (b) Owner decision: re-argue [[adr-no-server-side-marketplace-automation]] against the Vendoo-to-Nifty evidence, or explicitly market the trade ("your account, your IP, your laptop") and add a nightly "open your sales pages" nudge. |
| 5 | Depop by API | Vendoo shipped Depop API on 2026-07-20 with sale detection on by default | Adapter fully built, gated off behind `DEPOP_ENABLED` pending partner approval (US-2473, US-3131) | Operator: chase the Depop partner approval. It is the one no-scrape channel besides eBay that can be marketed as such. |
| 6 | Facebook Marketplace and Vinted that do not break | Wish item 7 (4 sources); Zipsale owns the UK on Vinted alone | Facebook content script exists, nothing verified (US-2480); Vinted list is live on 22 domains, delist and sold-sync are not | Vinted delist and sold-sync (US-2702) before Facebook. Vinted is a market with no good tool; Facebook is a market where every tool breaks. |
| 7 | Listing-count price cliffs | "100 to 1,000 with nothing in between" (8 sources); Vendoo went unlimited at $14.99; Crosslist $44.99 unlimited; $100 rejected everywhere | $29 for 250, $59 for 1,000, $99 unlimited; AI actions and grades are already separate meters | Owner decision: drop or soften the listing cap and let the AI-action and grade meters carry the tiers, which they already do. See section 8. |
| 8 | Measurements from a photo | Sellers put a tape in the photo instead of typing (9 sources); one asked for AI that "grabs measurements from any photographed tape measure"; List Perfectly shipped text templates May 2026 | MeasureCard calibrate, extract, overlay exist on web and iOS; the tools page is a brochure with no path into the flow (US-2231); the golden-set gate never ran (US-1582) | Make tape-in-photo to typed measurements the headline flow in the composer and the phone capture, then run the golden set. This is the one clothing feature no competitor has. |
| 9 | AI copy that reads like a template | Buyers scroll past AI descriptions (900+ upvotes); sellers want output "that looks like a template and not AI"; hallucinated fabric content | Listing voice setting exists; tone dialogs exist; the disclosure block is grade-backed | Default the description to a fact-first template: condition line from the grade, measurements block, flaws with photo references, then prose. Never emit a material or size the OCR did not read. New story. |
| 10 | Migration from a competitor in one afternoon | The switching flow is the acquisition channel; "hold your listings for ransom" and "photos scrambled when I left" are the fears | Presets for Vendoo and List Perfectly CSV, none verified against a real export; no Nifty or Crosslist preset (US-3164); no universal channel-linking import (US-3197) | Get real exports, verify the two presets, add Nifty and Crosslist, and ship a "leave any time, full export" promise with a one-click CSV of everything. |
| 11 | Search presence | Competitors publish vs, alternatives and calculator pages daily; we rank for nothing but our name | 846 URLs; home nav does not reach the six content hubs | Section 7. |
| 12 | Support that answers | Vendoo's five stars are almost all about support speed; List Perfectly's two stars are "cannot reach a human" | Help center live and empty in prod (US-2618, 83 articles written); support assistant and tickets exist | Seed the 83 articles; publish a status page (List Perfectly's Current Issues page is the model, and the extension's selector self-check already produces the data). |
| 13 | Shipping labels in-app | Vendoo and Crosslist users default to Pirate Ship; nobody lands label cost on the item | Labels built, dead in prod for lack of the eBay `sell.logistics` scope (US-2380); packing slip shipped; no ship-by countdown (US-3189) | Operator: the scope request. Then the differentiator is label cost and carrier adjustments landing on the item's P&L, which no ledger tool does. |
| 14 | Send offers to watchers | Vendoo Pro "Auto Send Offers on 6+ marketplaces" | Written, returns 501 in prod for lack of `sell.negotiation` (US-1421, US-3199) | Operator: the scope request. |
| 15 | Grading covers all garment categories | Not a competitor gap; a self-imposed ceiling | 8 of 20 categories have rubric criteria; hats and bags misroute (US-2222, 2223, 2225) | Finish the rubrics before marketing the grade to non-apparel sellers. |
| 16 | A month-long trial and no-questions refund | Asked for in 3 sources; no-refund policies generate the angriest reviews | 14-day Pro trial, abuse check missing (US-2288); refund page exists | Extend to 30 days once the abuse check exists. |
| 17 | Community | List Perfectly's Listing Party (daily calls, swap meets) is its moat | Aggregate insights only; no forum or chat | Low priority to build; high priority to borrow: a Discord plus the creator affiliate program that already exists. |
| 18 | Listing video | Vendoo Pro adds 5-15 second videos on Poshmark and eBay | Not built (US-1980) | Low; eBay Media API only. |

Rows 1 to 4 are the same story told four ways: the crosslister exists and a
customer cannot reach or trust it yet. Nothing in rows 5 to 18 matters to a
switcher until those four are done.

## 6. The grading lane

The evidence says the grade is a means, not an end, to the people who would
pay for it.

- **Sell outcomes, not the number.** Fewer INAD returns (one INAD "wipes out
  profit from 2-3 sales"), evidence a bot adjudicator accepts, no more typing
  condition prose. The certificate is dispute armour; the authentication
  industry already sells that framing at $10-20 per item and never claims
  AI-only.
- **Fill every marketplace's condition box from the grade.** Every scale is 3
  to 5 phrase-bounded buckets; [[grading-and-authentication]] has the exact
  wording for eBay, Poshmark, Mercari, Depop, Vinted, Grailed, TheRealReal
  and ThredUp with a proposed band per tier. eBay's own text demands "all
  imperfections should be shown and described"; the factor report is that
  text. Check `vault/30-platform/ebay-condition-and-policies.md` for what the
  eBay side already does, then extend the mapping to the extension channels.
- **"Re-grade your eBay closet."** eBay auto-migrated every pre-owned clothing
  listing to "Pre-owned - Good" on 4 Feb 2025, so millions carry a tier the
  seller never chose, and eBay's stated reason for the tiers was to reduce
  condition returns. That is a bulk-grading acquisition hook with a date on
  it.
- **Tamper-evident evidence.** The 676-upvote thread on buyers faking damage
  with image models asked for timestamped, device-attested photos. Return
  Shield already packages evidence; make the timestamp and hash visible on
  the certificate.
- **Custody is the credibility gap.** PSA, StockX and eBay AG hold the item.
  Compensate with what we have: same photos, same grade, human review below
  0.75 confidence, and a public verify page. A "reviewed by a human" badge
  tier at a higher price is the obvious upsell.
- **Watch Fleek.** If it turns its bale grader consumer-facing or licenses it
  to eBay, it is the incumbent overnight. Today it is B2B sorting only.
- **Ignore the EU Digital Product Passport for now.** Textiles land around
  2028 and the mandated fields do not include condition; design the
  certificate so a grade can attach to a product id later.

## 7. Search and content

Detail in [[seo-landscape]]. The short version:

1. **Fix reachability first.** The home page footer links only "Condition
   Grading" and "Grading Standard"; the six hubs (grading, care, compare,
   tools, reselling, condition index) are not reachable from the home nav.
   Internal links plus a handful of citations will move more than another
   hundred pages.
2. **Take the condition cluster nobody owns.** "How to grade clothing
   condition" returns six bale-sorting wholesalers out of nine. Pages to
   build: the 1-10 grading guide with a photo per grade; eBay Excellent vs
   Good vs Fair thresholds with photos; per-garment measurement diagrams;
   a flaw vocabulary with the grade delta for each defect; one glossary hub
   for EUC, VGUC, GUC, NWOT, NWT; reframe the 74 care pages as "is it a flaw,
   what does it cost you".
3. **Publish the software pages on day one.** "Vendoo alternative", "List
   Perfectly alternative", "Nifty alternative", a neutral "vendoo vs list
   perfectly" with a real 20-garment test, and a "best crosslisting app 2026"
   listicle that adds the axis no matrix has: does the tool record condition
   and measurements. Every competitor does this to us; the cost is a page.
4. **Calculators.** The eBay fee engine exists; put a live cross-platform
   flip calculator with a condition-adjusted price on every /compare page.
   Voolist and sellerfeecalc.com hold that SERP with copyable tables.
5. **Creators are the category's backlink and brand driver.** Every ranking
   video carries Vendoo, List Perfectly and Crosslist codes. The creator
   affiliate program exists; it needs ten named channels and a review unit
   that shows the measurement and grade flow on camera.

## 8. Pricing: the evidence and the decision

The market's price bands, from 15 sources: under $25 no-brainer for
part-timers and the hard ceiling under about $500/month gross; $35-45
accepted for reliable delist and import from anywhere; $60-70 tolerated only
when it visibly replaces other subscriptions; $100 rejected everywhere it
appears, including by people who like the product. Per-sale fees and listing
cliffs read as predatory. Annual plans and a month-long trial are asked for
by name.

Against that, [[pricing]] is $0/25, $29/250, $59/1,000, $99/unlimited
listings, with AI actions, grades and connector actions as separate meters.
Vendoo dropped per-item tiers for unlimited items at $14.99 in early 2026;
Crosslist's unlimited is $44.99; List Perfectly is unlimited at $29 but gates
automation at $99.

The decision this note does not make: whether to remove the listing cap and
let the meters that already exist (AI actions, grades, connector actions)
carry the tiers. Two things argue for it. The meters are where our cost is,
so they are the honest axis; and FlipDesk at $59 already replaces a bot
($25-30), a ledger ($10-20) and a scanner ($5), which is the only framing in
which $60-70 is accepted. One thing argues against it: two prepaid currencies
(grade credits and action credits) plus a monthly allowance is already more
than a Reddit thread will explain, and the answer to "predatory" is fewer
moving parts, not more.

## 9. What not to copy

Every one of these has a named casualty in the cluster notes.

- Per-sale fees (Treecat: "absolutely robbery").
- Overnight repricing (Reeva, $59 to $249, still cited a year later).
- Moving a basic into a higher tier (Sidekick's auto-delist; List Perfectly
  at $99).
- Silent overwrites of the seller's listing data (Crosslist "changed the
  descriptions to generic garbage"; Vendoo's square-photo relist; List
  Perfectly's photo scramble on cancel).
- Feature churn ("I just want something that works so I don't have to change
  my process every 3 weeks").
- Claiming "the only sale detection tool" when five competitors have one.
- Holding marketplace credentials on a server. The users who notice say so
  approvingly of the tools that do not.

## 10. Open items this note leaves for the owner

- Re-argue or market the no-server-side-automation decision (row 4).
- Listing cap versus meters (section 8).
- Whether to file rows 2, 9 and 10 as new stories now, ahead of the
  extension store launch, or hold them until it ships.
