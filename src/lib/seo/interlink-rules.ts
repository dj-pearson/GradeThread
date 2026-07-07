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

/** The topical hubs. Cross-hub authority is constrained (see isCrossHubLinkAllowed). */
export type Hub = "grading" | "reselling" | "flipdesk";

/** The canonical scale page — the PageRank sink every certificate/glossary page ladders up to. */
export const CANONICAL_SCALE_PATH = "/grading/scale";

/** The designated reselling↔grading crossover (US-1673). */
export const SPINE_PATH = "/reselling/reduce-ebay-returns";

/** Certificate pages link UP to the scale page (US-1674 anchor-discipline rule). */
export const CERTIFICATE_UPLINK_PATH = CANONICAL_SCALE_PATH;

/** A cluster page must link its pillar within this many words of the start. */
export const UPLINK_MAX_WORD_OFFSET = 100;

/** Each hub's pillar page — the only non-spine targets a cross-hub link may point at. */
export const HUB_PILLARS: Record<Hub, string> = {
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
  if (fromHub === null || toHub === null) return true;
  if (fromHub === toHub) return true;
  const to = toPath.replace(/\/+$/, "") || "/";
  if (to === SPINE_PATH) return true;
  return (Object.values(HUB_PILLARS) as string[]).includes(to);
}
