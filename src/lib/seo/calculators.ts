// The calculator family (US-9002): /tools/{slug} plus the hub at
// /tools/calculators.
//
// WHY THIS FAMILY EXISTS, in one number: /tools/authenticity-check earns 9.0%
// CTR at average position 13.4 while the site averages 0.85% at position 11.6
// (Search Console, 6 months to 2026-08-16). One tool page out-clicks 104 blog
// posts sitting three positions above it. That is local evidence, not a
// borrowed Keyword Planner estimate, and it is why the calculators go first.
//
// STATUS FLAG: an entry is only routed once its own story ships the compute.
// The registry carries all eight so the family can be planned, sized and
// interlinked in one place, but calculatorRoutes() emits only `live` ones. A
// page that promises a calculator and renders an empty shell is worse than no
// page, and that is the failure the flag prevents.
//
// PURE DATA: imports only the PublicRoute TYPE, like every other route family
// in this directory. Fee schedules and compute live with their calculator.

import type { PublicRoute } from "./public-routes";

export const CALCULATOR_HUB_PATH = "/tools/calculators";

/** Who the calculator is for. Drives hub grouping and the interlink target. */
export type CalculatorAudience = "seller" | "buyer" | "both";

export interface Calculator {
  /** URL slug under /tools/, e.g. "ebay-fee-calculator". */
  slug: string;
  /**
   * `live` once the calculator computes something. `planned` entries are
   * registry-only: no route, no prerender, no sitemap entry, no hub card.
   */
  status: "live" | "planned";
  /** The story that ships the compute. */
  story: string;
  audience: CalculatorAudience;
  /** <title> without the " | GradeThread" suffix the SEO component adds. */
  title: string;
  description: string;
  h1: string;
  /** One line on the hub card. */
  cardBlurb: string;
  /** The head keyword this page owns, mirrored into keyword-targets.ts. */
  primaryKeyword: string;
  /**
   * The FlipDesk landing slug this calculator hands off to (US-9010), and the
   * one line of prose that earns the click.
   *
   * MATCHED, not generic: a seller who has just worked out eBay's fees wants
   * the thing that tracks fees, not a general product tour. The handoff is
   * rendered AFTER the result, because before it the visitor has not got what
   * they came for and an advert is just in the way.
   */
  handoff?: {
    /** A slug from flipdesk-landing.ts. */
    surface: string;
    /** The heading on the handoff block. */
    heading: string;
    /** Two or three sentences. Say what it does, not how good it is. */
    body: string;
    /** The link text. */
    cta: string;
  };
  /** Supporting keywords, woven into copy and headings. */
  secondaryKeywords?: string[];
  /**
   * Page module under src/pages/, WITHOUT the extension, when it is not
   * `tools/{slug}`. The four marketplace fee calculators are one parameterised
   * component (US-9005), so four slugs share one file, and the prerender's
   * chunk-preload map has to be told that or it looks for a file that does not
   * exist. It degrades to a skipped preload with a single warning, which is
   * exactly the US-1950 regression the map exists to prevent.
   */
  pageModule?: string;
  /**
   * Lead paragraph. Required once an entry goes live: this is the prose the
   * prerender emits, and it has to be useful before any script hydrates.
   */
  intro?: string;
  /** FAQPage source. Required once an entry goes live. */
  faqs?: { q: string; a: string }[];
}

export function calculatorPath(slug: string): string {
  return `/tools/${slug}`;
}

// The eight, in build order. Volumes cited in the stories come from the 2026-08
// Keyword Planner pull and are BUCKETED estimates from an Ads account with no
// spend. US-9001 found three of four "proven 5,000/mo" URLs with zero
// impressions after ten weeks, so treat every such figure as a rank ordering
// rather than a forecast.
export const CALCULATORS: readonly Calculator[] = [
  {
    slug: "ebay-fee-calculator",
    status: "live",
    story: "US-9003",
    audience: "seller",
    title: "eBay Fee Calculator: What a Sale Nets You",
    description:
      "The real payout on an eBay sale: category final value fee, per-order fixed fee, insertion fees past the free allotment, promoted listings and the overseas cut.",
    h1: "eBay fee calculator",
    cardBlurb: "Every eBay fee on one sale, itemised, including the ones sellers forget.",
    primaryKeyword: "ebay fee calculator",
    handoff: {
      surface: "bookkeeping",
      heading: "You will do this again on every sale",
      body: "This page works out one sale. A month of them is a spreadsheet you have to keep current, with the fee rates changing under it. FlipDesk records the fees against each item as it sells, so the profit number is already there at tax time instead of being reconstructed from payout emails.",
      cta: "See how FlipDesk tracks fees",
    },
    secondaryKeywords: [
      "ebay final value fee calculator",
      "how much does ebay take from a sale",
      "ebay seller fees",
    ],
    intro:
      "Most fee calculators multiply your price by one percentage and stop. eBay does not work that way, and the three places it does not are where sellers lose money they had already counted. Shipping and sales tax are part of what the fee is charged on, so a $40 item with $8 postage is a $48 sale. A Starter Store gets no discount at all, despite costing money. And athletic shoes crossing $150 change rate AND stop being charged the per-order fee, while a handbag crossing $2,000 re-rates the entire sale, so a $2,001 bag costs less in fees than a $1,999 one.",
    faqs: [
      {
        q: "How much does eBay take from a sale?",
        a: "For clothing, shoes and accessories, 13.6% of the total amount of the sale plus $0.40 per order, if you have no Store or a Starter Store. A Basic Store or above pays 12.7%. Total amount of the sale means item price plus handling plus the shipping the buyer paid plus sales tax, so the fee is always charged on more than the price on the listing.",
      },
      {
        q: "Does eBay charge fees on shipping and sales tax?",
        a: "Yes, on both. This is the single most common surprise on a payout. If you charge $8 shipping on a $40 item and $3 tax is collected, the final value fee is calculated on $51, not $40. Free shipping does not avoid it either, because the cost is inside the item price instead.",
      },
      {
        q: "Is an eBay Store worth it?",
        a: "It depends on volume, and the calculator shows the crossover. A Basic Store costs $21.95 a month on a yearly renewal and drops the apparel fee from 13.6% to 12.7%, which is 0.9 points, so it pays for itself somewhere around $2,440 of monthly sales. A Starter Store at $4.95 gives you no fee discount whatsoever, only cheaper insertion fees and the same 250 free listings you already get.",
      },
      {
        q: "Why do sneakers have a different eBay fee?",
        a: "eBay charges 8% rather than 13.6% on men's and women's athletic shoes when the sale total is $150 or more, and does not charge the per-order fee at all on those sales. There is a second, separate $150 test on the starting price, which is what makes the listing free. Miss the threshold by a cent and you pay the ordinary apparel rate plus the per-order fee plus an insertion fee.",
      },
      {
        q: "What fees do sellers forget?",
        a: "Four. The 1.65% international fee, which fires on the buyer's registered address as well as the delivery address, and which disappears entirely if you offer eBay International Shipping. The insertion fee once you pass your free listings, charged again on every relist and every monthly renewal. The seller-standing surcharge, which adds 6 percentage points for Below Standard and 5 for a Very High 'not as described' return rate. And the $20 dispute fee, which is fifty times the per-order fee.",
      },
    ],
  },
  {
    slug: "ebay-shipping-calculator",
    status: "live",
    story: "US-9004",
    audience: "seller",
    title: "eBay Shipping Calculator for Clothing Sellers",
    description:
      "Shipping cost by weight, box size and service for the packages clothing sellers send, with dimensional weight applied and flat rate compared to weight based.",
    h1: "eBay shipping calculator",
    cardBlurb: "Weight, box size and service compared, with dimensional weight shown separately.",
    primaryKeyword: "ebay shipping calculator",
    handoff: {
      surface: "bookkeeping",
      heading: "The postage you actually paid, against the item you sold",
      body: "An estimate before you list is useful. What decides your margin is the label you really bought, matched to the item it went out with. FlipDesk keeps that pairing, so the shipping cost in your profit number is the one on the receipt.",
      cta: "See how FlipDesk tracks shipping cost",
    },
    secondaryKeywords: [
      "cheapest way to ship clothes",
      "usps shipping calculator by weight and zip code",
      "dimensional weight calculator",
      "flat rate vs ground advantage",
    ],
    intro:
      "Postage is the second largest cost on a clothing sale and the easiest one to get wrong, because three of the rules that decide it are invisible on the label. Under a pound is its own price, and it is CHEAPER than the one pound price, so a package that creeps from 15 to 17 ounces costs more to send. Past one cubic foot USPS stops weighing your parcel and starts measuring it, which is how a two pound puffer jacket gets billed as nineteen pounds. And flat rate is a bad deal on most single garments and a very good one on a heavy box going coast to coast. Enter what you are actually sending and this compares the services against each other rather than quoting one.",
    faqs: [
      {
        q: "What is the cheapest way to ship clothes?",
        a: "For a single garment under a pound, USPS Ground Advantage in a poly mailer, which starts at $6.93 and never passes $8.40 no matter how far it goes. That is cheaper than every flat rate option and cheaper than the one pound Ground Advantage rate. Above about ten pounds, or for anything travelling to Zone 7 or 8, a Priority Mail Flat Rate box usually wins because it ignores both weight and distance.",
      },
      {
        q: "Why did my package cost more than the scale said?",
        a: "Dimensional weight. Once a parcel is bigger than one cubic foot, USPS charges on length times width times height divided by 139, if that number is larger than the actual weight. A puffer jacket in an 18 by 14 by 10 box is 2 pounds on the scale and 19 pounds on the invoice. USPS also rounds every fractional dimension up to the next whole inch before it does the arithmetic, so a 10.2 inch box is an 11 inch box.",
      },
      {
        q: "Is Priority Mail Flat Rate worth it for clothing?",
        a: "Sometimes, and the crossover is sharper than sellers expect. A Padded Flat Rate Envelope is $11.99 to anywhere, so it beats weight-based pricing on a heavy sweater going across the country and loses badly on a t-shirt going across town, where Ground Advantage is $6.93. The rule of thumb: flat rate wins when the package is heavy, far, or both, and loses on everything light and local.",
      },
      {
        q: "What are USPS zones and which one am I in?",
        a: "A zone is the distance between the sending and receiving ZIP codes, from Zone 1 at under 50 miles to Zone 8 at over 1,800. Ground Advantage and Priority Mail both price by zone, so the same package costs different amounts depending on where the buyer lives. Flat rate does not, which is the whole point of it. This calculator estimates the zone from the two ZIP codes you enter.",
      },
      {
        q: "Are these the rates eBay charges me?",
        a: "These are USPS commercial prices, which is the tier you pay when you buy a label online rather than at a Post Office counter. eBay label rates are at or below this tier, so treat a result here as a ceiling rather than a quote. Counter prices are roughly 30 to 40 percent higher than what you see here, which is why buying the label through eBay is worth doing even when the postage looks the same.",
      },
    ],
  },
  {
    slug: "poshmark-fee-calculator",
    status: "live",
    pageModule: "tools/marketplace-fee-calculator",
    story: "US-9005",
    audience: "seller",
    title: "Poshmark Fee Calculator: What Poshmark Takes",
    description:
      "How much does Poshmark take? The 20% commission, the flat $2.95 that replaces it under $15, and what lands in your account, on your own numbers.",
    h1: "Poshmark fee calculator",
    cardBlurb: "The flat fee, the commission, and where the cutoff between them falls.",
    primaryKeyword: "how much does poshmark take",
    handoff: {
      surface: "crosslisting",
      heading: "You compared five platforms. You can list on all of them",
      body: "The spread between the best and worst platform on one item is real money, and the answer changes item by item. FlipDesk builds the listing once and publishes it to eBay and Shopify by API, and to Poshmark, Mercari and Grailed through the browser extension.",
      cta: "See how FlipDesk crosslists",
    },
    secondaryKeywords: [
      "how much does poshmark take",
      "poshmark fees",
      "poshmark commission",
    ],
    intro:
      "Poshmark has the simplest fee structure of any resale app and the highest headline rate. Twenty percent, charged on the item price alone. No listing fee, no payment processing fee, nothing hidden underneath it. The catch is at the bottom of the range: anything under $15 is charged a flat $2.95 instead, which on a $10 sale works out to 29.5%. That is the number worth knowing before you list a cheap item, and it is why the $15 line is the most important price point on the platform.",
    faqs: [
      {
        q: "How much does Poshmark take?",
        a: "Twenty percent of the sale price on anything $15 or over, and a flat $2.95 on anything under $15. There is no listing fee, no monthly subscription and no separate payment processing fee, which is unusual: on most platforms the headline rate is only part of what you pay.",
      },
      {
        q: "Why is the fee on a cheap item so high?",
        a: "Because $2.95 is a flat fee, not a percentage. On a $14 sale it is 21%, on a $10 sale it is 29.5%, and on a $5 sale it is 59%. Twenty percent would have been cheaper on every one of those. If you are listing something near the line, pricing it at $15 rather than $14 leaves you with more money.",
      },
      {
        q: "Does Poshmark charge a fee on shipping?",
        a: "No. The buyer pays a flat shipping rate directly to Poshmark and gets a prepaid label, so the postage never passes through your account and the 20% is charged on the item price alone. This is genuinely different from eBay and Etsy, which both charge their percentage on the shipping you collect.",
      },
      {
        q: "Is Poshmark more expensive than Mercari or Depop?",
        a: "On the headline rate, yes, by a wide margin. In practice it depends on the item. Poshmark's 20% of a $40 item is $8.00. Mercari's 10% of the same sale with $8 shipping is $4.80. Depop charges US sellers nothing to sell and only takes processing, about $2.13. The comparison table on this page runs your own numbers through all five.",
      },
    ],
  },
  {
    slug: "mercari-fee-calculator",
    status: "live",
    pageModule: "tools/marketplace-fee-calculator",
    story: "US-9005",
    audience: "seller",
    title: "Mercari Fee Calculator: Your Real Payout",
    description:
      "What Mercari takes from a sale, including the selling fee, the payment processing cut and the shipping choice that decides which side pays the postage.",
    h1: "Mercari fee calculator",
    cardBlurb: "Selling fee, processing cut, and who ends up paying the postage.",
    primaryKeyword: "mercari fee calculator",
    handoff: {
      surface: "crosslisting",
      heading: "You compared five platforms. You can list on all of them",
      body: "The spread between the best and worst platform on one item is real money, and the answer changes item by item. FlipDesk builds the listing once and publishes it to eBay and Shopify by API, and to Poshmark, Mercari and Grailed through the browser extension.",
      cta: "See how FlipDesk crosslists",
    },
    secondaryKeywords: [
      "mercari fees",
      "how much does mercari take",
      "mercari selling fee",
    ],
    intro:
      "Mercari spent 2024 charging sellers nothing and moving the cost to buyers. It ended that on 6 January 2025. The structure now is a flat 10% selling fee, charged on the item price plus any shipping the buyer paid, and no payment processing fee at all, because the old 2.9% plus $0.50 was removed rather than folded in. Buyers pay a separate 3.6% Buyer Protection fee, which is not your cost but is your conversion rate.",
    faqs: [
      {
        q: "How much does Mercari take from a sale?",
        a: "Ten percent, charged on the item price plus buyer-paid shipping. On a $40 item with $8 shipping that is $4.80. There is no payment processing fee on top, which is the part sellers coming from eBay or Etsy do not expect, and no listing fee.",
      },
      {
        q: "Did Mercari get rid of seller fees?",
        a: "It did, and then it changed its mind. The zero-seller-fee structure ran through 2024 and ended on 6 January 2025, replaced by the flat 10%. The trade was real, though: the 2.9% plus $0.50 payment processing fee that used to sit under the old selling fee is gone for good.",
      },
      {
        q: "What is the Mercari Buyer Protection fee?",
        a: "A flat 3.6% the buyer pays on the item price plus shipping. It does not come out of your payout. It does raise what the buyer sees at checkout, so a $40 listing costs them about $1.73 more than the price on the screen, which is worth knowing when you set a price against a competing listing on another app.",
      },
      {
        q: "Does Mercari charge on shipping?",
        a: "Yes, when the buyer pays it. The 10% is charged on the completed item price and the buyer-paid shipping together. If you ship on your own label and build the cost into the item price instead, the fee is charged on the higher item price, so it comes to the same thing.",
      },
    ],
  },
  {
    slug: "depop-fee-calculator",
    status: "live",
    pageModule: "tools/marketplace-fee-calculator",
    story: "US-9005",
    audience: "seller",
    title: "Depop Fee Calculator: What You Keep on a Sale",
    description:
      "What Depop keeps from a sale after the selling fee and payment processing, and what the same item would net you on eBay, Poshmark, Mercari or Etsy instead.",
    h1: "Depop fee calculator",
    cardBlurb: "Depop's cut, next to what the same item nets on four other platforms.",
    primaryKeyword: "depop fee calculator",
    handoff: {
      surface: "crosslisting",
      heading: "You compared five platforms. You can list on all of them",
      body: "The spread between the best and worst platform on one item is real money, and the answer changes item by item. FlipDesk builds the listing once and publishes it to eBay and Shopify by API, and to Poshmark, Mercari and Grailed through the browser extension.",
      cta: "See how FlipDesk crosslists",
    },
    secondaryKeywords: [
      "depop fees",
      "does depop charge selling fees",
      "depop boosted listings fee",
    ],
    intro:
      "Depop stopped charging US sellers a selling fee on 18 July 2024, which makes it the cheapest of the five platforms to sell on and the most misunderstood. The money did not vanish, it moved to the buyer, who now pays a marketplace fee of up to 5% plus up to $1 at checkout. What you still pay is payment processing: 3.3% plus $0.45, charged on the item price plus shipping plus tax. And if you boost a listing, that costs 12%, which is more than several platforms charge to sell at all.",
    faqs: [
      {
        q: "Does Depop still charge a selling fee?",
        a: "Not for sellers based in the US, the UK or Australia. The 10% selling fee was removed for US sellers on 18 July 2024 and has not come back. Sellers outside those three countries still pay 10%. What every US seller still pays is the payment processing fee.",
      },
      {
        q: "What does Depop actually cost me per sale?",
        a: "3.3% plus $0.45, charged on the item price plus shipping plus any applicable tax. On a $40 item with $8 shipping and $3 tax that is $2.13, or about 5.3% of the item price. That is roughly a third of what the same sale costs on Poshmark.",
      },
      {
        q: "Is boosting a Depop listing worth it?",
        a: "It costs 12% of the item price plus shipping, charged only when the boosted item sells. Look at that number against what the platform charges to sell without it, which is zero. Boosting turns Depop from the cheapest platform in this comparison into one that costs more than Mercari. It can still pay for itself, but it has to earn that 12%, not just spend it.",
      },
      {
        q: "What does the buyer pay on Depop?",
        a: "Up to 5% of the item price plus up to $1, excluding taxes and postage, introduced the same day the seller fee was removed. It is not your cost, but it is on the screen when someone decides whether to buy, so a $40 listing looks like roughly $43 to them.",
      },
    ],
  },
  {
    slug: "etsy-fee-calculator",
    status: "live",
    pageModule: "tools/marketplace-fee-calculator",
    story: "US-9005",
    audience: "seller",
    title: "Etsy Fee Calculator for Resale Sellers",
    description:
      "Listing fee, transaction fee, payment processing and offsite ads, applied to a vintage or resale listing so you can see the payout before you set the price.",
    h1: "Etsy fee calculator",
    cardBlurb: "Listing, transaction, processing and offsite ads on one vintage listing.",
    primaryKeyword: "etsy fee calculator",
    handoff: {
      surface: "crosslisting",
      heading: "You compared five platforms. You can list on all of them",
      body: "The spread between the best and worst platform on one item is real money, and the answer changes item by item. FlipDesk builds the listing once and publishes it to eBay and Shopify by API, and to Poshmark, Mercari and Grailed through the browser extension.",
      cta: "See how FlipDesk crosslists",
    },
    secondaryKeywords: [
      "etsy fees",
      "how much does etsy take",
      "etsy offsite ads fee",
    ],
    intro:
      "Etsy has the lowest headline rate of the five and is not the cheapest, because the headline rate is three fees short of the answer. The 6.5% transaction fee is charged on the item price plus the shipping you collect. Under it sits 3% plus $0.25 payment processing, and under that a $0.20 listing fee charged when you list and again every four months whether the item sells or not. Then there is Offsite Ads, which is 15%, becomes 12% and mandatory once your shop passes $10,000 in a rolling year, and cannot be switched off after that for the life of the shop.",
    faqs: [
      {
        q: "How much does Etsy take from a sale?",
        a: "For a US seller: 6.5% of the item price plus shipping, plus 3% and $0.25 for payment processing, plus $0.20 for the listing. On a $40 item with $8 shipping that is $5.01 in total, or 12.5% of the item price. The 6.5% on its own would have been $3.12.",
      },
      {
        q: "What are Etsy Offsite Ads and can I turn them off?",
        a: "Etsy advertises your listings on Google, social platforms and partner sites, and charges you when a buyer clicks one and buys within 30 days. The fee is 15% if your shop has always made under $10,000 in a rolling 365-day period, and you can opt out. Once the shop passes $10,000 the rate drops to 12% and participation becomes mandatory for the lifetime of the shop, even if sales fall back below the threshold.",
      },
      {
        q: "Does Etsy charge a fee on shipping?",
        a: "Yes. The 6.5% transaction fee applies to the total order, which includes any shipping and gift wrap you charge the buyer. Offering free shipping does not avoid it, because the cost is inside the item price instead, and Etsy charges on that too.",
      },
      {
        q: "Is Etsy worth it for reselling used clothing?",
        a: "Etsy's rules require handmade, vintage over 20 years old, or craft supplies, so ordinary used clothing does not belong there at all. Genuine vintage does, and it is one of the better places for it. If your inventory is mostly recent secondhand, the fee comparison is beside the point: check the category rules first.",
      },
    ],
  },
  {
    slug: "reseller-profit-calculator",
    status: "live",
    story: "US-9006",
    audience: "seller",
    title: "Reseller Profit Calculator With Condition",
    description:
      "Cost of goods, fees, shipping and the item's condition grade, worked through to net profit, margin and ROI. The condition adjustment is shown, not buried.",
    h1: "Reseller profit calculator",
    cardBlurb:
      "The only one that adjusts the sale price for what condition the item is actually in.",
    primaryKeyword: "reseller profit calculator",
    handoff: {
      surface: "comps",
      heading: "The comp you typed in was the hard part",
      body: "Everything on this page rests on one number you had to go and find, for one item. FlipDesk pulls comparable eBay listings per item and keeps them condition-aware, so you are pricing an Excellent piece against comparable Excellent ones rather than against an average of mint and worn. It also says whether the number is an asking price or one of your own realised sales, which is the part that decides how much to trust it.",
      cta: "See how FlipDesk prices by condition",
    },
    secondaryKeywords: [
      "ebay profit calculator",
      "resale profit margin calculator",
      "flipping profit calculator",
    ],
    intro:
      "Every other profit calculator asks what the item will sell for. That is the number you do not know, and the one you get wrong, because you took it from a comp of an item in better condition than yours. This one asks for the comp AND what condition that comp was in, then moves the price to the condition your item is actually in. The adjustment comes from GradeThread's own Condition Index, which is built from active eBay listings rather than sold ones, with a spread wide enough that it is printed next to the average rather than hidden behind it.",
    faqs: [
      {
        q: "How do I work out resale profit?",
        a: "Sale price plus any shipping you charge, minus the marketplace's fees, minus what the item cost you, minus the postage you pay. The arithmetic is easy. The hard part is the sale price, which is why this calculator spends most of its inputs on getting that number honest rather than on the subtraction.",
      },
      {
        q: "Why does condition change the price so much?",
        a: "Because it is the largest single lever on a used garment, larger than the brand for anything below the designer tier. Across the Condition Index, a 7.0 is listed at a median 65% of what a mint example asks and a 5.0 at 44%. Price a 7.0 off a mint comp and you have overpriced it by a third before you started.",
      },
      {
        q: "What condition is a typical sold comp in?",
        a: "Better than yours, usually. Listings that sell well are the ones photographed carefully and described fully, which correlates with the item being in good shape. Assuming a comp is a 9 rather than a 10 is a safer default, and the calculator defaults to that.",
      },
      {
        q: "Is the condition adjustment the same for every item?",
        a: "No, and that is the most useful thing on this page. At grade 9.0 the share of mint price ranges from 53% to 100% across the items measured. Carhartt double knee pants are listed at the same price at 8.0 as at 10.0; a Lululemon Scuba hoodie loses 20% over the same drop. If your item is in the Condition Index, pick it and the calculator uses its own measured curve instead of the average.",
      },
      {
        q: "What margin should a reseller aim for?",
        a: "There is no universal number, but the shape of the answer is: your margin has to survive a return, and roughly one sale in ten comes back on most clothing platforms. A 15% margin does not survive that; a 40% one does. Run the calculator at the grade you think the item is and again a full point lower, and see whether the worse case still clears.",
      },
    ],
  },
  {
    slug: "measurement-converter",
    status: "live",
    story: "US-9007",
    audience: "both",
    title: "Clothing Measurement Converter and Size Chart",
    description:
      "Convert US, UK, EU and JP sizing, and inches to centimetres for pit to pit, length, sleeve, waist and inseam, with where on the garment each is taken.",
    h1: "Measurement and size converter",
    cardBlurb: "US, UK, EU and JP sizing, plus where on the garment each measurement is taken.",
    primaryKeyword: "clothing measurement converter",
    handoff: {
      surface: "inventory-management",
      heading: "Measure once, and have it on every listing",
      body: "Converting a measurement is quick. Typing the same nine measurements into four marketplace forms is not. FlipDesk keeps them on the item in your catalog, so they travel to every listing you publish from it.",
      cta: "See how FlipDesk stores measurements",
    },
    secondaryKeywords: [
      "international size conversion chart",
      "pit to pit measurement chart",
      "mens to womens size converter",
    ],
    intro:
      "A size label tells you which brand made the garment. A measurement tells you whether it fits. This converts between US, UK, EU and Japanese sizing, and between inches and centimetres, but the part worth reading first is the doubling: a garment measured flat gives you half the number your body has to fit through. A 21 inch pit to pit is a 42 inch chest. Get that one wrong and no size chart will save you.",
    faqs: [
      {
        q: "What does pit to pit mean, and do I double it?",
        a: "Pit to pit is the distance straight across a garment laid flat, from one armpit seam to the other. Yes, you double it. The garment is folded, so the tape only crosses half the circumference: a 21 inch pit to pit fits a 42 inch chest. The same doubling applies to a flat waist, hip and leg opening, and it is the most common misreading of a clothing listing.",
      },
      {
        q: "What size is a US 8 in UK and EU sizing?",
        a: "A women's US 8 is usually a UK 12, an EU 40 and a Japanese 13, which lands around a medium. Usually is doing real work in that sentence: no standards body governs clothing sizes, brands cut to their own blocks, and vanity sizing moves the number a full size in either direction. Use it to narrow down, then check the measurements.",
      },
      {
        q: "How do I convert men's sizes to women's?",
        a: "For shoes it is reliable: add 1.5 to a men's US size to get the women's equivalent, so a men's 8 and a women's 9.5 are the same shoe. For tops it is not. Men's and women's garments are cut differently through the shoulder, chest and waist, so the label converts but the fit may not. Compare the pit to pit and the shoulder before you buy.",
      },
      {
        q: "Why do size charts disagree with each other?",
        a: "Because none of them is authoritative. Clothing sizing has no governing standard in the US, UK, EU or Japan, so every chart is one brand's or one retailer's convention written down. That is why a measurement in inches or centimetres is the only number in a listing that means the same thing to everyone.",
      },
      {
        q: "How do I measure a garment I am selling?",
        a: "Lay it flat on a hard surface, smooth out the wrinkles, fasten any buttons or zips, and measure edge to edge without stretching the fabric. Give the flat number and say it is flat. Buyers who know the convention will double it, and the ones who do not will ask rather than return.",
      },
    ],
  },
  {
    slug: "ebay-sold-listings",
    status: "live",
    story: "US-9021",
    audience: "seller",
    title: "How to Check Sold Items on eBay",
    description:
      "Check what an item really sold for on eBay: the sold-listings filter, the three searches worth running, and the two things a sold price does not tell you.",
    h1: "How to check sold items on eBay",
    cardBlurb: "Builds the sold-listing searches worth running, and says what a sold price hides.",
    primaryKeyword: "how to check sold items on ebay",
    handoff: {
      surface: "comps",
      heading: "Three searches per item adds up",
      body: "Running the ladder by hand is fine for one garment and tedious for forty. FlipDesk builds the same searches per item and keeps the results attached to it, so the comp set is still there when you come back to reprice.",
      cta: "See how FlipDesk handles comps",
    },
    secondaryKeywords: [
      "how to check ebay sold listings",
      "how to check recently sold items on ebay",
      "how to find recently sold on ebay",
      "ebay sold listings search",
    ],
    intro:
      "Active listings tell you what sellers hope for. Sold listings tell you what someone paid, which is the only number worth pricing against, and eBay gives them away free behind a filter most people never find. Two catches, and both were measured on a real search rather than assumed. A sold search on eBay reaches back about 90 days and no further. And a large share of sold clothing results are marked Best offer accepted, which means the price shown is what the seller was asking, not what the buyer paid, so the true median sits somewhere below what you are reading.",
    faqs: [
      {
        q: "How do I check sold items on eBay?",
        a: "Search for the item, then scroll the left-hand filter column to Show only and tick Sold items. On the phone app it is under Filter, then Sold items. The faster route is the URL: adding LH_Sold=1&LH_Complete=1 to any eBay search does the same thing in one step, which is what the search builder above does for you. Sold results already arrive sorted by Ended Recently, so the top of the list is the most current.",
      },
      {
        q: "How far back do eBay sold listings go?",
        a: "About 90 days. Past that the listings drop off the search entirely, which is why a comp set for a seasonal item taken in August is not the same comp set you would have taken in February. If an item barely sells, three months may return too few results to price from, and the honest response is to widen the search rather than price off two data points.",
      },
      {
        q: "Why does eBay show Best offer accepted instead of a price?",
        a: "Because the buyer and seller agreed a price privately and eBay does not publish it. The number displayed is the asking price the listing carried, so the real sale was somewhere below it. On a live search of sold Patagonia fleeces on 2026-08-28, most of the results carried that label. Treat those as a ceiling, not a sale, and lean on the Buy It Now and auction results for your median.",
      },
      {
        q: "Are sold listings the same as what an item is worth?",
        a: "No, and the gap catches sellers out twice. An auction that closed at $29 with five bids and a Buy It Now that closed at $65 are both real sales of the same garment in different sale formats, and averaging them describes neither. Condition is the other half: a sold search cannot see whether the item that made $65 was mint or pilled, and condition is the largest single lever on resale price.",
      },
      {
        q: "Why is another brand showing up in my search?",
        a: "Because eBay is matching your words, not your garment. A search for Patagonia Synchilla fleece on 2026-08-28 returned a North Face fleece among the sold results, because the listing contained the words. Adding the category filter helps, keeping the brand name first helps more, and the brand-only search in the builder above exists so you can spot when one of your narrower searches has drifted.",
      },
      {
        q: "Can I see sold listings without an eBay account?",
        a: "Yes. Sold and completed listings are public, so the searches this page builds work signed out, on any device, and cost nothing. You only need an account to save a search and be told when comparable items sell.",
      },
    ],
  },
  {
    slug: "single-stitch-dating",
    status: "live",
    story: "US-9020",
    audience: "both",
    title: "Single Stitch Shirt: Dating a Vintage Tee",
    description:
      "What a single stitch shirt is, roughly when the hem changed, and the four other tells that have to agree with it before the date is worth paying for.",
    h1: "Single stitch shirts: dating a vintage tee",
    cardBlurb: "Combines the tells on a vintage tee and says when they contradict each other.",
    primaryKeyword: "single stitch shirt",
    handoff: {
      surface: "inventory-management",
      heading: "Dating one tee is quick. Dating a rail of them is not",
      body: "The tells are the same every time and so is the note you have to keep about them. FlipDesk holds the era, the blank and the flaws against the item, so the reason you priced it that way is still there when it sells three months later.",
      cta: "See how FlipDesk tracks items",
    },
    secondaryKeywords: [
      "single stitch t shirt",
      "single stitch vintage tee",
      "vintage single stitch shirt",
      "how to tell if a t shirt is vintage",
    ],
    intro:
      "A single stitch shirt has one line of stitching at the hem and sleeve openings rather than two, and it is the first thing resellers look for on a vintage tee. It earns that reputation: US-made blanks were built this way through the 1980s and the change to a double-needle hem spread through the middle 1990s, manufacturer by manufacturer rather than on a date. What it does not do is prove anything on its own. It is one line of stitching, which makes it the easiest tell on the garment to reproduce, and it is regularly contradicted by another tell on the same shirt. This checks the tells together and tells you when they disagree, which is the finding worth having.",
    faqs: [
      {
        q: "What is a single stitch shirt?",
        a: "A t-shirt hemmed with one line of stitching at the bottom hem and the sleeve openings, instead of the two parallel lines used on almost every modern blank. Turn the hem over and look at the underside: one row of thread is single stitch, two rows is double. It is a construction detail rather than a brand or a style.",
      },
      {
        q: "Does single stitch mean a shirt is from before 1994?",
        a: "Not on its own, and the single year is the part to be careful with. Single-needle hems were standard on US-made blanks through the 1980s and were phased out across the middle 1990s by different manufacturers at different times, so the honest range is wide. Small modern runs and reproduction blanks still use it, which is why a page quoting one year is more confident than the evidence.",
      },
      {
        q: "What is the most reliable way to date a vintage t-shirt?",
        a: "The copyright or event year printed on the graphic, because a shirt cannot be older than the artwork on it. That makes it a hard floor rather than a hint, and it is the tell most guides skip past on the way to the stitch. It does not give you a ceiling: an old copyright line gets reprinted on new blanks, so pair it with the construction.",
      },
      {
        q: "Can single stitch be faked?",
        a: "Easily. It is one line of stitching, and blanks made to read as vintage use it deliberately. The tell that catches it is a contradiction elsewhere on the garment: a tagless heat-transferred neck label belongs to the 2000s and cannot honestly share a shirt with a 1980s hem. When two tells disagree, price it as modern until something independent settles it.",
      },
      {
        q: "Is a single stitch tee worth more?",
        a: "It carries a premium on resale sites, which is exactly why the claim needs checking rather than repeating. Age and condition are separate questions, and the second one is what a buyer actually pays for: a genuinely old tee with a cracked print, thin shoulders and pinholes is an old shirt in poor condition. Dating the blank also says nothing about whether the print is a licensed original or a later bootleg on period stock.",
      },
    ],
  },
  {
    slug: "reseller-inventory-spreadsheet",
    status: "live",
    story: "US-9022",
    audience: "seller",
    title: "Free Reseller Inventory Spreadsheet",
    description:
      "A free reseller inventory spreadsheet for clothing: source, cost, bin, condition grade, fees and net profit, with the arithmetic already written. No email.",
    h1: "Free reseller inventory spreadsheet",
    cardBlurb: "A real file with the profit columns written, and a condition grade column no generic template has.",
    primaryKeyword: "reseller inventory spreadsheet",
    handoff: {
      surface: "inventory-management",
      heading: "Where a spreadsheet stops being the right tool",
      body: "A spreadsheet is genuinely fine for a long time. It stops being fine at the point where the same item has to exist on three marketplaces at once and the fees arrive as a payout you have to unpick. That is bookkeeping and crosslisting, not tracking, and it is where FlipDesk starts.",
      cta: "See how FlipDesk tracks inventory",
    },
    secondaryKeywords: [
      "resell spreadsheet",
      "free reseller spreadsheet template",
      "reseller inventory spreadsheet free",
      "inventory spreadsheet for resellers",
    ],
    intro:
      "Here is the file. It is a CSV, which means Excel, Numbers and Google Sheets all open it and all three keep the formulas working, so net profit, margin and days-to-sell calculate themselves the moment you type a sold price. No email address, no signup. It has nineteen columns and one of them is the reason this page exists: a condition grade from 1.0 to 10.0. Every generic reseller template tracks cost, price and fees. None of them tracks the thing that moves resale price most, so none of them can tell you afterwards whether the beat-up ones were worth buying.",
    faqs: [
      {
        q: "What should a reseller inventory spreadsheet track?",
        a: "Four groups. What it is and where it is: SKU, bin, brand, item, size. What it cost you: date sourced, source, cost. What you did with it: date listed, listed price, platform. And what happened: date sold, sold price, fees, shipping. Net profit, margin and days-to-sell should be calculated from those rather than typed, because a number you type is a number that goes stale.",
      },
      {
        q: "Why track condition in a spreadsheet?",
        a: "Because it is the largest single lever on what a used garment makes, and without it your history cannot answer the most useful question you will ask it: which items were actually worth buying. Two Patagonia fleeces bought at the same price and sold six weeks apart for very different money look like luck in a normal spreadsheet. With a grade in the row it is not luck, it is a sourcing rule.",
      },
      {
        q: "Does the free spreadsheet work in Google Sheets?",
        a: "Yes. Download it, then in Google Sheets use File then Import and choose Replace spreadsheet, or drag the file into Drive. The calculated columns arrive as live formulas rather than as text. Excel and Numbers open it directly by double-clicking, with the same result.",
      },
      {
        q: "When should a reseller stop using a spreadsheet?",
        a: "Later than most software wants you to believe. A spreadsheet is fine while one item lives on one marketplace and you enter its outcome once. The point it stops being fine is specific: the same garment listed in three places at once, where a sale in one has to end the other two, and payouts that arrive as a lump sum you have to unpick back to individual items. That is when the file starts costing more time than it saves.",
      },
      {
        q: "Is there a catch to the free download?",
        a: "No email, no account, and nothing you type is sent anywhere. The file is generated in your browser when you click, which is also why it can never be out of date with the column guide above it.",
      },
    ],
  },
  {
    slug: "photograph-clothes-to-sell",
    status: "live",
    story: "US-9023",
    audience: "seller",
    title: "How to Take Pictures of Clothes to Sell",
    description:
      "The shot list, the order it goes in, and how to light a garment without a studio. Plus how to photograph a flaw so it cuts returns instead of the sale.",
    h1: "How to take pictures of clothes to sell",
    cardBlurb: "The shot list per category, in the order buyers read it, from the app's own profiles.",
    primaryKeyword: "how to take pictures of clothes to sell",
    handoff: {
      surface: "autolister",
      heading: "The photos are also the listing",
      body: "Once the shots are right they carry more than the gallery. FlipDesk reads them to draft the title, the item specifics and the condition, so the twenty minutes you spent photographing properly is also the twenty minutes you did not spend typing.",
      cta: "See what FlipDesk does with the photos",
    },
    secondaryKeywords: [
      "how to photograph clothes to sell",
      "how to take photos of clothes to sell online",
      "how to photograph clothing for resale",
    ],
    intro:
      "Photos are the whole listing. A buyer decides on the thumbnail, checks the detail shots, and returns the item over something you did not show. So this is two things and the second one is the half other guides skip: the shot list, in the order buyers read it, and how to photograph a flaw so it prevents a return rather than costing you the sale. The shot list below is the one GradeThread's own app uses, not a generic one, which is why it changes by category.",
    faqs: [
      {
        q: "How do you take good pictures of clothes to sell?",
        a: "Lay the garment flat on a plain surface in daylight, shoot straight down from above so nothing keystones, and take the same crop on the front and the back. Then get closer: the brand label, the size tag, the care label, a fabric close-up, and a tight shot of every flaw. Flat and honest beats styled and flattering, because the styled photo is what the return is argued about.",
      },
      {
        q: "What photos do you need to sell clothes online?",
        a: "Two are non-negotiable, front and back, and they should be the same crop as each other. After that the ones that actually get asked about are the brand label, the size tag, the care and fabric label, a close-up of the material, and every defect. Measurements photographed against a tape are worth more than measurements typed into the description, because a buyer can check them.",
      },
      {
        q: "What order should listing photos go in?",
        a: "Front, back, tags, details, measurements, defects, then anything extra. The first image is doing a different job from the rest: it competes in a grid of thumbnails against every other seller, so it wants the whole garment, filling the frame, on a plain ground. Detail shots go after because nobody scrolls past a thumbnail they did not stop on.",
      },
      {
        q: "How do you photograph a flaw without killing the sale?",
        a: "Shoot it tight, in even light, with something for scale, and photograph it once rather than from five angles. The instinct is to hide it and the arithmetic says otherwise: a disclosed flaw costs you a percentage of the price, and an undisclosed one costs you the item, the postage both ways and the marketplace case. A buyer who can see the flaw and buys anyway does not open a not-as-described claim.",
      },
      {
        q: "Do you need a lightbox or special lighting?",
        a: "No, and buying one is usually the wrong first purchase. Daylight from a window at midday, with the garment on the floor or a table and your body not casting a shadow across it, beats most cheap lightboxes. What actually helps: a plain mid-tone surface, turning off the room light so you are not mixing warm bulbs with daylight, and taking every photo of one item in the same spot so the colour matches across the gallery.",
      },
      {
        q: "Should you shoot flat lay or on a model?",
        a: "Flat for the truth, on a hanger or model for the shape. Flat lay is where measurements and flaws are legible, so it belongs in the required shots. A hanger or model shot shows drape and how it actually falls, which flat lay flattens away, so it earns a place in the gallery but not the first slot on most marketplaces.",
      },
    ],
  },
];

export const CALCULATOR_HUB_META = {
  path: CALCULATOR_HUB_PATH,
  title: "Free Reseller Calculators: Fees and Profit",
  description:
    "Free calculators for people who sell used clothing: marketplace fees, shipping cost, and profit that accounts for the item's condition. No signup, no account.",
  h1: "Reseller calculators",
  // US-9021/US-9020 widened this beyond fees and postage. The title still
  // targets "reseller calculators" because that is what the page ranks for, but
  // an intro that only described calculators would have been describing two
  // thirds of the list.
  intro:
    "Every one of these answers a question you would otherwise guess at: what a sale nets after fees, what postage will cost before you list, whether an item is worth buying once its condition is priced in, where to find what comparable garments really sold for on eBay, and how old the tee in your hand really is. They run in your browser, they need no account, and the fee schedules are dated so you can see which rates a result used.",
  faqs: [
    {
      q: "Are these calculators free?",
      a: "Yes, all of them, with no account and no signup. They run in your browser and nothing you type is sent anywhere.",
    },
    {
      q: "How current are the fee rates?",
      a: "Each fee schedule carries the date it took effect, and the calculator states which schedule produced your result. When a marketplace changes its rates, the schedule is updated and the effective date moves with it.",
    },
    {
      q: "Why does the profit calculator ask for a condition grade?",
      a: "Because condition is the largest single lever on resale price, and a comp taken from a mint example will overstate what a worn one sells for. The calculator adjusts the estimated sale price for the grade you enter and shows the adjustment it applied rather than folding it into the total.",
    },
  ],
};

/** The page module backing a calculator, defaulting to one file per slug. */
export function calculatorPageModule(calc: Calculator): string {
  return calc.pageModule ?? `tools/${calc.slug}`;
}

/**
 * A live calculator's FlipDesk handoff, or a throw. Optional on the type so a
 * planned entry can be registered before its copy exists, required in practice
 * once the calculator is live — same guard shape as calculatorContent().
 */
export function calculatorHandoff(calc: Calculator): NonNullable<Calculator["handoff"]> {
  if (!calc.handoff) {
    throw new Error(`[calculators] "${calc.slug}" is live but has no FlipDesk handoff`);
  }
  return calc.handoff;
}

/** Only calculators whose compute has shipped. */
export function liveCalculators(): Calculator[] {
  return CALCULATORS.filter((c) => c.status === "live");
}

/**
 * A live entry's page content, or a throw. `intro` and `faqs` are optional on
 * the type so a planned entry can be registered before its copy is written, but
 * a LIVE one without them would prerender an empty page, which is the failure
 * the status flag exists to prevent. Guarded here rather than at every call site.
 */
export function calculatorContent(calc: Calculator): {
  intro: string;
  faqs: { q: string; a: string }[];
} {
  if (!calc.intro || !calc.faqs?.length) {
    throw new Error(`[calculators] "${calc.slug}" is live but has no intro or faqs`);
  }
  return { intro: calc.intro, faqs: calc.faqs };
}

export function getCalculatorBySlug(slug: string): Calculator | undefined {
  return CALCULATORS.find((c) => c.slug === slug);
}

export function getCalculatorByPath(path: string): Calculator | undefined {
  const norm = path.replace(/\/+$/, "");
  return CALCULATORS.find((c) => calculatorPath(c.slug) === norm);
}

export function isCalculatorHubPath(path: string): boolean {
  return path.replace(/\/+$/, "") === CALCULATOR_HUB_PATH;
}

/**
 * The hub plus every LIVE calculator. Spread into PUBLIC_ROUTES.
 *
 * Planned entries are deliberately absent: registering a route before its
 * compute exists ships a page that promises a calculator and renders nothing.
 *
 * The hub follows the same rule. With nothing live it is an empty list page,
 * which is a worse result than no page at all, so the family registers NOTHING
 * until the first calculator ships. That makes US-9002 (this file and its
 * wiring) and US-9003 (the first calculator) land together by construction.
 */
export function calculatorRoutes(): PublicRoute[] {
  const live = liveCalculators();
  if (live.length === 0) return [];
  const routes: PublicRoute[] = [
    {
      path: CALCULATOR_HUB_PATH,
      title: CALCULATOR_HUB_META.title,
      description: CALCULATOR_HUB_META.description,
      changefreq: "monthly",
      priority: 0.7,
      jsonLdType: "CollectionPage",
    },
  ];
  for (const c of live) {
    routes.push({
      path: calculatorPath(c.slug),
      title: c.title,
      description: c.description,
      changefreq: "monthly",
      priority: 0.7,
      jsonLdType: "WebApplication",
    });
  }
  return routes;
}
