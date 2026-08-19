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
  /** Supporting keywords, woven into copy and headings. */
  secondaryKeywords?: string[];
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
    story: "US-9005",
    audience: "seller",
    title: "Poshmark Fee Calculator: What Poshmark Takes",
    description:
      "What Poshmark keeps from a sale and what lands in your account, with the flat fee on small orders and the commission above it applied to the number you enter.",
    h1: "Poshmark fee calculator",
    cardBlurb: "The flat fee, the commission, and where the cutoff between them falls.",
    primaryKeyword: "how much does poshmark take",
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
    story: "US-9005",
    audience: "seller",
    title: "Mercari Fee Calculator: Your Real Payout",
    description:
      "What Mercari takes from a sale, including the selling fee, the payment processing cut and the shipping choice that decides which side pays the postage.",
    h1: "Mercari fee calculator",
    cardBlurb: "Selling fee, processing cut, and who ends up paying the postage.",
    primaryKeyword: "mercari fee calculator",
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
    story: "US-9005",
    audience: "seller",
    title: "Depop Fee Calculator: What You Keep on a Sale",
    description:
      "What Depop keeps from a sale after the selling fee and payment processing, and what the same item would net you on eBay, Poshmark, Mercari or Etsy instead.",
    h1: "Depop fee calculator",
    cardBlurb: "Depop's cut, next to what the same item nets on four other platforms.",
    primaryKeyword: "depop fee calculator",
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
    story: "US-9005",
    audience: "seller",
    title: "Etsy Fee Calculator for Resale Sellers",
    description:
      "Listing fee, transaction fee, payment processing and offsite ads, applied to a vintage or resale listing so you can see the payout before you set the price.",
    h1: "Etsy fee calculator",
    cardBlurb: "Listing, transaction, processing and offsite ads on one vintage listing.",
    primaryKeyword: "etsy fee calculator",
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
    status: "planned",
    story: "US-9006",
    audience: "seller",
    title: "Reseller Profit Calculator With Condition",
    description:
      "Cost of goods, fees, shipping and the item's condition grade, worked through to net profit, margin and ROI. The condition adjustment is shown, not buried.",
    h1: "Reseller profit calculator",
    cardBlurb:
      "The only one that adjusts the sale price for what condition the item is actually in.",
    primaryKeyword: "reseller profit calculator",
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
];

export const CALCULATOR_HUB_META = {
  path: CALCULATOR_HUB_PATH,
  title: "Free Reseller Calculators: Fees and Profit",
  description:
    "Free calculators for people who sell used clothing: marketplace fees, shipping cost, and profit that accounts for the item's condition. No signup, no account.",
  h1: "Reseller calculators",
  intro:
    "Every one of these answers a question you would otherwise guess at: what a sale nets after fees, what postage will cost before you list, and whether an item is worth buying once its condition is priced in. They run in your browser, they need no account, and the fee schedules are dated so you can see which rates a result used.",
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

export function calculatorBreadcrumbItems(
  calc: Calculator,
): Array<{ name: string; path: string }> {
  return [
    { name: "GradeThread", path: "/" },
    { name: "Calculators", path: CALCULATOR_HUB_PATH },
    { name: calc.h1, path: calculatorPath(calc.slug) },
  ];
}

export function calculatorHubBreadcrumbItems(): Array<{ name: string; path: string }> {
  return [
    { name: "GradeThread", path: "/" },
    { name: "Calculators", path: CALCULATOR_HUB_PATH },
  ];
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
