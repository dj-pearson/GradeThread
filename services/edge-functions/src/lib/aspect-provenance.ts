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
  inventory_derived: 0,
  ai_extracted: 1,
  manual: 2,
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
