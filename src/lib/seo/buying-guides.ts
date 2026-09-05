// The buyer-trust cluster (US-3093), served under /buying.
//
// `is vinted legit`, `is mercari legit`, `is poshmark legit` and `is depop
// legit` are about 155,000/mo between them, three of the four Low competition,
// with advertisers bidding up to $56.01. An August 2026 note dismissed them as
// unmonetisable, which was true then: that was before the buyer extension and
// the creator affiliate programme existed. It is a buyer question with a
// product answer now.
//
// ── WHY THIS IS CONTAINED, AND CONTAINED DIFFERENTLY FROM /care ─────────────
//
// /care is contained because it is enormous and off-topic. This is contained
// because it is written for the WRONG PERSON. GradeThread's customer is a
// seller; every page here is read by a buyer who is one click from paying a
// stranger. Showing them /pricing is answering "am I about to be scammed" with
// a $29/month reseller tool.
//
// So: nothing links in (isCrossHubLinkAllowed refuses it), and the only product
// surface these pages link out to is the extension install, which is the thing
// that actually answers the question they arrived with.
// buying-containment.test.ts holds both halves.
//
// ── ONE PAGE, DELIBERATELY ─────────────────────────────────────────────────
//
// US-3093 AC3: /buying/is-vinted-legit ships first because that term is
// competition index 3, growing, and bids $21.67. The other three ship only if
// US-3087's SERP check marks them OPEN. A term that comes back BLOCKED gets a
// note on the story, never a page.
//
// PURE DATA: imports only the PublicRoute TYPE and the freshness key type.

import type { PublicRoute } from "./public-routes";
import type { FreshnessGroup } from "./freshness";

export const BUYING_HUB_PATH = "/buying";

export interface BuyingSection {
  heading: string;
  body: string;
}

export interface BuyingGuide {
  slug: string;
  /** The marketplace this page is about, as a reader writes it. */
  marketplace: string;
  /** <title> without the " | GradeThread" suffix — ≤ 46, unique. */
  title: string;
  /** Meta description — 70–160, unique. */
  description: string;
  h1: string;
  /**
   * THE ANSWER, IN THE FIRST PARAGRAPH (AC4). Somebody who searched "is X
   * legit" is deciding whether to hand money to a stranger in the next minute.
   * Making them read four sections to find out is answering a different
   * question than the one they asked.
   */
  answer: string;
  sections: BuyingSection[];
  /** The freshness group whose re-verification date stamps the figures here. */
  freshnessGroup: FreshnessGroup;
  faqs: Array<{ q: string; a: string }>;
}

export function buyingGuidePath(slug: string): string {
  return `${BUYING_HUB_PATH}/${slug}`;
}

export const BUYING_GUIDES: BuyingGuide[] = [
  {
    slug: "is-vinted-legit",
    marketplace: "Vinted",
    title: "Is Vinted Legit? A Buyer's Answer",
    description:
      "Yes, Vinted is real and your money is held until you confirm. What the buyer protection fee covers, the 2-day window, the scams, and how to check a listing.",
    h1: "Is Vinted legit?",
    answer:
      "Yes. Vinted is a real marketplace, and it runs in all 50 US states, Washington D.C. and Puerto Rico. Your money is held rather than handed straight to the seller, and the fee you pay at checkout is what buys you the right to raise a claim. The risk is not that the platform is fake. It is that you have two days after delivery to notice a problem, and the evidence you need has to already exist.",
    sections: [
      {
        heading: "What the fee you pay actually buys",
        body:
          "Every Vinted order adds a Buyer Protection fee: a fixed $0.70 plus 5% of the item price, not counting shipping. That is not a service charge for nothing. It is what puts your payment in escrow rather than in the seller's account, and it is what gives you a claim if the item does not arrive or is not what was described. The seller pays no commission, which is why prices run lower here than on Poshmark or Mercari, and why the fee sits on your side of the transaction instead of theirs.",
      },
      {
        heading: "The two days that decide everything",
        body:
          "Once the parcel is marked delivered, you have 2 calendar days to report a problem. Raise one and the order is suspended and the seller's payment is held while Vinted looks at it. Let those two days pass and the order completes, the money reaches the seller, and Vinted states it can no longer offer a refund, compensation or a return. Its answer to a late complaint is to contact the seller directly, which means the goodwill of a stranger. So open the parcel the day it arrives, even if you are not going to wear the thing for a month.",
      },
      {
        heading: "What settles a claim, and what to photograph",
        body:
          "Vinted asks for photographs of the item and the problem, the outer and inner packaging, and any visible damage to the packaging. Take those before you unpack properly, not after, because a picture of a jacket on your bed proves nothing about how it arrived. Depending on the claim the outcome is a refund with no return, or a return you then have 5 business days to post. For a parcel that was lost or damaged in transit there is no return at all: the refund follows the shipping company confirming what happened, and that investigation can take several weeks.",
      },
      {
        heading: "The scams buyers actually meet",
        body:
          "The first is the move off-platform. A seller offers a lower price for a direct bank transfer, and Vinted's own community standards are blunt about what that costs you: buying outside its secure payment system means no Buyer Protection applies. There is no escrow, no claim and no route back. The second is the item that is not as described, which is what the two-day window exists for. The third is the counterfeit. Vinted prohibits counterfeits outright and offers an Item Verification service on eligible designer listings, where the order ships to a verification hub and is checked by hand before it reaches you, with the fee shown on the item page and at checkout and the item returned to the seller if it fails.",
      },
      {
        heading: "How to check a listing before you pay",
        body:
          "Read the condition option against the photos rather than the words. Vinted's options are New, Like new, Very good, Good and Satisfactory, and its two unworn options split on packaging rather than tags: New means unopened in its original packaging, Like new means unused but opened. A seller who picked Very good and photographed a hem coming away has told you two different things, and the photograph is the one that will be true when it arrives. Ask for a picture of any area the listing does not show. A seller who will not photograph the armpits of a $60 sweater has answered your question.",
      },
    ],
    freshnessGroup: "vinted",
    faqs: [
      {
        q: "Is Vinted safe for buyers?",
        a: "It is, as long as you pay through Vinted and check the parcel quickly. Your payment is held rather than passed to the seller, and the Buyer Protection fee at checkout is what gives you a claim if the item does not arrive or is not as described. What is not covered is a payment made outside the platform: Vinted's community standards say Buyer Protection does not apply to a direct bank transfer.",
      },
      {
        q: "What does the Vinted Buyer Protection fee cover?",
        a: "It holds your payment until you confirm the order, and it gives you the right to report a problem and get a refund. The fee is a fixed $0.70 plus 5% of the item price, shipping excluded, and you pay it on top of the price and the postage. Sellers pay no commission, which is the trade: the fee is on the buyer's side here rather than the seller's.",
      },
      {
        q: "How long do I have to report a problem on Vinted?",
        a: "2 calendar days from the delivery notification. Inside that window the order is suspended and the seller's payment is held while the claim is looked at. After it closes, Vinted states it can no longer offer a refund, compensation or a return, and tells you to contact the seller directly.",
      },
      {
        q: "Can you get scammed on Vinted?",
        a: "The common ones are a seller asking you to pay outside the platform, an item that is not as described, and a counterfeit. The first is the only one with no protection at all, because Buyer Protection does not apply to a direct transfer. For the second, photograph the item and both layers of packaging and report inside the two days. For the third, Vinted prohibits counterfeits and offers Item Verification on eligible designer listings, where the order is checked by hand at a verification hub before it reaches you.",
      },
    ],
  },
];

const BY_SLUG = new Map(BUYING_GUIDES.map((g) => [g.slug, g]));
const BY_PATH = new Map(BUYING_GUIDES.map((g) => [buyingGuidePath(g.slug), g]));

export function getBuyingGuideBySlug(slug: string): BuyingGuide | undefined {
  return BY_SLUG.get(slug);
}
export function getBuyingGuideByPath(path: string): BuyingGuide | undefined {
  return BY_PATH.get(path.replace(/\/+$/, "") || "/");
}

/** PublicRoute entries for every buying guide. There is no hub index page yet. */
export function buyingRoutes(): PublicRoute[] {
  return BUYING_GUIDES.map((g) => ({
    path: buyingGuidePath(g.slug),
    title: g.title,
    description: g.description,
    changefreq: "monthly",
    priority: 0.5,
    jsonLdType: "Article",
  }));
}
