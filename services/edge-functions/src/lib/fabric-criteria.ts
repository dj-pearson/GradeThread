// US-1534: fabric-aware grading criteria from the care label.
//
// The label photo's per-image pass now transcribes structured fiber_content;
// this module maps the fibers to material-specific wear norms + failure modes
// (cashmere pilling is expected-with-wear and partly remediable; tech-fleece
// pilling signals heavy wear; denim fade vs whiskering; elastane bagging) and
// renders the criteria block the COMPOSITE prompt injects.
//
// PIPELINE-ORDERING DECISION (AC3, documented here): per-image calls run in
// parallel (Promise.allSettled) — sequencing the label first would serialize
// the pipeline's hot path and cost seconds on every grade. The fabric criteria
// are therefore applied at the COMPOSITE stage, where the label's fiber read
// already exists in the per-image results and the final factor weighting
// happens anyway. Strictly additive: no fiber read → no block → composite
// prompt byte-identical to today.

/** One transcribed fiber line off the care label. pct null when unreadable. */
export interface FiberContentEntry {
  fiber: string;
  pct: number | null;
}

export type FiberClass =
  | "wool_cashmere"
  | "cotton_denim"
  | "synthetic"
  | "silk"
  | "leather_suede"
  | "linen";

// Material-specific wear norms + failure modes, written to the same tone as
// GARMENT_CATEGORY_CRITERIA (ai-grading.ts): what honest wear looks like on
// this material, what signals genuine damage, and what to weight differently.
export const FABRIC_CRITERIA: Record<FiberClass, string> = {
  wool_cashmere:
    "Wool/cashmere: light pilling at friction points (underarms, sides, cuffs) is EXPECTED with normal wear and is partly remediable with a comb — weight it as minor honest wear, not heavy damage. Genuine concerns: moth holes (small clean-edged holes, often clustered), felting/shrinkage (dense matted texture), stretched-out ribbing, and odor retention. Distinguish the fiber's natural halo/fuzz from pilling.",
  cotton_denim:
    "Cotton/denim: distinguish intentional factory fading, whiskering, and honeycombs (sharp, patterned, symmetric) from genuine wear fade (diffuse, at seat/knees/hems). Fraying at hems can be a factory finish — check edge regularity. Genuine concerns: crotch/thigh blowouts and thinning, ripped belt loops, set-in stains, collar/cuff abrasion on shirts, shrinkage distortion.",
  synthetic:
    "Synthetics (polyester/nylon/acrylic/fleece): pilling on technical knits or fleece signals HEAVY wear (unlike wool it does not comb out) — weight it more severely than the same pilling on natural fibers. Genuine concerns: snags and pulled loops, permanent odor retention (synthetics hold body odor), heat damage (glazing/melting marks from ironing), delaminated coatings or peeling prints, and elastic degradation.",
  silk:
    "Silk: judge sheen uniformity — dull patches signal abrasion or washing damage; water spots and perspiration discoloration at underarms are common and hard to reverse. Snags and pulled threads show readily. Seam slippage (fabric pulling apart at stressed seams leaving parallel thread gaps) is a structural failure specific to silk — check seams closely.",
  leather_suede:
    "Leather/suede: even patina and slight sheen from handling are EXPECTED aging — weight as honest character, not damage. Genuine concerns: deep scratches through the finish, cracking or dryness (especially at flex points), water staining on suede, bald/shiny patches on nap, edge-coat peeling, and stretched or torn hardware attachment points.",
  linen:
    "Linen: wrinkling is inherent to the fiber and NEVER a defect. Slubs (small thick threads) are natural texture, not flaws. Genuine concerns: permanent creases that have abraded into thin lines, yellowing from storage, and fraying at collar/cuff edges where the fiber's low elasticity wears through.",
};

// Elastane is a modifier, not a class: even a few percent changes the failure
// mode (recovery loss) regardless of the dominant fiber.
export const ELASTANE_CRITERIA =
  "Elastane/spandex present: check RECOVERY — bagging at knees/seat/elbows, a stretched-out waistband, or wavy/rippled hems signal degraded elastane, which is permanent (it does not recover with washing). Weight recovery loss under structural integrity even when the fabric surface looks clean.";

const FIBER_CLASS_PATTERNS: Array<[FiberClass, RegExp]> = [
  ["wool_cashmere", /\b(cashmere|merino|wool|lambswool|alpaca|mohair|angora)\b/],
  ["cotton_denim", /\b(cotton|denim)\b/],
  ["silk", /\bsilk\b/],
  ["leather_suede", /\b(leather|suede|nubuck)\b/],
  ["linen", /\b(linen|flax)\b/],
  [
    "synthetic",
    /\b(polyester|nylon|polyamide|acrylic|fleece|rayon|viscose|modal|lyocell|tencel|polypropylene)\b/,
  ],
];

const ELASTANE_PATTERN = /\b(elastane|spandex|lycra)\b/;

/** Normalize a raw fiber string for matching. */
function normFiber(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * The dominant fiber class: highest total percentage across entries that match
 * a class (unknown fibers ignored); ties/missing percentages fall back to
 * first-listed order (care labels list dominant fiber first). Null when
 * nothing matches — no criteria injected.
 */
export function dominantFiberClass(
  entries: readonly FiberContentEntry[],
): FiberClass | null {
  const totals = new Map<FiberClass, number>();
  const firstSeen = new Map<FiberClass, number>();
  entries.forEach((e, i) => {
    const f = normFiber(e.fiber);
    if (f === "" || ELASTANE_PATTERN.test(f)) return;
    for (const [cls, re] of FIBER_CLASS_PATTERNS) {
      if (re.test(f)) {
        // Percent-less entries still count a little so a label read without
        // percentages ("cotton, elastane") resolves by listing order.
        totals.set(cls, (totals.get(cls) ?? 0) + (e.pct ?? 1));
        if (!firstSeen.has(cls)) firstSeen.set(cls, i);
        break;
      }
    }
  });
  let best: FiberClass | null = null;
  for (const [cls, total] of totals) {
    if (
      best === null ||
      total > totals.get(best)! ||
      (total === totals.get(best)! && firstSeen.get(cls)! < firstSeen.get(best)!)
    ) {
      best = cls;
    }
  }
  return best;
}

/** True when the label shows any elastane/spandex/lycra content. */
export function hasElastane(entries: readonly FiberContentEntry[]): boolean {
  return entries.some((e) => ELASTANE_PATTERN.test(normFiber(e.fiber)));
}

/** Human-readable composition line, e.g. "95% cashmere, 5% elastane". */
function compositionLine(entries: readonly FiberContentEntry[]): string {
  return entries
    .slice(0, 8)
    .map((e) => (e.pct !== null ? `${e.pct}% ${normFiber(e.fiber)}` : normFiber(e.fiber)))
    .join(", ");
}

/**
 * The composite-stage criteria block for the given per-image fiber reads.
 * "" when no label produced a usable read — the composite prompt stays
 * byte-identical (the additive guarantee, test-guarded).
 */
export function fabricCriteriaBlock(
  perImageResults: ReadonlyArray<{
    image_type: string;
    fiber_content?: readonly FiberContentEntry[];
  }>,
): string {
  // First non-empty read from a label image wins (label, then label_2).
  const labels = perImageResults
    .filter((r) => r.image_type === "label" || r.image_type === "label_2")
    .sort((a, b) => a.image_type.localeCompare(b.image_type));
  const entries = labels.find(
    (r) => (r.fiber_content ?? []).length > 0,
  )?.fiber_content;
  if (!entries || entries.length === 0) return "";

  const cls = dominantFiberClass(entries);
  const parts: string[] = [];
  if (cls) parts.push(FABRIC_CRITERIA[cls]);
  if (hasElastane(entries)) parts.push(ELASTANE_CRITERIA);
  if (parts.length === 0) return "";

  return `FABRIC-SPECIFIC CRITERIA (from the care label: ${compositionLine(entries)}):
${parts.join("\n")}`;
}

/**
 * Harden the model's raw fiber_content: non-empty fiber strings, pct clamped
 * to 0–100 or null, at most 8 entries. [] for anything malformed — the parse
 * omits rather than guesses (AC1).
 */
export function normalizeFiberContent(raw: unknown): FiberContentEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: FiberContentEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const fiber = (item as { fiber?: unknown }).fiber;
    if (typeof fiber !== "string" || fiber.trim() === "") continue;
    const pctRaw = Number((item as { pct?: unknown }).pct);
    const pct = Number.isFinite(pctRaw)
      ? Math.max(0, Math.min(100, Math.round(pctRaw)))
      : null;
    out.push({ fiber: fiber.trim().slice(0, 40), pct });
    if (out.length >= 8) break;
  }
  return out;
}
