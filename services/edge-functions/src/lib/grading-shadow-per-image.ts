// Per-image shadow grading on live traffic (US-2443).
//
// grading-shadow.ts compares two COMPOSITE prompts over identical per-image
// evidence. This file is the other stage: it re-analyzes the SAME photos under a
// challenger per-image artifact — a whole system prompt (ai_prompt_versions) or
// one block of the user message (ai_prompt_block_versions, US-2438) — and
// re-composites, so a per-image change finally has a live-traffic evidence path
// instead of a golden set and a flag.
//
// ── The four decisions that shape this file ────────────────────────────────
//
// 1. IT RE-DOWNLOADS THE PHOTOS. By the time shadow runs (pipeline step 7) the
//    base64 data URIs are gone: grading-pipeline.ts holds them inside
//    withImageBufferSlot, a process-wide memory gate whose entire purpose is
//    bounding how many submissions buffer multi-MB image data at once, and the
//    closure scopes them so they are GC-eligible the moment it returns.
//    Threading them through to step 7 would defeat that gate for EVERY
//    submission, sampled or not. Running the challenger inside the buffer slot
//    would be cheapest and couples the shadow to the hot path, which AC2 exists
//    to prevent. So: re-download, on the sampled slice only. A storage fetch is
//    negligible beside a vision call per photo, and the shadow stays entirely
//    behind the seller's delivered grade.
//
// 2. IT RE-RUNS EVERY IMAGE, AND THAT IS FORCED. AC1 offered "every image or a
//    chosen subset". A subset cannot work: re-running two of six photos leaves a
//    composite built from a MIX of champion and challenger analyses, which is
//    neither leg and measures nothing. Per-factor deltas only exist downstream
//    of a composite, so the challenger leg is all images plus one composite. The
//    only cost lever left is the SUBMISSION sampling rate.
//
// 3. THE CHALLENGER'S COMPOSITE LEG USES THE CHAMPION'S COMPOSITE PROMPT. Both
//    legs pass the same bucketKey and no composite override, so the composite
//    stage is held fixed and the delta is attributable to the per-image change
//    alone. Letting the composite resolve differently would produce a number
//    nobody could act on: two changes, one delta.
//
// 4. COST IS COUNTED IN VISION CALLS, NOT ROWS. The composite path's daily cap
//    counts rows because a row is one cheap text call. Here a row is one vision
//    call per photo plus one composite, so the ceiling is a SUM over
//    grading_shadow_results.vision_calls for the day. The count fails CLOSED:
//    if the ceiling cannot be read, nothing is spent.
//
// ── What this costs, before anyone turns it on ─────────────────────────────
//
// projectedVisionCalls() below is the arithmetic, exported so the number in a
// planning conversation comes from the same function the guardrail uses. For
// scale: at 400 submissions/day, 6 photos each, ONE candidate at a 3% sampling
// rate, that is 12 sampled submissions × 7 calls = 84 extra vision calls a day.
// At 10% and two candidates it is 560/day, which is a different conversation.
// PER_IMAGE_SHADOW_DAILY_VISION_CAP is the hard stop regardless of what the
// per-candidate rates add up to.
//
// The orchestrator takes injectable deps so every branch — including "the
// challenger threw" and "the insert failed" — is exercised in
// grading-shadow-per-image_test.ts with no database and no vision call. AC2's
// promise (a shadow run can never affect the seller's grade) is therefore
// test-guarded rather than asserted: the function is fire-and-forget from the
// pipeline AND cannot throw, and both halves have a test.

import { supabaseAdmin } from "./supabase.ts";
import {
  analyzeImage,
  compositeGrade,
  type CompositeGradeResult,
  type FactorScores,
  type GarmentInfo,
  type PerImageAnalysis,
} from "./ai-grading.ts";
import type { PromptBlockKey, PromptBlockOverrides } from "./prompt-blocks.ts";
import { withImageBufferSlot } from "./grading-capacity.ts";
import { downloadGradingImage } from "./grading-image-encoding.ts";
import { agreementWithin, deriveDivergenceTags, roundTenth, shouldSample } from "./grading-shadow.ts";

/** The five factor keys, in the order the weights table lists them. */
export const FACTOR_KEYS: readonly (keyof FactorScores)[] = [
  "fabric_condition",
  "structural_integrity",
  "cosmetic_appearance",
  "functional_elements",
  "odor_cleanliness",
];

/**
 * Hard ceiling on per-image shadow vision calls per UTC day, across every
 * candidate. Env-overridable so it can be lowered without a deploy; a
 * non-numeric or negative value reads as 0, i.e. OFF.
 */
export function dailyVisionCap(): number {
  const raw = Deno.env.get("PER_IMAGE_SHADOW_DAILY_VISION_CAP");
  if (raw === undefined) return 0; // OFF until someone chooses a number
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// ── Pure helpers ────────────────────────────────────────────────────

/**
 * Signed per-factor deltas (challenger minus champion), rounded to 0.1.
 *
 * AC3's requirement, and the reason a bare "they differed" is not enough: a
 * candidate that moves fabric_condition by 0.5 on every garment is a systematic
 * recalibration, while one that moves odor_cleanliness on a few items is noise
 * in a factor no photo can really assess. Those are opposite decisions and the
 * overall score alone cannot tell them apart — fabric is weighted 30% and odor
 * 10%, so the same 0.5 factor move lands as 0.15 or 0.05 on the overall.
 */
export function perFactorDeltas(
  active: FactorScores,
  shadow: FactorScores,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of FACTOR_KEYS) {
    const a = active?.[k];
    const s = shadow?.[k];
    // `typeof`, NOT Number()+isFinite: the scores arrive as parsed model JSON,
    // so a factor the challenger omitted is null — and Number(null) is 0, which
    // is finite. That check would have written a -9 delta and reported a factor
    // the challenger never scored as a total collapse.
    if (typeof a !== "number" || typeof s !== "number") continue;
    if (!Number.isFinite(a) || !Number.isFinite(s)) continue;
    out[k] = roundTenth(s - a);
  }
  return out;
}

/**
 * Did the two legs land in the same tier?
 *
 * Tracked separately from score agreement because they answer different
 * questions. A 0.4 delta that straddles a tier boundary changes the words on the
 * certificate; a 0.5 delta inside a tier changes nothing the seller sees. A
 * summary that reported only score agreement would call the first one fine.
 */
export function tiersAgree(a: string | null, b: string | null): boolean | null {
  if (!a || !b) return null;
  return a === b;
}

/**
 * Vision calls per UTC day for a given traffic shape. Exported so the number in
 * a planning conversation and the number in the guardrail come from one place.
 *
 * `imagesPerSubmission + 1` because the challenger leg is every photo plus the
 * one composite that turns them into a grade.
 */
export function projectedVisionCalls(opts: {
  submissionsPerDay: number;
  imagesPerSubmission: number;
  sampleRate: number;
  candidates: number;
}): number {
  const { submissionsPerDay, imagesPerSubmission, sampleRate, candidates } = opts;
  if (![submissionsPerDay, imagesPerSubmission, sampleRate, candidates].every(
    (n) => Number.isFinite(n) && n >= 0,
  )) return 0;
  const rate = Math.min(sampleRate, 1);
  return Math.round(
    submissionsPerDay * rate * candidates * (imagesPerSubmission + 1),
  );
}

/** `block:<key>[<scope>]=<version>` — the label US-2438 established. */
export function blockCandidateLabel(
  blockKey: string,
  garmentScope: string | null,
  versionName: string,
): string {
  return `block:${blockKey}[${garmentScope ?? "*"}]=${versionName}`;
}

// ── Candidate shape ─────────────────────────────────────────────────

export interface PerImageShadowCandidate {
  /** "prompt" = a whole system prompt; "block" = one block of the user message. */
  kind: "prompt" | "block";
  id: string;
  /** What lands in shadow_prompt_version_name (already labelled for blocks). */
  label: string;
  /** Non-empty for kind="prompt". */
  promptText: string;
  /** Set for kind="block". */
  blockKey?: string;
  blockText?: string;
  garmentScope: string | null;
  sampleRate: number;
  dailyCap: number;
}

export interface PerImageShadowImage {
  imageType: string;
  storagePath: string;
}

export interface PerImageShadowContext {
  submissionId: string;
  userId: string;
  gradeReportId: string;
  images: PerImageShadowImage[];
  garmentInfo: GarmentInfo;
  styleHint: string[];
  activePromptVersion: string;
  activeOverallScore: number;
  activeGradeTier: string;
  activeFactorScores: FactorScores;
  rng?: () => number;
}

/** Every side effect, injectable so the orchestrator is testable end to end. */
export interface PerImageShadowDeps {
  loadCandidates(garmentScope: string | null): Promise<PerImageShadowCandidate[]>;
  /** Sum of vision_calls for stage='per_image' today. Must fail CLOSED. */
  countTodayVisionCalls(): Promise<number>;
  /** Rows written today for one candidate label (the per-candidate cap). */
  countTodayRows(label: string): Promise<number>;
  fetchImage(storagePath: string): Promise<string>;
  analyze(
    dataUri: string,
    imageType: string,
    cand: PerImageShadowCandidate,
    ctx: PerImageShadowContext,
  ): Promise<PerImageAnalysis>;
  composite(
    perImage: PerImageAnalysis[],
    ctx: PerImageShadowContext,
  ): Promise<CompositeGradeResult>;
  insert(row: Record<string, unknown>): Promise<void>;
  visionCap(): number;
}

// ── Live deps ───────────────────────────────────────────────────────

function startOfUtcDay(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export const liveDeps: PerImageShadowDeps = {
  async loadCandidates(garmentScope) {
    const out: PerImageShadowCandidate[] = [];

    const { data: prompts, error: pErr } = await supabaseAdmin
      .from("ai_prompt_versions")
      .select("id, version_name, prompt_text, garment_scope, shadow_sample_rate, shadow_daily_cap")
      .eq("is_shadow", true)
      .eq("stage", "per_image");
    if (pErr) throw new Error(`per-image prompt candidates: ${pErr.message}`);
    for (const r of (prompts ?? []) as Record<string, unknown>[]) {
      const text = String(r.prompt_text ?? "").trim();
      // An empty prompt_text means "the code default under this name" — there is
      // nothing to compare it against, so shadowing it would spend a vision call
      // per photo to prove a prompt equals itself.
      if (!text) continue;
      out.push({
        kind: "prompt",
        id: String(r.id),
        label: String(r.version_name),
        promptText: text,
        garmentScope: (r.garment_scope as string | null) ?? null,
        sampleRate: Number(r.shadow_sample_rate ?? 0),
        dailyCap: Number(r.shadow_daily_cap ?? 0),
      });
    }

    const { data: blocks, error: bErr } = await supabaseAdmin
      .from("ai_prompt_block_versions")
      .select("id, version_name, block_key, block_text, garment_scope, shadow_sample_rate, shadow_daily_cap")
      .eq("is_shadow", true)
      .eq("stage", "per_image");
    if (bErr) throw new Error(`per-image block candidates: ${bErr.message}`);
    for (const r of (blocks ?? []) as Record<string, unknown>[]) {
      const text = String(r.block_text ?? "").trim();
      if (!text) continue;
      const scope = (r.garment_scope as string | null) ?? null;
      out.push({
        kind: "block",
        id: String(r.id),
        label: blockCandidateLabel(String(r.block_key), scope, String(r.version_name)),
        promptText: "",
        blockKey: String(r.block_key),
        blockText: text,
        garmentScope: scope,
        sampleRate: Number(r.shadow_sample_rate ?? 0),
        dailyCap: Number(r.shadow_daily_cap ?? 0),
      });
    }

    // Scope filter here rather than in SQL: a block's scope dimension is
    // garment_type for some keys and garment_category for others (prompt-blocks
    // .ts owns that), so the caller passes the value it wants matched.
    return out.filter((c) => !c.garmentScope || c.garmentScope === garmentScope);
  },

  async countTodayVisionCalls() {
    const { data, error } = await supabaseAdmin
      .from("grading_shadow_results")
      .select("vision_calls")
      .eq("stage", "per_image")
      .gte("created_at", startOfUtcDay());
    if (error) {
      console.warn("[shadow:per-image] vision-call count failed; skipping:", error.message);
      return Number.MAX_SAFE_INTEGER; // fail CLOSED on the cost guardrail
    }
    return (data ?? []).reduce(
      (s: number, r: { vision_calls?: number | null }) => s + (r.vision_calls ?? 0),
      0,
    );
  },

  async countTodayRows(label) {
    const { count, error } = await supabaseAdmin
      .from("grading_shadow_results")
      .select("id", { count: "exact", head: true })
      .eq("stage", "per_image")
      .eq("shadow_prompt_version_name", label)
      .gte("created_at", startOfUtcDay());
    if (error) {
      console.warn("[shadow:per-image] daily-cap count failed; skipping:", error.message);
      return Number.MAX_SAFE_INTEGER;
    }
    return count ?? 0;
  },

  // The SAME downloader the live path and the eval harness use, so the
  // magic-byte media-type rule cannot be right on two legs and wrong on this one.
  fetchImage: downloadGradingImage,

  analyze(dataUri, imageType, cand, ctx) {
    const promptOverride = cand.kind === "prompt"
      ? { text: cand.promptText, versionName: cand.label }
      : undefined;
    const blockOverride: PromptBlockOverrides | undefined = cand.kind === "block"
      ? {
        [cand.blockKey as PromptBlockKey]: {
          text: cand.blockText!,
          versionName: cand.label,
        },
      }
      : undefined;
    return analyzeImage(
      dataUri,
      imageType,
      ctx.garmentInfo.garment_type,
      ctx.garmentInfo.garment_category,
      ctx.styleHint,
      promptOverride,
      undefined, // no model pin — a model change would confound the prompt delta
      // No bucketKey: a canary slice must not also decide what the CHALLENGER
      // leg runs, or the comparison silently becomes three-way.
      undefined,
      "",
      blockOverride,
    );
  },

  composite(perImage, ctx) {
    // No promptOverride and no bucketKey: the composite stage is held at
    // whatever the champion resolved, so the delta is the per-image change.
    return compositeGrade(perImage, ctx.garmentInfo);
  },

  async insert(row) {
    const { error } = await supabaseAdmin.from("grading_shadow_results").insert(row);
    if (error) throw new Error(error.message);
  },

  visionCap: dailyVisionCap,
};

// ── Orchestrator ────────────────────────────────────────────────────

/**
 * Run every applicable per-image shadow candidate against a just-graded
 * submission. Fire-and-forget from the pipeline.
 *
 * NEVER THROWS. Every failure is caught and logged, and a challenger that threw
 * is still recorded (with `error` set and its vision calls counted) so a
 * candidate that fails half the time is visible rather than absent. The seller's
 * grade is already written and delivered by the time this runs; nothing here
 * reads or writes grade_reports.
 */
export async function runPerImageShadowGrades(
  ctx: PerImageShadowContext,
  deps: PerImageShadowDeps = liveDeps,
): Promise<void> {
  try {
    const cap = deps.visionCap();
    if (cap <= 0) return; // OFF, and off is the default
    if (ctx.images.length === 0) return;

    const category = ctx.garmentInfo.garment_category || null;
    let candidates: PerImageShadowCandidate[];
    try {
      candidates = await deps.loadCandidates(category);
    } catch (err) {
      console.warn(
        "[shadow:per-image] candidate lookup failed:",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    if (candidates.length === 0) return;

    const rng = ctx.rng ?? Math.random;
    // The per-photo price of one candidate: every image plus the composite.
    const perRunCalls = ctx.images.length + 1;
    let spentToday: number | null = null;

    for (const cand of candidates) {
      if (cand.dailyCap <= 0) continue;
      if (!shouldSample(cand.sampleRate, rng)) continue;

      // Read the day's spend once, then account locally. Re-reading per
      // candidate would be a round trip per candidate for a number that only
      // this loop is moving.
      if (spentToday === null) spentToday = await deps.countTodayVisionCalls();
      if (spentToday + perRunCalls > cap) {
        console.warn(
          `[shadow:per-image] daily vision ceiling reached (${spentToday}/${cap}); skipping ${cand.label}`,
        );
        return;
      }
      if ((await deps.countTodayRows(cand.label)) >= cand.dailyCap) continue;

      await runOneCandidate(ctx, deps, cand, perRunCalls);
      spentToday += perRunCalls;
    }
  } catch (err) {
    // The outer net. Reaching here means a bug rather than a handled failure,
    // and it still must not surface into the pipeline.
    console.error(
      "[shadow:per-image] unexpected failure:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function runOneCandidate(
  ctx: PerImageShadowContext,
  deps: PerImageShadowDeps,
  cand: PerImageShadowCandidate,
  perRunCalls: number,
): Promise<void> {
  let shadow: CompositeGradeResult | null = null;
  let errMsg: string | null = null;
  let analyzed = 0;

  try {
    // The memory gate again: this buffers the same multi-MB base64 the live
    // path did. Running outside the slot would let a sampled shadow and a live
    // grade hold two copies at once, which is the bound the gate exists to keep.
    const perImage = await withImageBufferSlot(async () => {
      const dataUris = await Promise.all(
        ctx.images.map(async (img) => ({
          imageType: img.imageType,
          dataUri: await deps.fetchImage(img.storagePath),
        })),
      );
      return await Promise.all(
        dataUris.map((img) => deps.analyze(img.dataUri, img.imageType, cand, ctx)),
      );
    });
    analyzed = perImage.length;
    shadow = await deps.composite(perImage, ctx);
  } catch (err) {
    errMsg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[shadow:per-image] challenger failed for ${ctx.submissionId} / ${cand.label}:`,
      errMsg,
    );
  }

  const delta = shadow ? roundTenth(shadow.overall_score - ctx.activeOverallScore) : null;
  try {
    await deps.insert({
      submission_id: ctx.submissionId,
      user_id: ctx.userId,
      grade_report_id: ctx.gradeReportId,
      stage: "per_image",
      shadow_prompt_version_id: cand.kind === "prompt" ? cand.id : null,
      shadow_block_version_id: cand.kind === "block" ? cand.id : null,
      shadow_prompt_version_name: cand.label,
      active_prompt_version_name: ctx.activePromptVersion,
      model: shadow?.model ?? "(error)",
      active_overall_score: ctx.activeOverallScore,
      active_grade_tier: ctx.activeGradeTier,
      active_factor_scores: ctx.activeFactorScores,
      shadow_overall_score: shadow?.overall_score ?? null,
      shadow_grade_tier: shadow?.grade_tier ?? null,
      shadow_factor_scores: shadow?.factor_scores ?? null,
      score_delta: delta,
      agreement: shadow
        ? agreementWithin(shadow.overall_score, ctx.activeOverallScore)
        : null,
      tier_agreement: tiersAgree(ctx.activeGradeTier, shadow?.grade_tier ?? null),
      per_factor_deltas: shadow
        ? perFactorDeltas(ctx.activeFactorScores, shadow.factor_scores)
        : null,
      images_analyzed: analyzed,
      // Charged even on failure: the calls that DID go out were paid for, and a
      // ceiling that only counts successes is a ceiling a failing candidate can
      // walk straight through.
      vision_calls: perRunCalls,
      tags: deriveDivergenceTags(
        ctx.garmentInfo.garment_category || null,
        ctx.garmentInfo.style_attributes ?? [],
      ),
      error: errMsg,
    });
  } catch (err) {
    console.warn(
      `[shadow:per-image] result insert failed for ${ctx.submissionId} / ${cand.label}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
