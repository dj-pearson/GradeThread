// US-825: aspect provenance + the single source of truth for "which REQUIRED
// eBay specifics are still unfilled". Both the publish-time blocker
// (assemblePublishContext) and the client pre-publish checklist resolve missing
// required aspects through requiredMissingAspects() so they can never disagree.

/// Where an aspect value came from. `unfilled` is COMPUTED (an aspect in the
/// category spec with no value), never stored — the stored states are the other
/// three, in a parallel jsonb map keyed by aspect name.
export type AspectProvenance =
  | "ai_extracted"
  | "inventory_derived"
  // US-3043: filled from the specifics that visually similar live listings
  // agree on (lib/visual-aspect-prefill.ts). Lowest rung: it looked at
  // garments that resemble this one, not at this one.
  | "visual_consensus"
  | "manual"
  | "unfilled";

/// The stored (persistable) subset — `unfilled` is derived, not written.
export type StoredAspectProvenance = Exclude<AspectProvenance, "unfilled">;

export type AspectSourceMap = Record<string, StoredAspectProvenance>;

/// Minimal shape of an eBay Taxonomy aspect spec entry — only the fields the
/// required-aspect check reads. Mirrors AspectSpecRaw in flipdesk-ebay.ts.
export interface RequiredAspectSpec {
  localizedAspectName?: string;
  aspectConstraint?: { aspectRequired?: boolean };
}

/// US-2389: keep this and its web twin in lockstep.
/// Two copies of one rule (separate projects, no shared import): this one is the
/// publish BLOCKER that returns the 422, the web one is the seller-facing
/// pre-publish CHECKLIST. Both are asserted against
/// src/test/fixtures/required-aspects-cases.json, because they HAD already
/// drifted -- the web copy threw on an aspect spec with no aspectConstraint
/// while this one returned safely, and no test covered it.
///
/// The failure mode if they disagree is quiet: the checklist tells the seller
/// the listing is ready, the blocker refuses it, and the one surface that would
/// explain why is the surface saying nothing is missing.
/// The names of REQUIRED aspects (per the category spec) that have no value in
/// `aspectMap`. This is the canonical rule the publish blocker and the client
/// checklist both use — keep it the only implementation on the edge.
export function requiredMissingAspects(
  list: RequiredAspectSpec[],
  aspectMap: Record<string, string[]>,
): string[] {
  return list
    .filter((a) => a.aspectConstraint?.aspectRequired)
    .map((a) => a.localizedAspectName ?? "")
    .filter((n) => n.length > 0 && (aspectMap[n]?.length ?? 0) === 0);
}

/// US-1895: eBay Taxonomy aspect spec fields beyond the required flag — the
/// RECOMMENDED usage tier + the 30-day buyer-search-volume ranking. Both are
/// already in the cached get_item_aspects_for_category payload; this reads them.
export interface RankedAspectSpec extends RequiredAspectSpec {
  aspectConstraint?: {
    aspectRequired?: boolean;
    /// "REQUIRED" | "RECOMMENDED" | "OPTIONAL"
    aspectUsage?: string;
  };
  /// eBay's real 30-day search-volume signal for this aspect.
  relevanceIndicator?: { searchCount?: number };
}

export interface AspectCoverage {
  /// Recommended aspects that have at least one non-empty value.
  filled: number;
  /// Total recommended aspects for the category.
  total: number;
  /// Unfilled recommended aspect names, ranked by search volume (desc) — eBay's
  /// own ordering of what buyers filter on most.
  missing: string[];
}

/// US-1895: how many of eBay's RECOMMENDED aspects the listing fills. The single
/// source for the composer meter + the drafts coverage column, kept beside the
/// required-blocker rule so they can never disagree. An aspect counts as filled
/// when it has ≥1 non-empty value. Pure + deterministic.
export function recommendedAspectCoverage(
  list: RankedAspectSpec[],
  aspectMap: Record<string, string[]>,
): AspectCoverage {
  const recommended = list.filter(
    (a) =>
      (a.aspectConstraint?.aspectUsage ?? "").toUpperCase() === "RECOMMENDED" &&
      (a.localizedAspectName ?? "").length > 0,
  );
  let filled = 0;
  const missing: Array<{ name: string; rank: number }> = [];
  for (const a of recommended) {
    const name = a.localizedAspectName!;
    const hasValue = (aspectMap[name] ?? []).some((v) => v.trim() !== "");
    if (hasValue) {
      filled++;
    } else {
      missing.push({ name, rank: a.relevanceIndicator?.searchCount ?? 0 });
    }
  }
  // Highest search volume first; stable by name on ties for a deterministic order.
  missing.sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
  return { filled, total: recommended.length, missing: missing.map((m) => m.name) };
}

/// Build a source map marking every name in `names` as `source`. Used by the AI
/// generation path (ai_extracted) and the deterministic derivation path
/// (inventory_derived) to record provenance for the keys they filled.
export function sourcesFor(
  names: Iterable<string>,
  source: StoredAspectProvenance,
): AspectSourceMap {
  const out: AspectSourceMap = {};
  for (const name of names) {
    if (name) out[name] = source;
  }
  return out;
}

/// Merge newly-attributed sources onto an existing map WITHOUT clobbering an
/// already-recorded, more authoritative source. Precedence (high → low):
/// manual > ai_extracted > inventory_derived. So a deterministic refill never
/// downgrades an AI- or user-attributed aspect, and the map only gains
/// resolution as aspects are touched. Keys no longer present in `valueMap`
/// (cleared values) are dropped so the map can't go stale.
const PRECEDENCE: Record<StoredAspectProvenance, number> = {
  visual_consensus: 0,
  inventory_derived: 1,
  ai_extracted: 2,
  manual: 3,
};

export function mergeSources(
  existing: AspectSourceMap,
  updates: AspectSourceMap,
  valueMap?: Record<string, string[]>,
): AspectSourceMap {
  const out: AspectSourceMap = { ...existing };
  for (const [name, src] of Object.entries(updates)) {
    const prev = out[name];
    if (!prev || PRECEDENCE[src] >= PRECEDENCE[prev]) out[name] = src;
  }
  if (valueMap) {
    for (const name of Object.keys(out)) {
      if ((valueMap[name]?.length ?? 0) === 0) delete out[name];
    }
  }
  return out;
}
