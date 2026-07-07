// The returns spine (US-1673): /reselling/reduce-ebay-returns.
//
// The DESIGNATED crossover between the listing/reselling universe (Universe-B)
// and the grading moat. Every reselling/comparison page links here with the
// "returns are the #1 margin killer → condition accuracy fixes it" framing, and
// this page links HARD into the grading moat. The canonical grading entry is
// /grading/scale and certificate verification is /verify — the AC's literal
// /grading/ and /grading/certificate/ paths don't exist, so we link the real
// equivalents (documented so the interlinker rules, US-1674, target these).
//
// PURE DATA: imports only the PublicRoute TYPE. JSON-LD (Article + FAQPage) is
// composed in src/pages/marketing/marketing-jsonld.ts.

import type { PublicRoute } from "./public-routes";

export const RETURNS_SPINE_PATH = "/reselling/reduce-ebay-returns";

/** A top eBay return reason that traces to condition, and the disclosure that prevents it. */
export interface ReturnReason {
  reason: string;
  /** Why it happens — the condition-mismatch mechanism. */
  why: string;
  /** The disclosure workflow that prevents it. */
  fix: string;
}

export interface ReturnsSpineSection {
  heading: string;
  body: string;
}

export const RETURNS_SPINE = {
  path: RETURNS_SPINE_PATH,
  title: "How to Reduce eBay Returns",
  description:
    "The top eBay return reasons trace back to condition mismatch. Here's the disclosure workflow that prevents each — and what accurate condition can't fix.",
  h1: "How to reduce eBay returns: the condition-accuracy playbook",
  definition:
    "Most eBay clothing returns are not defects — they're expectation gaps. A buyer opens the package, decides the item is more worn than the listing implied, and files a 'not as described' claim. The single highest-leverage way to reduce eBay returns is to close that expectation gap before the buyer pays, with accurate, verifiable condition disclosure.",
  intro:
    "Returns are the #1 silent margin killer in reselling — you eat the item, shipping both ways, and a hit to your seller metrics. Most of them trace to condition, not to genuine defects. This page maps the top condition-driven return reasons to the disclosure that prevents each, and is honest about the returns disclosure can't stop.",
  reasons: [
    {
      reason: "\"Item not as described\" — more worn than expected",
      why: "The listing said \"good used condition\" and the buyer pictured better. Free-text condition is an opinion the buyer can't verify, so they fill the gap with hope — and the return is what happens when reality misses it.",
      fix: "Replace the adjective with a standardized grade the buyer can verify before paying. An objective 1.0–10.0 condition grade means the same thing on your listing as anyone's, so there's no gap to fill.",
    },
    {
      reason: "Undisclosed flaw (stain, pilling, hole, odor)",
      why: "A flaw that's obvious in hand but easy to miss in a quick listing photo. The buyer feels misled even if the omission was accidental.",
      fix: "Photograph and annotate every flaw, and let the grade's factor breakdown surface it. Disclosed flaws priced in almost never become returns; hidden ones almost always do.",
    },
    {
      reason: "Condition worse than comparable listings",
      why: "The buyer compared your listing to others at the same price in better shape and felt they overpaid for the condition.",
      fix: "Price to sold comps in the SAME graded condition, not to the top of the range. A grade makes your price defensible against the comp set.",
    },
    {
      reason: "Color/material not as pictured",
      why: "Lighting and screens distort color and sheen; a buyer expecting one thing receives another.",
      fix: "Use accurate item specifics and neutral-light photos, and describe material honestly. This is disclosure, not grading — but it belongs in the same accuracy discipline.",
    },
  ] as ReturnReason[],
  sections: [
    {
      heading: "Why condition drives most eBay returns",
      body: "eBay resolves 'not as described' cases in the buyer's favor by default, and the burden of proving the item matched the listing falls on you. That makes condition the highest-stakes variable in any clothing listing: get it wrong and you lose the sale, the shipping, and standing with the platform. Accurate condition up front is the cheapest insurance a reseller has.",
    },
    {
      heading: "The disclosure workflow that prevents them",
      body: "Grade each item on a standardized scale, photograph and annotate every flaw, price to comps in that graded condition, and attach a verifiable certificate the buyer can check before they buy. Each step removes an expectation gap — and every gap you remove is a return that never happens.",
    },
    {
      heading: "What disclosure can't fix",
      body: "Be honest: accurate condition disclosure prevents condition returns, not every return. It won't fix fit — a buyer who ordered the wrong size will still return it, and no grade changes that. It won't stop buyer's remorse or 'changed my mind' returns. What it does is eliminate the one category of return that's both the largest and entirely within your control: condition mismatch.",
    },
  ] as ReturnsSpineSection[],
  faqs: [
    {
      q: "What is the most common reason for eBay clothing returns?",
      a: "\"Item not as described\" over condition — the buyer decides the item is more worn or flawed than the listing implied. It's an expectation gap, not usually a genuine defect, and it's the return category most within a seller's control through accurate condition disclosure.",
    },
    {
      q: "How do I reduce 'not as described' returns on eBay?",
      a: "Close the expectation gap before the buyer pays: grade condition on a standardized scale, photograph and disclose every flaw, price to sold comps in that condition, and attach a verifiable certificate. Disclosed condition the buyer can verify leaves nothing for them to feel misled about.",
    },
    {
      q: "Can accurate condition disclosure stop all returns?",
      a: "No — and it's important to be honest about that. It prevents condition-mismatch returns, which are the largest and most controllable category, but it won't fix fit/sizing returns or buyer's remorse. It eliminates the returns you can control, not the ones you can't.",
    },
    {
      q: "Does a condition grade help if a buyer opens a dispute anyway?",
      a: "Yes. eBay puts the burden of proof on the seller, and an objective third-party condition grade plus a certificate is documentation that you disclosed accurately — which both reduces disputes and strengthens your position when one is opened.",
    },
  ],
};

export function isReturnsSpinePath(path: string): boolean {
  return path.replace(/\/+$/, "") === RETURNS_SPINE_PATH;
}

export function returnsSpineRoute(): PublicRoute {
  return {
    path: RETURNS_SPINE_PATH,
    title: RETURNS_SPINE.title,
    description: RETURNS_SPINE.description,
    changefreq: "monthly",
    priority: 0.7,
    jsonLdType: "Article",
  };
}
