import { FLIPDESK_PHOTO_TYPES, REQUIRED_PHOTO_TYPES } from "@/lib/constants";

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
