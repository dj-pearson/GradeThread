import { FLIPDESK_PHOTO_TYPES, REQUIRED_PHOTO_TYPES } from "@/lib/constants";
import {
  checkSize,
  fixableSize,
  resolveSizeRow,
  type SizeBandsResponse,
  type SizeCheckVerdict,
} from "@/lib/size-check";

// US-1546 AC2: the pre-generate checkpoint. Every reason a group is worth a
// second look before the seller spends money on it, in one place.
//
// US-2520: extracted from autolister.tsx, which is on a shrink-only ratchet.
// It is pure — groups in, labels out — so the rules can be read and tested
// without mounting a 3,700-line page.

type PhotoRole = (typeof FLIPDESK_PHOTO_TYPES)[number];

/** Only the fields the checkpoint reads, so this module owns no page state. */
export interface WarnableGroup {
  id: string;
  name: string;
  photoIds: string[];
  coverId: string;
  roles?: Record<string, PhotoRole>;
}

export interface GroupWarning {
  key: string;
  groupId: string;
  label: string;
}

/** An unresolved US-1544 AI grouping suggestion. */
export interface WarnableSuggestion {
  id: string;
  type: string;
  group_ids: string[];
}

/** Below this the cover photo is worth reshooting (US-533 vision score). */
export const COVER_QA_REVIEW_THRESHOLD = 60;

/** A group holding this many photos is more likely to be two items. */
const BIG_GROUP_PHOTOS = 12;

/**
 * The photo_type a staged photo will SHIP with. The cover is a front unless the
 * seller retyped it; everything else defaults to detail.
 *
 * US-2769: shared with the checkpoint below, because "does this group have a
 * front?" and "what does generate() write?" have to be the same question. They
 * were two copies of the rule, and only one of them ran before the money was
 * spent.
 */
export function groupPhotoType(g: WarnableGroup, photoId: string): PhotoRole {
  return photoId === g.coverId
    ? (g.roles?.[photoId] ?? "front")
    : (g.roles?.[photoId] ?? "detail");
}

export function buildGroupWarnings(
  groups: readonly WarnableGroup[],
  coverScores: Record<string, number>,
  suggestions: readonly WarnableSuggestion[],
): GroupWarning[] {
  const warnings: GroupWarning[] = [];
  const nameOf = (g: WarnableGroup) => g.name || "Untitled group";

  for (const g of groups) {
    if (g.photoIds.length === 1) {
      warnings.push({
        key: `single-${g.id}`,
        groupId: g.id,
        label: `“${nameOf(g)}” has a single photo`,
      });
    } else if (g.photoIds.length > BIG_GROUP_PHOTOS) {
      warnings.push({
        key: `big-${g.id}`,
        groupId: g.id,
        label: `“${nameOf(g)}” has ${g.photoIds.length} photos — two items?`,
      });
    }

    // US-2769 AC3: the front is what the visual pass identifies the garment
    // from, and generate() spends money per group. A group only loses its front
    // by the seller retyping the cover, so this fires on a real mistake rather
    // than on every bulk dump — which is also why the checkpoint names the
    // front and not the whole REQUIRED_PHOTO_TYPES set. A back nobody tagged is
    // the norm here and would drown the list.
    const shipping = new Set(g.photoIds.map((id) => groupPhotoType(g, id)));
    if (!shipping.has(REQUIRED_PHOTO_TYPES[0])) {
      warnings.push({
        key: `front-${g.id}`,
        groupId: g.id,
        label: `“${nameOf(g)}” has no front photo — tag one before generating`,
      });
    }

    const score = coverScores[g.coverId];
    if (score != null && score >= 0 && score < COVER_QA_REVIEW_THRESHOLD) {
      warnings.push({
        key: `cover-${g.id}`,
        groupId: g.id,
        label: `“${nameOf(g)}” cover scored ${score} — reshoot recommended`,
      });
    }
  }

  // Unresolved AI suggestions count as open questions.
  for (const s of suggestions) {
    const g = groups.find((x) => x.id === s.group_ids[0]);
    if (!g) continue;
    warnings.push({
      key: `ai-${s.id}`,
      groupId: g.id,
      label: `AI suggestion open on “${nameOf(g)}” (${s.type})`,
    });
  }

  return warnings;
}

// -- US-2919: size versus measurements, over a generated batch ---------------
//
// The checkpoint above runs BEFORE generation, on photo groups that have no
// measurements yet. This half runs AFTER, on the drafts in the queue, and asks
// the US-2916 question of each one: does the size on the label agree with what
// the garment measures?
//
// It lives here because this is the module that owns "what is worth a second
// look", and a batch of forty listings is exactly where a mis-sized item slips
// through. Nobody re-reads forty drafts, but they will read a list of the three
// that disagree with their own chart.

/** Only the fields the size check reads off a generated draft. */
export interface SizeCheckableDraft {
  /** The inventory item id, which is what the queue row and the grid key on. */
  itemId: string;
  name: string;
  brand: string | null;
  /** The garment word the chart is resolved by ("tee", "jeans"). */
  garment: string | null;
  /** "Men" / "Women" / null. Null resolves to a generic chart, never a guess. */
  gender: string | null;
  size: string | null;
  measurements: Record<string, unknown> | null;
}

export interface SizeConflict {
  itemId: string;
  name: string;
  /** The size printed on the label. */
  labelled: string;
  /** What the measurements point at ("XS", or "smaller than XS"). */
  impliedSize: string;
  /** The size a one-click fix would write, or null when there is nothing to write. */
  fix: string | null;
  verdict: SizeCheckVerdict;
  tier: SizeBandsResponse["tier"];
}

/**
 * The distinct chart lookups a batch needs.
 *
 * A 40-item batch across 6 brands must issue 6 requests, not 40: the band table
 * depends only on (brand, garment, gender), and forty requests for six answers
 * is how a review screen earns a rate limit.
 */
export function sizeBandPairKey(
  brand: string | null,
  garment: string | null,
  gender: string | null,
): string {
  return [brand ?? "", garment ?? "", gender ?? ""]
    .map((s) => s.trim().toLowerCase())
    .join("|");
}

export interface SizeBandPair {
  key: string;
  brand: string | null;
  garment: string | null;
  gender: string | null;
}

export function sizeBandPairs(
  drafts: readonly SizeCheckableDraft[],
): SizeBandPair[] {
  const out = new Map<string, SizeBandPair>();
  for (const d of drafts) {
    // A draft with no size, no garment or nothing comparable to measure cannot
    // produce a verdict, so it must not produce a request either.
    if (!d.size?.trim() || !d.garment?.trim()) continue;
    if (!d.measurements || Object.keys(d.measurements).length === 0) continue;
    const key = sizeBandPairKey(d.brand, d.garment, d.gender);
    if (!out.has(key)) {
      out.set(key, { key, brand: d.brand, garment: d.garment, gender: d.gender });
    }
  }
  return [...out.values()];
}

/**
 * The drafts whose size disagrees with their own measurements.
 *
 * Silent on everything else, including every item with no chart at any tier.
 * "We could not check this" is not a finding, and a queue that says it forty
 * times has buried the three that matter.
 */
export function buildSizeConflicts(
  drafts: readonly SizeCheckableDraft[],
  bandsByPair: Readonly<Record<string, SizeBandsResponse | undefined>>,
): SizeConflict[] {
  const out: SizeConflict[] = [];
  for (const d of drafts) {
    const labelled = (d.size ?? "").trim();
    if (!labelled || !d.measurements) continue;
    const bands = bandsByPair[sizeBandPairKey(d.brand, d.garment, d.gender)];
    if (!bands || bands.rows.length === 0) continue;
    const verdict = checkSize({
      bands: bands.rows,
      rowIndex: resolveSizeRow(bands.rows, labelled),
      measurements: d.measurements,
      tier: bands.tier,
    });
    if (verdict.status !== "off" || !verdict.impliedSize) continue;
    out.push({
      itemId: d.itemId,
      name: d.name || "Untitled item",
      labelled,
      impliedSize: verdict.impliedSize,
      fix: fixableSize(verdict),
      verdict,
      tier: bands.tier,
    });
  }
  return out;
}

/** The same conflicts as checkpoint warnings, so they render in the one list. */
export function sizeWarningsFrom(
  conflicts: readonly SizeConflict[],
): GroupWarning[] {
  return conflicts.map((c) => ({
    key: `size-${c.itemId}`,
    groupId: c.itemId,
    label: `${quoted(c.name)} is labelled ${c.labelled} but measures like ${c.impliedSize}`,
  }));
}

/** Matches the curly quoting the checkpoint labels above already use. */
function quoted(name: string): string {
  return `“${name}”`;
}
