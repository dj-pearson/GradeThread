// How /prospect decides who identifies the item — US-2759.
//
// THE GAP THIS CLOSES. chooseProviders was wired into /appraise only. /prospect
// — the route the phone calls, and the only one anyone uses standing in a shop —
// did its own identification through extractMatchHints and never reached the
// seam. So flipping SCOUT_EBAY_IMAGE_SEARCH_ENABLED changed the web and left the
// phone exactly as it was.
//
// WHY THIS IS NOT "WIRE THE SAME CALL IN" (AC2). /prospect already identifies
// from photos. Adding a second photo-identification mechanism in front of it
// needs a rule for which one wins, and the two are not competing at the same
// task:
//
//   extractMatchHints READS THE TAG. It is OCR plus reasoning over text. When a
//   tag is in frame and legible, the brand it returns is written on the garment.
//   That is the strongest evidence available short of a barcode.
//
//   eBay visual search MATCHES THE SILHOUETTE. US-2758 measured it naming the
//   exact style from a whole-garment shot with no tag anywhere in the frame
//   ("Rest Less 1/2 Zip Swirl Scroll Thumbhole", correct down to the cuffs).
//   It also returned five Lululemon tanks for a garment carrying no brand mark
//   at all, with no expressed doubt.
//
// So the rule follows what the SELLER DID, which is the one signal neither
// mechanism can fake:
//
//   they photographed the tag   -> read the tag. Text beats similarity, and
//                                  spending an AI action on the thing they went
//                                  to the trouble of photographing is the point.
//   front/back/flatlay only     -> visual search. There is no tag to read, so
//                                  hints would be looking for text that is not
//                                  there, and visual search is both cheaper and
//                                  better at this exact case.
//   anything else / unlabelled  -> today's path, unchanged.
//
// AC3, THE COST. When visual search carries the identification, extractMatchHints
// does not run at all — so a prospect costs ONE metered AI action instead of two.
// Over the cart of twenty that US-2760 is about, that is 40 actions to 20. The
// grade still costs its action; nothing here makes an ungraded answer.
//
// Nothing in this file calls anything. It decides, and is tested by reading its
// decision, so the route's job is reduced to obeying it.

import { roleCanIdentify } from "./scout-identify.ts";

/** Roles that mean "there is readable text on this garment, in frame". */
const TAG_ROLES: ReadonlySet<string> = new Set(["tag", "label"]);

export interface ProspectPlan {
  /** Try eBay visual search before anything else. */
  useVisual: boolean;
  /**
   * Run extractMatchHints unconditionally, before comps.
   *
   * False does NOT mean hints can never run: a visual search that declines or
   * finds nothing still falls back, and the route must handle that. It means
   * hints is not run SPECULATIVELY, which is where the second AI action went.
   */
  runHints: boolean;
  /** Why, for the metric and for the log. Short and stable enough to group by. */
  reason:
    | "flag-off"
    | "tag-photographed"
    | "garment-only"
    | "no-usable-role";
}

/**
 * Decide who identifies this prospect.
 *
 * `imageRoles` is the roles of the submitted photos IN ORDER, using whatever the
 * client sent. An empty array, or roles nobody recognises, is the
 * no-usable-role case and keeps today's behaviour — the same posture US-2762
 * takes on the provider itself, and for the same reason: an unlabelled photo is
 * likelier to be a detail shot than a flatlay.
 */
export function planProspectIdentification(args: {
  visualEnabled: boolean;
  imageRoles: readonly (string | null | undefined)[];
}): ProspectPlan {
  if (!args.visualEnabled) {
    return { useVisual: false, runHints: true, reason: "flag-off" };
  }

  const roles = args.imageRoles
    .filter((r): r is string => typeof r === "string")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);

  // The seller went to the trouble of photographing the tag. Read it.
  if (roles.some((r) => TAG_ROLES.has(r))) {
    return { useVisual: false, runHints: true, reason: "tag-photographed" };
  }

  // A garment shot with no tag is exactly the case visual search measured best
  // on, and exactly the case hints is weakest on — there is no text to read.
  if (roles.some((r) => roleCanIdentify(r))) {
    return { useVisual: true, runHints: false, reason: "garment-only" };
  }

  return { useVisual: false, runHints: true, reason: "no-usable-role" };
}

/**
 * Which submitted photo should visual search be shown?
 *
 * The FIRST identifying one, because /prospect documents its first image as the
 * front and that is the shot the spike measured best on. Returns -1 when none
 * qualifies, which the caller must treat as "do not call visual search" rather
 * than as "use index 0".
 */
export function pickVisualImageIndex(
  imageRoles: readonly (string | null | undefined)[],
): number {
  for (let i = 0; i < imageRoles.length; i++) {
    if (roleCanIdentify(imageRoles[i])) return i;
  }
  return -1;
}

/**
 * Roles a visual search should be shown FIRST, best-measured first (US-2780).
 *
 * The order is the spike's result, not a preference. Whole-garment shots landed
 * the brand five times out of five; a tag macro works only when the WORDMARK is
 * legible, and a hem tag carrying just a logo returned Athleta leggings for a
 * Faherty polo. So `tag` and `label` stay eligible - they measured well often
 * enough to keep - but they never displace a garment shot.
 */
const VISUAL_ROLE_PRIORITY = ["front", "back", "flatlay", "label", "tag"] as const;

/**
 * How many photos one identification searches.
 *
 * Three, because three is how many genuinely different angles a garment shoot
 * produces. A fourth would be another crop of one of these, and two shots of
 * the same angle agreeing is one opinion counted twice.
 */
export const MAX_VISUAL_PHOTOS = 3;

/**
 * Which photos should visual search be shown, best first (US-2780).
 *
 * ONE PER ROLE. Two front shots of one garment are one angle photographed
 * twice: they will agree, and the agreement means nothing. The whole value of
 * a second search is that it is a second LOOK, so the de-duplication is on the
 * role rather than on the file.
 *
 * Returns [] when nothing qualifies. That is "do not search", never "search
 * index 0" - unknown roles are not permission, for the reason roleCanIdentify
 * documents.
 */
export function pickVisualImageIndices(
  imageRoles: readonly (string | null | undefined)[],
  max: number = MAX_VISUAL_PHOTOS,
): number[] {
  const seenRoles = new Set<string>();
  const picked: Array<{ index: number; rank: number }> = [];

  for (let i = 0; i < imageRoles.length; i++) {
    const raw = imageRoles[i];
    if (!roleCanIdentify(raw)) continue;
    const role = String(raw).trim().toLowerCase();
    if (seenRoles.has(role)) continue;
    seenRoles.add(role);
    const rank = VISUAL_ROLE_PRIORITY.indexOf(
      role as (typeof VISUAL_ROLE_PRIORITY)[number],
    );
    // A role that passes the gate but is not in the priority list sorts last
    // rather than being dropped: roleCanIdentify is the authority on
    // eligibility, and this list only decides the order.
    picked.push({ index: i, rank: rank < 0 ? VISUAL_ROLE_PRIORITY.length : rank });
  }

  return picked
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, Math.max(0, max))
    // Back into photo order, so the caller's logs read the way the shoot does.
    .map((p) => p.index)
    .sort((a, b) => a - b);
}
