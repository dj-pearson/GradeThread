import type { SnapBridgeState, SnapResult } from "@/hooks/use-snap";
import type { SnapHistoryEntry } from "@/lib/snap-history";

// SNAP-04: one source for everything the result card derives.
//
// The card showed `revisited?.result ?? snap.data`, but the certified-grade
// bridge and the empty-value caption read the LIVE photo and inputs. So a
// revisited snap of garment A staged photo B (or null after a reload), and
// typing a brand flipped the caption to "not enough comps" when no comp lookup
// had run. Everything below takes the source the result came from.

/** What was actually submitted for the snap on screen. */
export interface SnapSubmittedInput {
  dataUri: string | null;
  brand: string;
  keyword: string;
}

export type SnapResultSource =
  | ({ kind: "live" } & SnapSubmittedInput)
  | { kind: "revisit"; entry: SnapHistoryEntry };

function clean(v: string | null | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

export function sourceBrand(source: SnapResultSource): string | undefined {
  return source.kind === "live" ? clean(source.brand) : clean(source.entry.brand);
}

export function sourceKeyword(source: SnapResultSource): string | undefined {
  return source.kind === "live" ? clean(source.keyword) : clean(source.entry.keyword);
}

/** Did the snap on screen ask for a comp lookup at all? */
export function sourceHadCompQuery(source: SnapResultSource): boolean {
  return Boolean(sourceBrand(source) || sourceKeyword(source));
}

/**
 * The certified-grade bridge. A revisit never carries a photo: the one on
 * screen (if any) is not the garment that was graded, and history keeps none.
 */
export function buildSnapBridge(result: SnapResult, source: SnapResultSource): SnapBridgeState {
  return {
    imageDataUri: source.kind === "live" ? source.dataUri : null,
    brand: sourceBrand(source),
    title: sourceKeyword(source),
    garmentType: result.garment?.type ?? undefined,
    garmentCategory: result.garment?.category ?? undefined,
  };
}

/** True when the fields on screen no longer match what was priced. */
export function inputsChangedSince(
  submitted: SnapSubmittedInput | null,
  brand: string,
  keyword: string,
): boolean {
  if (!submitted) return false;
  return (clean(submitted.brand) ?? "") !== (clean(brand) ?? "") ||
    (clean(submitted.keyword) ?? "") !== (clean(keyword) ?? "");
}
