// US-3335: show the composite grader awarded reference photos (US-3334) as
// visual anchors, so a real 7 and a real 9 of the same category keep its scale
// steady.
//
// TWO locks, both required, both default closed:
//   1. GRADING_REFERENCE_ANCHORS (env, default OFF).
//   2. A PASSING anchor eval (system setting reference_anchor_eval), written by
//      runReferenceAnchorEval() after the golden set scored no worse with the
//      anchors than without them. Without a pass the flag alone does nothing.
// The baseline block shipped with a flag and no way to measure it; this one
// cannot be switched on without the measurement.
//
// Privacy: only awards whose owner is staff or opted into model refinement
// (US-3334's rule, re-checked here at use time, because consent can be
// withdrawn after the award). The photo leaves storage only as bytes into the
// model call; nothing about its owner goes with it. Labels are server-written.
//
// Leakage: an anchor from the SAME submission as the garment being graded is
// never attached. Otherwise a regrade of an awarded item, or a golden case cut
// from an awarded submission, would be shown its own photo with its own score.
//
// Cost: each anchor is a full image in the composite call. The composite usage
// is split so anchor tokens are metered on their own ai_usage_events phase;
// the total is unchanged.

import { supabaseAdmin } from "./supabase.ts";
import { getSetting } from "./system-settings.ts";
import { downloadGradingImage } from "./grading-image-encoding.ts";
import { ownerQualifies, type ReferenceFactor } from "./reference-photos.ts";
import type { AiTokenUsage } from "./ai-usage.ts";

export const REFERENCE_ANCHORS_FLAG = "GRADING_REFERENCE_ANCHORS";
export const REFERENCE_ANCHORS_DEFAULT_MAX = 3;
export const REFERENCE_ANCHORS_HARD_MAX = 4;
export const REFERENCE_ANCHOR_EVAL_SETTING = "reference_anchor_eval";
/** Cases that must carry anchors before an eval may pass. */
export const REFERENCE_ANCHOR_EVAL_MIN_CASES = 5;
/**
 * Anthropic resizes an image to about 1.15 megapixels and bills roughly
 * (w x h) / 750 tokens, so a full-size phone photo costs about 1,600. Used to
 * split the composite usage; an estimate, and never more than was billed.
 */
export const ANCHOR_IMAGE_TOKENS_ESTIMATE = 1600;

export function referenceAnchorsFlagOn(): boolean {
  const v = (Deno.env.get(REFERENCE_ANCHORS_FLAG) ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export function referenceAnchorsMax(): number {
  const n = Number.parseInt(Deno.env.get("GRADING_REFERENCE_ANCHORS_MAX") ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return REFERENCE_ANCHORS_DEFAULT_MAX;
  return Math.min(n, REFERENCE_ANCHORS_HARD_MAX);
}

export interface AnchorEvalRecord {
  passed: boolean;
  ran_at?: string;
  cases_with_anchors?: number;
  mae_off?: number | null;
  mae_on?: number | null;
  agreement_off?: number | null;
  agreement_on?: number | null;
}

/** Live grading uses anchors only with the flag on AND a passing eval. */
export async function referenceAnchorsActive(): Promise<boolean> {
  if (!referenceAnchorsFlagOn()) return false;
  const rec = await getSetting<AnchorEvalRecord>(REFERENCE_ANCHOR_EVAL_SETTING, { passed: false });
  return rec?.passed === true;
}

export interface ReferenceAnchor {
  dataUri: string;
  awardedScore: number;
  factor: ReferenceFactor | null;
  garmentCategory: string;
}

export interface AnchorCandidate {
  id: string;
  storage_path: string;
  awarded_score: number;
  factor: ReferenceFactor | null;
  garment_category: string;
  eligible: boolean;
}

/** "{owner}/{submission}/" for a submission-images path, or null. */
export function submissionFolder(storagePath: string): string | null {
  const parts = storagePath.split("/");
  return parts.length >= 3 && parts[0] && parts[1] ? `${parts[0]}/${parts[1]}/` : null;
}

/**
 * Pure: which awards to attach. Eligible only, never one from the garment's
 * own submission, and spread across the scale: the highest, the lowest, then
 * the middle, so the model sees a range rather than three 9s.
 */
export function pickAnchors(
  candidates: readonly AnchorCandidate[],
  max: number,
  ownStoragePaths: readonly string[],
): AnchorCandidate[] {
  const own = new Set(ownStoragePaths.map(submissionFolder).filter((f): f is string => !!f));
  const pool = candidates
    .filter((c) => c.eligible)
    .filter((c) => {
      const folder = submissionFolder(c.storage_path);
      return !folder || !own.has(folder);
    })
    .slice()
    .sort((a, b) => b.awarded_score - a.awarded_score || a.id.localeCompare(b.id));
  const picked: AnchorCandidate[] = [];
  const take = (c: AnchorCandidate | undefined) => {
    if (c && picked.length < max && !picked.includes(c)) picked.push(c);
  };
  take(pool[0]);
  take(pool[pool.length - 1]);
  // Then, each time, the award farthest in score from everything already
  // picked. Ties keep pool order (score, then id), so the choice is stable.
  while (picked.length < max) {
    let best: AnchorCandidate | undefined;
    let bestGap = -1;
    for (const c of pool) {
      if (picked.includes(c)) continue;
      const gap = Math.min(...picked.map((p) => Math.abs(p.awarded_score - c.awarded_score)));
      if (gap > bestGap) {
        best = c;
        bestGap = gap;
      }
    }
    if (!best) break;
    take(best);
  }
  return picked.sort((a, b) => b.awarded_score - a.awarded_score);
}

const FACTOR_WORDS: Record<ReferenceFactor, string> = {
  fabric_condition: "fabric condition",
  structural_integrity: "structural integrity",
  cosmetic_appearance: "cosmetic appearance",
  functional_elements: "functional elements",
  odor_cleanliness: "cleanliness",
};

/** The server-written label that goes in front of each anchor image. */
export function anchorLabel(
  a: Pick<ReferenceAnchor, "awardedScore" | "factor" | "garmentCategory">,
): string {
  const score = a.awardedScore.toFixed(1);
  return a.factor
    ? `Reference photo, NOT this garment: another ${a.garmentCategory} whose ${FACTOR_WORDS[a.factor]} scored ${score}.`
    : `Reference photo, NOT this garment: another ${a.garmentCategory} whose overall grade was ${score}.`;
}

/** Appended to the composite user prompt ONLY when anchors are attached. */
export const REFERENCE_ANCHORS_ADDENDUM =
  `REFERENCE PHOTOS: the photos labeled "Reference photo, NOT this garment" are other garments of the same category that GradeThread graders scored, attached only to calibrate what a score looks like. Do not grade them, do not describe them, and do not carry any of their flaws, features or scores into this garment's defects_found, factor scores or summary. Grade THIS garment from its own analyses and photos.`;

/**
 * Load up to `max` anchors for a category, excluding the garment's own
 * submission. Never throws: any failure attaches nothing.
 */
export async function loadReferenceAnchors(
  garmentCategory: string,
  ownStoragePaths: readonly string[],
  max: number = referenceAnchorsMax(),
): Promise<ReferenceAnchor[]> {
  try {
    const { data: awards } = await supabaseAdmin
      .from("grading_reference_photos")
      .select("id, submission_image_id, awarded_score, factor, garment_category")
      .eq("garment_category", garmentCategory)
      .is("revoked_at", null)
      .limit(100);
    const rows = (awards ?? []) as Array<{
      id: string;
      submission_image_id: string;
      awarded_score: number;
      factor: ReferenceFactor | null;
      garment_category: string;
    }>;
    if (rows.length === 0) return [];

    const { data: imgs } = await supabaseAdmin
      .from("submission_images")
      .select("id, submission_id, storage_path")
      .in("id", rows.map((r) => r.submission_image_id));
    const images = new Map(
      ((imgs ?? []) as Array<{ id: string; submission_id: string; storage_path: string }>)
        .map((i) => [i.id, i]),
    );
    const subIds = [...new Set([...images.values()].map((i) => i.submission_id))];
    const { data: subs } = subIds.length
      ? await supabaseAdmin.from("submissions").select("id, user_id").in("id", subIds)
      : { data: [] };
    const ownerOf = new Map(
      ((subs ?? []) as Array<{ id: string; user_id: string }>).map((s) => [s.id, s.user_id]),
    );
    const ownerIds = [...new Set(ownerOf.values())];
    const { data: owners } = ownerIds.length
      ? await supabaseAdmin.from("users").select("id, role, share_sale_outcomes").in("id", ownerIds)
      : { data: [] };
    const qualifies = new Map(
      ((owners ?? []) as Array<{ id: string; role: string | null; share_sale_outcomes: boolean | null }>)
        .map((o) => [o.id, ownerQualifies(o.role, o.share_sale_outcomes)]),
    );

    const candidates: AnchorCandidate[] = rows.flatMap((r) => {
      const img = images.get(r.submission_image_id);
      if (!img) return [];
      const owner = ownerOf.get(img.submission_id);
      return [{
        id: r.id,
        storage_path: img.storage_path,
        awarded_score: Number(r.awarded_score),
        factor: r.factor,
        garment_category: r.garment_category,
        eligible: owner ? qualifies.get(owner) === true : false,
      }];
    });

    const picked = pickAnchors(candidates, max, ownStoragePaths);
    const out: ReferenceAnchor[] = [];
    for (const c of picked) {
      try {
        out.push({
          dataUri: await downloadGradingImage(c.storage_path),
          awardedScore: c.awarded_score,
          factor: c.factor,
          garmentCategory: c.garment_category,
        });
      } catch {
        // One unreadable anchor drops that anchor, not the grade.
      }
    }
    return out;
  } catch (err) {
    console.warn(
      `[reference-anchors] load failed for ${garmentCategory}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Split a composite call's usage so the anchor images are metered on their own
 * phase. The anchors' share is an estimate capped at what was billed; the two
 * parts always sum to the original.
 */
export function splitAnchorUsage(
  usage: AiTokenUsage,
  anchorCount: number,
): { composite: AiTokenUsage; anchors: AiTokenUsage | null } {
  if (anchorCount <= 0) return { composite: usage, anchors: null };
  const anchorTokens = Math.min(usage.inputTokens, anchorCount * ANCHOR_IMAGE_TOKENS_ESTIMATE);
  return {
    composite: { ...usage, inputTokens: usage.inputTokens - anchorTokens },
    anchors: {
      ...usage,
      inputTokens: anchorTokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  };
}
