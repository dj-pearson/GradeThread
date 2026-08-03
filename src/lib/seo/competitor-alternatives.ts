// Competitor "alternative" pages (bottom-funnel): /reselling/<competitor>-alternative.
//
// WHY THESE EXIST, given /reselling/best-crosslisting-apps already compares the
// same tools: "vendoo alternative" is a DIFFERENT query from "best crosslisting
// app". The searcher already owns a tool, already pays for it, and is actively
// unhappy — the highest commercial intent available to us. A general roundup
// does not rank for brand-modifier queries, and does not answer the question the
// searcher actually has ("should I leave, and for what?").
//
// The existing /compare/* set targets marketplace-vs-marketplace ("mercari vs
// ebay") — informational, brutally competitive, and someone comparing where to
// SELL is not shopping for a listing tool. This is the commercial-intent gap.
//
// HONESTY IS THE STRATEGY, not a constraint. Each page leads with what the
// competitor genuinely does well and tells the reader when to STAY. A page that
// answers "you should probably keep Vendoo" for the right reader is the one that
// earns the click, the citation and the trust when they are ready to move. It is
// also the only version an AI engine will quote. Self-serving advertorials lose
// on both counts.
//
// CLAIM DISCIPLINE: no prices, no version numbers, no "X is broken". Prices and
// feature matrices rot within a quarter and turn into a liability. Switch
// reasons are phrased as what users COMMONLY REPORT wanting, not as assertions
// of fact about a competitor's product. Re-verified on the freshness cadence.
//
// PURE DATA: imports only the PublicRoute TYPE. JSON-LD is composed in
// src/pages/marketing/marketing-jsonld.ts.

import type { PublicRoute } from "./public-routes";
import { verifiedLabel } from "./freshness";

/** Freshness stamp — derived from the real re-check date (US-1694). */
export const COMPETITOR_ALTERNATIVES_VERIFIED = verifiedLabel("competitor-alternatives");

export interface AlternativeOption {
  name: string;
  /** The one-line "pick this if" — the reader should be able to self-select. */
  bestFor: string;
  /** True only for our own tool, rendered with the differentiator note. */
  isOurs?: boolean;
}

export interface CompetitorAlternative {
  /** URL slug, e.g. "vendoo" → /reselling/vendoo-alternative */
  slug: string;
  /** Display name of the incumbent tool. */
  competitor: string;
  title: string;
  h1: string;
  /** Route meta description. Budget: 70-160 chars (US-435 test). */
  description: string;
  /** The direct answer, first thing on the page and the quotable unit. */
  definition: string;
  intro: string;
  /** What the incumbent genuinely does well — the reasons to STAY. */
  strengths: string[];
  /** What users commonly report wanting when they go looking for an alternative. */
  switchReasons: string[];
  options: AlternativeOption[];
  faqs: Array<{ q: string; a: string }>;
}

/** Shared closing option — our own tool, positioned on the one real difference. */
const FLIPDESK_OPTION: AlternativeOption = {
  name: "FlipDesk (GradeThread)",
  bestFor:
    "sellers whose margin is being eaten by 'not as described' returns — it builds a standardized condition grade and a buyer-verifiable certificate into the listing flow, which the pure crosslisters do not address at all",
  isOurs: true,
};

export const COMPETITOR_ALTERNATIVES: CompetitorAlternative[] = [
  {
    slug: "vendoo",
    competitor: "Vendoo",
    title: "Vendoo Alternatives for Resellers (2026)",
    description:
      "Vendoo alternatives compared for 2026 — List Perfectly, Crosslist, Flyp and FlipDesk — on marketplace coverage, pricing model, sync reliability and returns.",
    h1: "Vendoo alternatives: what to switch to, and when to stay",
    definition:
      "Vendoo remains a strong pick for per-item inventory control across many marketplaces. Resellers most often look elsewhere over extension-dependent syncing, cost at higher listing volumes, or wanting a tool that also addresses condition-driven returns. List Perfectly is the closest like-for-like on breadth, Crosslist competes on bulk speed, Flyp suits hands-off selling, and FlipDesk is the option if returns rather than listing speed are your bottleneck.",
    intro:
      "If you are searching for a Vendoo alternative you already know what crosslisting is worth — the question is whether a different tool fixes the specific thing that is costing you. This page is organised around that: what Vendoo does well enough that switching may not help, the reasons resellers commonly move, and which tool matches which reason.",
    strengths: [
      "Broad marketplace support with well-established inventory and delisting workflows",
      "Per-item control that suits sellers who manage listings individually rather than in bulk",
      "Both pay-as-you-go and subscription options, so low-volume sellers are not forced onto a flat fee",
      "Mature, well-documented product with a large existing user base",
    ],
    switchReasons: [
      "Extension-dependent syncing — browser-based tools generally sync only while the browser and extension are running, which frustrates sellers who want inventory reconciled unattended",
      "Cost scaling at higher listing volumes, where per-item or tiered pricing stops being the cheap option",
      "Wanting lifecycle depth beyond crosslisting — sourcing, comps, reconciliation — rather than a posting tool plus separate spreadsheets",
      "Condition-driven returns, which no pure crosslisting tool addresses because they speed up listing but leave condition description entirely to you",
    ],
    options: [
      {
        name: "List Perfectly",
        bestFor:
          "the closest like-for-like swap — comparable marketplace breadth and a large community, if breadth is why you were with Vendoo in the first place",
      },
      {
        name: "Crosslist",
        bestFor: "sellers whose bottleneck is raw bulk-listing speed rather than per-item management",
      },
      {
        name: "Flyp",
        bestFor: "sellers who would rather hand listing off entirely than operate a tool themselves",
      },
      FLIPDESK_OPTION,
    ],
    faqs: [
      {
        q: "What is the best Vendoo alternative?",
        a: "There is no single best one — it depends on why you are leaving. If you want comparable marketplace breadth, List Perfectly is the closest like-for-like. If bulk listing speed is the bottleneck, look at Crosslist. If you would rather not run a tool at all, Flyp offers managed selling. If your actual problem is 'not as described' returns rather than listing speed, FlipDesk is the only one of these that builds condition grading into the flow.",
      },
      {
        q: "Should I switch away from Vendoo at all?",
        a: "Often not. If your listings go out fine and your returns are low, switching costs you migration time and relearning for little gain. Switching is worth it when you can name the specific thing failing — unattended syncing, cost at your volume, missing lifecycle steps, or condition disputes. If you cannot name it, a new tool will not fix it.",
      },
      {
        q: "Do any crosslisting tools reduce returns?",
        a: "Most do not, and it is worth being clear about why: they speed up posting but leave condition description to you, and condition mismatch is the leading cause of 'not as described' claims. Reducing those requires a standardized, verifiable condition grade attached to the listing — which is what separates FlipDesk from the crosslisting suites rather than a difference of degree.",
      },
    ],
  },
  {
    slug: "list-perfectly",
    competitor: "List Perfectly",
    title: "List Perfectly Alternatives (2026)",
    description:
      "List Perfectly alternatives compared for 2026 — Vendoo, Crosslist, Flyp and FlipDesk — on marketplace coverage, pricing tiers, automation depth and returns.",
    h1: "List Perfectly alternatives: what to switch to, and when to stay",
    definition:
      "List Perfectly leads on marketplace breadth and community, and for sellers who list everywhere that is hard to beat. Resellers commonly look elsewhere over tier pricing at higher volumes, extension reliance, or wanting deeper analytics and lifecycle coverage. Vendoo is the closest like-for-like, Crosslist competes on bulk speed, Flyp suits hands-off selling, and FlipDesk is the pick when condition-driven returns are the real cost.",
    intro:
      "Searching for a List Perfectly alternative usually means one specific thing has started costing you — price at your volume, an automation gap, or returns. This page is organised around which tool fixes which of those, including the case for staying put.",
    strengths: [
      "Among the widest marketplace coverage available in a single tool",
      "Large, active community and a deep bank of learning resources",
      "Bulk crosslisting, cataloguing and analytics available on higher tiers",
      "Long track record, with workflows many resellers already know",
    ],
    switchReasons: [
      "Tier pricing that climbs as listing volume grows, which can outpace the time it saves",
      "Extension reliance for several marketplaces, so syncing depends on a browser session being open",
      "Wanting deeper analytics than the tool surfaces, particularly sell-through and cost-basis reporting",
      "Regional availability — sellers outside its supported regions often have to look elsewhere regardless of fit",
      "Condition-driven returns, which crosslisting tools as a category do not address",
    ],
    options: [
      {
        name: "Vendoo",
        bestFor:
          "the closest like-for-like swap — comparable breadth with per-item inventory control, and pay-as-you-go pricing that can work out cheaper at low volume",
      },
      {
        name: "Crosslist",
        bestFor: "sellers who want fast bulk posting and can live with tiered listing limits",
      },
      {
        name: "Flyp",
        bestFor: "sellers who would rather delegate listing entirely than run software",
      },
      FLIPDESK_OPTION,
    ],
    faqs: [
      {
        q: "What is the best List Perfectly alternative?",
        a: "It depends on your reason for leaving. Vendoo is the closest like-for-like on breadth with a different pricing model. Crosslist suits bulk-speed-first sellers. Flyp is for those who would rather hand listing off. If your margin is going to condition disputes rather than listing time, FlipDesk is the only option here that builds a verifiable condition grade into the listing.",
      },
      {
        q: "Is List Perfectly or Vendoo better?",
        a: "Neither wins outright. List Perfectly generally leads on marketplace breadth and community; Vendoo offers per-item control and a pay-as-you-go option that can be cheaper at low volume. The honest answer is that they are close enough that switching between them is rarely worth the migration unless a specific limitation is biting you.",
      },
      {
        q: "Will switching crosslisting tools reduce my returns?",
        a: "Not on its own. Crosslisting tools change how fast listings go out, not how accurately condition is described — and condition mismatch is the leading driver of 'not as described' claims. If returns are your problem, the thing to change is how condition is assessed and evidenced, not how quickly the listing posts.",
      },
    ],
  },
  {
    slug: "crosslist",
    competitor: "Crosslist",
    title: "Crosslist Alternatives for Resellers (2026)",
    description:
      "Crosslist alternatives compared for 2026 — Vendoo, List Perfectly, Flyp and FlipDesk — on listing limits, marketplace breadth, lifecycle depth and returns.",
    h1: "Crosslist alternatives: what to switch to, and when to stay",
    definition:
      "Crosslist is built around fast bulk listing, and for sellers whose bottleneck is posting volume it does that job well. Resellers commonly look elsewhere when tiered listing limits start binding, when they want lifecycle coverage beyond posting, or when returns rather than listing speed turn out to be the real cost. Vendoo and List Perfectly lead on breadth and inventory depth; FlipDesk is the option when condition disputes are what is eating margin.",
    intro:
      "Looking for a Crosslist alternative usually means you have outgrown one specific limit — listing caps, marketplace coverage, or the fact that faster listing has not reduced your returns. Here is which tool addresses which, and when staying is the right call.",
    strengths: [
      "Fast bulk listing, which is the core job and the reason most sellers choose it",
      "Background posting, so listing is not blocked on watching the tool work",
      "Straightforward pricing that is easy to reason about compared with multi-tier suites",
      "Broad marketplace coverage for a tool focused on posting rather than full inventory management",
    ],
    switchReasons: [
      "Tiered listing limits becoming the binding constraint as volume grows",
      "Wanting deeper inventory management — per-item history, cost basis, reconciliation — rather than posting alone",
      "Needing lifecycle steps Crosslist does not cover, such as sourcing decisions and sold-comp research",
      "Returns from condition disputes, which faster listing cannot fix and no crosslisting tool addresses",
    ],
    options: [
      {
        name: "Vendoo",
        bestFor: "sellers who want per-item inventory control and delisting workflows alongside crosslisting",
      },
      {
        name: "List Perfectly",
        bestFor: "sellers who want the widest marketplace coverage and an established community",
      },
      {
        name: "Flyp",
        bestFor: "sellers who would rather hand listing to someone else entirely",
      },
      FLIPDESK_OPTION,
    ],
    faqs: [
      {
        q: "What is the best Crosslist alternative?",
        a: "If you need deeper inventory management, Vendoo. If you need wider marketplace coverage, List Perfectly. If you want listing handled for you, Flyp. If faster listing has not moved your numbers because returns are the actual problem, FlipDesk is the one that adds a standardized, buyer-verifiable condition grade rather than more posting speed.",
      },
      {
        q: "Should I move off Crosslist if I am only hitting listing limits?",
        a: "Check the cost of the next tier first. Moving tools carries migration and relearning cost, and if listing limits are the only issue, a higher tier is usually cheaper overall than a switch. Move when the limitation is structural — missing lifecycle steps or unaddressed returns — rather than a number you can raise.",
      },
      {
        q: "Does listing faster increase my sales?",
        a: "Up to a point — unlisted inventory cannot sell, so clearing a backlog usually does lift revenue. But past that, listing speed stops being the constraint and sell-through and returns become the limit. If more listings have stopped producing more profit, the bottleneck has moved and a faster crosslister will not address it.",
      },
    ],
  },
];

/** Path for a competitor alternative page. */
export function alternativePath(slug: string): string {
  return `/reselling/${slug}-alternative`;
}

export function getAlternativeBySlug(slug: string): CompetitorAlternative | undefined {
  return COMPETITOR_ALTERNATIVES.find((a) => a.slug === slug);
}

export function getAlternativeByPath(path: string): CompetitorAlternative | undefined {
  const clean = path.replace(/\/+$/, "");
  return COMPETITOR_ALTERNATIVES.find((a) => alternativePath(a.slug) === clean);
}

export function competitorAlternativeRoutes(): PublicRoute[] {
  return COMPETITOR_ALTERNATIVES.map((a) => ({
    path: alternativePath(a.slug),
    title: a.title,
    description: a.description,
    changefreq: "monthly",
    priority: 0.6,
    jsonLdType: "Article",
  }));
}
