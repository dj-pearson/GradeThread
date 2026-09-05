// US-1674: explicit topical rules for the automated interlinker.
//
// The interlinker (functions/_shared/blog-render.ts: pillar uplink + related
// posts + linkGlossaryTerms sideways links) and the hand-authored pillar/cluster
// pages all draw their internal-link policy from THIS file, so PageRank
// concentrates on the canonical scale page and cross-hub authority only flows
// through the designated spine (US-1673) and the hub pillars.
//
// The rules (from the epic):
//   • Down-links  — a pillar links all its cluster children in a curated chapter
//                   block (enforced by the pillar page components).
//   • Up-links    — a cluster page links its pillar in the first 100 words with
//                   an approved anchor (UPLINK_MAX_WORD_OFFSET + APPROVED_ANCHORS).
//   • Cross-hub   — forbidden except through the spine page or a hub pillar
//                   (isCrossHubLinkAllowed).
//   • Anchors     — rotate 3–4 approved anchors per target URL, never generic
//                   ("click here"); certificate pages link up to /grading/scale
//                   (approvedAnchorsFor / pickAnchor / isGenericAnchor).
//   • Sideways    — glossary spokes link 2–3 related terms + the scale page
//                   (enforced by reseller-glossary relatedSlugs + this scale rule).
//
// PURE DATA + pure functions. No Date/Math.random (deterministic rotation).

/**
 * The topical hubs. Cross-hub authority is constrained (see
 * isCrossHubLinkAllowed).
 *
 * US-9015 added "care". It is not a peer of the other three: it is the only hub
 * authority may leave but not enter. See CARE_HUB_PATH below.
 */
export type Hub = "grading" | "reselling" | "flipdesk" | "care" | "buying";

/**
 * The care cluster (US-9012), served under /care.
 *
 * THE RULE IS ONE-WAY AND THAT IS THE WHOLE POINT. A care page may link into
 * the reseller spine; nothing in the reseller spine may link back. Two reasons,
 * and the second is the one that costs money if it is ignored:
 *
 *   1. Link equity. Care terms are 295,750/mo against a seller surface of about
 *      157,000, so if links ran both ways the care cluster would become the
 *      centre of the internal graph by sheer page count.
 *   2. The entity signal. The US-9011 SERP check found all 39 results for these
 *      terms are craft blogs, brand blogs, UGC and charity shops, and not one is
 *      a resale or grading site. Google reads what a site links to. Pointing the
 *      commercial pages at laundry advice tells it we are a laundry site, and a
 *      domain that reads as laundry advice is a weaker match for
 *      `clothing inventory management software`.
 *
 * Path 1 is an AUTHORITY AND LINK ENGINE, not an acquisition channel. Only
 * 1,550 of its 295,750 monthly searches carry seller intent, which is 0.5%.
 * Planning it as a customer channel is the failure mode this guard prevents.
 */
export const CARE_HUB_PATH = "/care";

/**
 * The buyer-trust cluster (US-3093), served under /buying.
 *
 * SAME ONE-WAY RULE AS CARE, for a different reason. Care is contained because
 * it is enormous and off-topic; this is contained because it is written for the
 * WRONG PERSON. `is vinted legit` and its siblings are 155,000/mo of BUYERS on a
 * site whose customer is a seller, and a buyer who lands on /pricing has been
 * shown a $29/month reseller tool in answer to "am I about to be scammed".
 *
 * So nothing links into /buying, and /buying links out to exactly one product
 * surface: the extension install, which is the thing that actually answers the
 * question they asked. buying-containment.test.ts asserts both halves, including
 * the list of seller pages these pages may not reach.
 *
 * ⚠ AND THE OUT-DIRECTION IS TIGHTER THAN CARE'S. A care page may link anywhere
 * it likes; a /buying page may not, because a seller landing reached from a
 * buyer page is not just wasted equity, it is the wrong answer to the query.
 */
export const BUYING_HUB_PATH = "/buying";

/**
 * Product surfaces a /buying page must never link to.
 *
 * Not a hub check — /pricing and /flipdesk are a non-hub path and another hub
 * respectively, and isCrossHubLinkAllowed lets a non-hub target through. This
 * is the list that makes AC6 checkable.
 */
export const BUYING_FORBIDDEN_TARGETS: readonly string[] = [
  "/pricing",
  "/flipdesk",
  "/for-resellers",
  "/reselling",
  "/sell-used-clothes-ebay",
  "/for-brands",
];

/** True when a /buying page may link at `toPath`. */
export function isBuyingLinkAllowed(toPath: string): boolean {
  const to = toPath.replace(/\/+$/, "") || "/";
  return !BUYING_FORBIDDEN_TARGETS.some(
    (bad) => to === bad || to.startsWith(`${bad}/`),
  );
}

/** The canonical scale page — the PageRank sink every certificate/glossary page ladders up to. */
export const CANONICAL_SCALE_PATH = "/grading/scale";

/** The designated reselling↔grading crossover (US-1673). */
export const SPINE_PATH = "/reselling/reduce-ebay-returns";

/** Certificate pages link UP to the scale page (US-1674 anchor-discipline rule). */
export const CERTIFICATE_UPLINK_PATH = CANONICAL_SCALE_PATH;

/** A cluster page must link its pillar within this many words of the start. */
export const UPLINK_MAX_WORD_OFFSET = 100;

/**
 * Each hub's pillar page - the only non-spine targets a cross-hub link may
 * point at.
 *
 * US-9015: care is EXCLUDED from this map by its type, not by omission. Every
 * other hub has a pillar that cross-hub links are allowed to reach; care has
 * none, because no cross-hub link may reach care at all. Typing it as
 * Exclude<Hub, "care"> makes adding one a compile error rather than a quiet
 * hole in the containment.
 *
 * US-3093 excludes buying the same way and for the same reason.
 */
export const HUB_PILLARS: Record<Exclude<Hub, "care" | "buying">, string> = {
  grading: CANONICAL_SCALE_PATH,
  reselling: "/reselling",
  flipdesk: "/flipdesk",
};

/**
 * Classify a path into its hub. The grading moat = grading vocabulary, the scale,
 * certificates/verification, and condition explainers. The reselling universe =
 * /reselling/* and the /compare comparisons. FlipDesk = the product surface.
 * Returns null for paths that belong to no hub (home, legal, etc.).
 */
export function hubForPath(path: string): Hub | null {
  const p = path.replace(/\/+$/, "") || "/";
  // US-9015: care is checked FIRST. It has to be, because a care page is
  // allowed to talk about grading and would otherwise fall through into the
  // grading hub on a keyword, which is exactly the classification that lets the
  // two become one graph.
  if (p === CARE_HUB_PATH || p.startsWith(`${CARE_HUB_PATH}/`)) return "care";
  // US-3093: and buying, for the same reason. A /buying page talks about
  // marketplaces and condition; without this it would fall through into the
  // reselling hub on a keyword and stop being contained at all.
  if (p === BUYING_HUB_PATH || p.startsWith(`${BUYING_HUB_PATH}/`)) return "buying";
  // The spine lives under /reselling but is the crossover — classify by its own hub.
  if (p === "/flipdesk" || p.startsWith("/flipdesk/")) return "flipdesk";
  if (
    p === "/grading" ||
    p.startsWith("/grading/") ||
    p === "/grading-standard" ||
    p === "/grading-by-category" ||
    p === "/condition-grading" ||
    p === "/verify" ||
    p === "/scan" ||
    p === "/resale-condition-report" ||
    p === "/design-vs-damage"
  ) {
    return "grading";
  }
  if (
    p === "/reselling" ||
    p.startsWith("/reselling/") ||
    p === "/compare" ||
    p.startsWith("/compare/") ||
    p === "/reduce-returns" ||
    p === "/resale-value-by-condition" ||
    p === "/reseller-grading-guide"
  ) {
    return "reselling";
  }
  return null;
}

/**
 * Approved anchor texts per canonical target URL. 3–4 each, rotated by pickAnchor
 * so no single anchor over-optimizes a target. Every entry is a real, indexable
 * route. NEVER add a generic anchor here (isGenericAnchor guards the set in tests).
 */
export const APPROVED_ANCHORS: Record<string, readonly string[]> = {
  "/grading/scale": [
    "the 1.0–10.0 grading scale",
    "the condition grading scale",
    "our condition grade scale",
    "the grading scale",
  ],
  "/reselling/reduce-ebay-returns": [
    "reduce eBay returns",
    "cut condition returns",
    "the returns-reduction playbook",
    "cut not-as-described returns",
  ],
  "/reselling": [
    "the reselling workflow",
    "how to resell clothes",
    "the full reselling guide",
  ],
  "/flipdesk": [
    "FlipDesk",
    "the FlipDesk reseller suite",
    "FlipDesk's listing tools",
  ],
  "/condition-grading": [
    "condition grading",
    "what condition grading is",
    "standardized condition grading",
  ],
  "/verify": [
    "verify a condition certificate",
    "check a grade certificate",
    "verify a grade",
  ],
  // US-2113: the comparison cluster shipped 16 pages (comparison-guides.ts) and
  // none of them could be linked to, because the interlinker only emits a body
  // link when its target has anchors here. The hub plus two pairs get entries;
  // the other 14 are reachable from the hub, which is what a hub is for. Adding
  // all 16 would spread anchor rotation thin for no gain.
  //
  // US-9008, 2026-08-18: WHICH two changed. The budget went to
  // poshmark-vs-mercari and mercari-vs-ebay as "the two highest-volume pairs",
  // picked from Keyword Planner volume before the site had any data of its own.
  // Ten weeks of Search Console says those are the two pages that cannot rank:
  // position 44.8 on 10 impressions and 39 on 2. Every pair naming eBay,
  // Poshmark, Mercari or Depop sits at 20-45; every pair naming Grailed or
  // Vinted sits in the top 11. Same template, same publish date, and the two
  // losers are the only two that had internal links — so the variable is which
  // platforms are named, not the pages. Internal authority is worth spending
  // where it can cross a threshold, which is a page at 8.5 or 11.0, not one at
  // 44.8.
  "/compare": [
    "compare the resale marketplaces",
    "which marketplace to list on",
    "the marketplace comparison guides",
  ],
  "/compare/vinted-vs-mercari": [
    "Vinted vs Mercari",
    "how Vinted and Mercari compare",
    "the Vinted and Mercari fee comparison",
  ],
  "/compare/grailed-vs-poshmark": [
    "Grailed vs Poshmark",
    "how Grailed and Poshmark compare",
    "the Grailed and Poshmark fee comparison",
  ],
};

/**
 * Generic / low-value anchor phrases the interlinker must never emit. Matched on
 * the normalized (lowercased, punctuation-stripped, collapsed) anchor text —
 * either an exact match or a contained phrase like "click here".
 */
const FORBIDDEN_ANCHOR_EXACT = new Set([
  "here",
  "link",
  "this",
  "this page",
  "this link",
  "more",
  "click",
  "go",
]);
const FORBIDDEN_ANCHOR_PHRASES = [
  "click here",
  "read more",
  "learn more",
  "find out more",
  "see more",
  "this page",
  "click this",
];

function normalizeAnchor(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True if the anchor text is a generic / non-descriptive phrase (forbidden). */
export function isGenericAnchor(text: string): boolean {
  const n = normalizeAnchor(text);
  if (!n) return true;
  if (FORBIDDEN_ANCHOR_EXACT.has(n)) return true;
  return FORBIDDEN_ANCHOR_PHRASES.some((p) => n === p || n.includes(p));
}

/** The approved anchors for a target URL (empty if the target isn't governed). */
export function approvedAnchorsFor(url: string): readonly string[] {
  const norm = url.replace(/\/+$/, "") || "/";
  return APPROVED_ANCHORS[norm] ?? [];
}

/**
 * Deterministically pick one of a target's approved anchors, rotating by `seed`
 * (e.g. a post index or a stable hash) so repeated links to the same URL vary.
 * Returns null if the target has no approved anchors. No randomness — same
 * (url, seed) always yields the same anchor (safe for prerender parity).
 */
export function pickAnchor(url: string, seed: number): string | null {
  const anchors = approvedAnchorsFor(url);
  if (anchors.length === 0) return null;
  const i = ((Math.trunc(seed) % anchors.length) + anchors.length) % anchors.length;
  return anchors[i] ?? null;
}

/**
 * Cross-hub link policy. A link within a hub is always allowed. A link BETWEEN
 * hubs is allowed only when it points at the spine page or a hub pillar — this is
 * how cross-hub authority is funneled through the designated crossovers instead
 * of leaking across the whole graph. A link from/to a non-hub path (home, legal)
 * is unconstrained (returns true).
 */
export function isCrossHubLinkAllowed(fromPath: string, toPath: string): boolean {
  const fromHub = hubForPath(fromPath);
  const toHub = hubForPath(toPath);
  if (fromHub === toHub) return true;
  // US-9015: nothing may link INTO care from anywhere else, including the
  // otherwise-unconstrained non-hub pages (home, legal). Checked before the
  // null-hub escape below, or the homepage would be free to link at it.
  if (toHub === "care") return false;
  // US-3093: nothing may link INTO buying either, and for a sharper reason than
  // care's. A seller page pointing at "is vinted legit" tells Google this domain
  // answers buyer-safety questions, which is a weaker match for the queries the
  // business is actually sold on.
  if (toHub === "buying") return false;
  // A care page linking OUT is deliberately unconstrained: the whole design is
  // that equity flows one way, down into the commercial pages.
  if (fromHub === "care") return true;
  // A buying page linking out is constrained instead — see isBuyingLinkAllowed,
  // which the containment test applies to every link these pages render. The
  // hub check alone would pass a link to /pricing, because /pricing is a non-hub
  // path and the rule below lets those through.
  if (fromHub === "buying") return isBuyingLinkAllowed(toPath);
  if (fromHub === null || toHub === null) return true;
  const to = toPath.replace(/\/+$/, "") || "/";
  if (to === SPINE_PATH) return true;
  return (Object.values(HUB_PILLARS) as string[]).includes(to);
}
