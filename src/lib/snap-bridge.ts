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

// ── SNAP-13: snap to a prefilled FlipDesk intake ─────────────────────────────
//
// "List it with FlipDesk" was a bare link that dropped everything the snap had
// learned. This carries it to the intake form, which saves through its own
// owner-scoped insert and uploads the photo through the shared item-photo
// core, so there is no new write path.

/** Navigation state for /dashboard/flipdesk/intake, under `snap`. */
export interface SnapIntakeBridgeState {
  brand?: string;
  title?: string;
  garmentType?: string;
  garmentCategory?: string;
  /** The median comp, when the snap priced the item. */
  targetPriceCents?: number;
  /** A plain-language record of the estimate, for the item's internal notes. */
  conditionNote: string;
  /** Snap confidence, 0..1, so the intake can mark the note as AI-derived. */
  confidence: number;
  imageDataUri: string | null;
  /** What the seller said they would pay, when they entered it (SNAP-14). */
  paidCents?: number;
}

function titleCase(v: string): string {
  return v
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function buildIntakeBridge(
  result: SnapResult,
  source: SnapResultSource,
  paidCents?: number | null,
): SnapIntakeBridgeState {
  const base = buildSnapBridge(result, source);
  const g = result.grade;
  // The category ("jacket") names the garment better than the type ("outerwear").
  const kind = base.garmentCategory ?? base.garmentType;
  const typeWord = kind ? kind.replace(/_/g, " ") : undefined;
  const title = base.title ?? ([base.brand, typeWord].filter(Boolean).join(" ") || undefined);
  const median = result.value?.sufficient ? result.value.medianCents : null;
  return {
    brand: base.brand,
    title,
    garmentType: base.garmentType,
    garmentCategory: base.garmentCategory,
    ...(median != null && median > 0 ? { targetPriceCents: median } : {}),
    conditionNote: `Snap estimate ${g.overall_score.toFixed(1)} (${titleCase(g.grade_tier)}), ${Math.round(g.confidence * 100)}% confidence`,
    confidence: g.confidence,
    imageDataUri: base.imageDataUri ?? null,
    ...(paidCents != null && Number.isFinite(paidCents) && paidCents > 0 ? { paidCents } : {}),
  };
}
