// US-825: aspect provenance (web). Mirrors the edge
// services/edge-functions/src/lib/aspect-provenance.ts so the composer's
// pre-publish required-aspect checklist uses the SAME rule as the server's
// publish blocker (assemblePublishContext) — they can't disagree.

import type { EbayAspect } from "@/hooks/use-ebay";

/// Where an aspect value came from. `unfilled` is COMPUTED (an aspect in the
/// category spec with no value), never stored — the other three live in a
/// parallel jsonb map keyed by aspect name.
export type AspectProvenance =
  | "ai_extracted"
  | "inventory_derived"
  | "manual"
  | "unfilled";

export type StoredAspectProvenance = Exclude<AspectProvenance, "unfilled">;

export type AspectSourceMap = Record<string, StoredAspectProvenance>;

/// Short badge label + tooltip per provenance, for the composer/iOS editor.
export const PROVENANCE_BADGE: Record<
  StoredAspectProvenance,
  { label: string; title: string }
> = {
  ai_extracted: { label: "AI", title: "Filled by AI from your photos/details" },
  inventory_derived: {
    label: "Auto",
    title: "Derived from this item's fields",
  },
  manual: { label: "You", title: "You typed this" },
};

/// The names of REQUIRED aspects (per the category spec) that have no value.
/// Identical rule to the edge requiredMissingAspects — the single source of
/// truth for "what's still missing before publish".
export function requiredMissingAspectNames(
  aspectList: EbayAspect[],
  values: Record<string, string[]>,
): string[] {
  return aspectList
    .filter((a) => a.aspectConstraint.aspectRequired)
    .map((a) => a.localizedAspectName ?? "")
    .filter((n) => n.length > 0 && (values[n]?.length ?? 0) === 0);
}

const PRECEDENCE: Record<StoredAspectProvenance, number> = {
  inventory_derived: 0,
  ai_extracted: 1,
  manual: 2,
};

/// Drop source entries whose aspect no longer has a value (cleared fields), so
/// the persisted map never goes stale relative to the value map.
export function pruneSources(
  sources: AspectSourceMap,
  values: Record<string, string[]>,
): AspectSourceMap {
  const out: AspectSourceMap = {};
  for (const [name, src] of Object.entries(sources)) {
    if ((values[name]?.length ?? 0) > 0) out[name] = src;
  }
  return out;
}

/// Higher-precedence source wins when both attribute the same aspect.
export function strongerSource(
  a: StoredAspectProvenance | undefined,
  b: StoredAspectProvenance,
): StoredAspectProvenance {
  if (!a) return b;
  return PRECEDENCE[b] >= PRECEDENCE[a] ? b : a;
}
