// US-1533: garment baseline knowledge layer.
//
// DESIGN_VS_DEFECT_PRINCIPLE tells the grader to "grade against as-manufactured
// state" — this module supplies WHAT that state is for a given brand + garment
// category: a short expectation brief (fabric character, intentional
// distressing/finish, common honest-wear points, known failure modes),
// generated ONCE by a cheap text-only AI call on first encounter and cached in
// garment_baselines (migration 00341). The grading pipeline injects the brief
// into its prompts as TRUSTED reference context — a server-generated channel,
// so brand knowledge returns WITHOUT weakening the US-346 injection defense
// (seller text stays fenced and untrusted).
//
// Rollout gate: GRADING_BASELINES env flag, default OFF — enabling is a
// deliberate operator step after the golden-set eval + canary run (US-1533
// AC4), never a silent hot change. When off (or on any failure) the grade
// proceeds exactly as today: baselines are strictly additive.
//
// Reads are always DB-fresh (no in-memory cache), so an admin brief edit is
// live on the next grade with no invalidation step.

import { getAnthropicClient, getDefaultModel } from "./ai-config.ts";
import { getHaikuModel } from "./ai-extract.ts";
import { enterAiFeature } from "./ai-feature-context.ts";
import { supabaseAdmin } from "./supabase.ts";

export const BASELINE_GEN_PROMPT_VERSION = "baseline_gen_v1";

/** Max brief length persisted/injected — keeps the prompt-token cost bounded. */
export const MAX_BASELINE_BRIEF_CHARS = 1200;

/** US-1533 rollout gate (default OFF — enable after eval + canary). */
export function gradingBaselinesEnabled(): boolean {
  const v = (Deno.env.get("GRADING_BASELINES") ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * Normalized brand key for the cache row. Null (skip baselines entirely) for
 * empty/unknown brands — a baseline for "Unknown" would be generic noise.
 */
export function normalizeBaselineBrand(brand: string | null | undefined): string | null {
  const b = (brand ?? "").trim().toLowerCase();
  if (b === "" || b === "unknown" || b === "n/a" || b === "none") return null;
  return b.slice(0, 80);
}

/**
 * The prompt block the grading pipeline injects. Clearly labeled as TRUSTED
 * server-generated reference (distinct from the fenced seller text) and
 * guard-railed: expectations never excuse visible damage.
 */
export function baselineReferenceBlock(brief: string): string {
  const clean = brief.trim().slice(0, MAX_BASELINE_BRIEF_CHARS);
  if (clean === "") return "";
  return `REFERENCE BASELINE (trusted, server-generated — how this garment looks AS MANUFACTURED):
${clean}

Use this baseline to tell intentional design/finish from damage and to weight honest wear appropriately. It describes EXPECTATIONS ONLY: visible damage still scores as damage — the baseline never excuses a defect you can see.`;
}

const GEN_SYSTEM_PROMPT =
  `You write factory-condition reference briefs for a clothing-grading service.
Given a brand and a garment category, produce a SHORT brief (120-180 words, plain prose or tight bullet lines) covering:
- fabric character as manufactured (typical materials/finish for this brand+category and how they look/feel new),
- intentional distressing or finish details a grader could mistake for damage (raw hems, factory fading, waxed patina, deliberate slubs),
- common HONEST-WEAR points and what early wear looks like there,
- known failure modes for this brand+category (what tends to break/degrade first).
Rules: describe expectations only — never instructions about scores. If the brand is unfamiliar, write category-level norms and say so ("generic norms for this category"). No marketing language. No headers, no preamble — just the brief.`;

// Injectable generation seam so tests exercise the flow without an AI call.
export const _baselineGen = {
  generate: async (
    brand: string,
    garmentCategory: string,
  ): Promise<{ brief: string; model: string }> => {
    enterAiFeature("grading_baseline"); // US-894 spend attribution
    const client = getAnthropicClient();
    const model = getHaikuModel() || getDefaultModel();
    const response = await client.messages.create({
      model,
      max_tokens: 500,
      system: GEN_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Brand: ${brand}\nGarment category: ${garmentCategory}`,
        },
      ],
    });
    const text = response.content.find((b) => b.type === "text");
    return {
      brief: text && text.type === "text" ? text.text.trim() : "",
      model,
    };
  },
};

/**
 * Cache-first baseline brief for (brand, category). Generates + persists on
 * first encounter. Returns null (grade proceeds baseline-free) on: disabled
 * flag, unusable brand, generation failure, or any DB error — strictly
 * additive by construction.
 */
export async function getGarmentBaseline(args: {
  brand: string | null | undefined;
  garmentCategory: string;
  style?: string | null;
}): Promise<string | null> {
  if (!gradingBaselinesEnabled()) return null;
  const brand = normalizeBaselineBrand(args.brand);
  const category = (args.garmentCategory ?? "").trim().toLowerCase();
  if (!brand || category === "") return null;
  const style = (args.style ?? "").trim().toLowerCase();

  try {
    // Cache-first: style-specific row, then the brand+category ('') row.
    const { data: rows } = await supabaseAdmin
      .from("garment_baselines")
      .select("brief, style")
      .eq("brand", brand)
      .eq("garment_category", category);
    const list = (rows ?? []) as Array<{ brief: string; style: string }>;
    const hit = (style !== "" && list.find((r) => r.style === style)) ||
      list.find((r) => r.style === "");
    if (hit && hit.brief.trim() !== "") return hit.brief;

    const generated = await _baselineGen.generate(brand, category);
    const brief = generated.brief.trim().slice(0, MAX_BASELINE_BRIEF_CHARS);
    if (brief === "") return null;

    // Persist for next time; a concurrent generator racing us is fine — the
    // unique key makes the second insert a no-op and we still return OUR brief.
    await supabaseAdmin
      .from("garment_baselines")
      .upsert(
        {
          brand,
          garment_category: category,
          style: "",
          brief,
          model: generated.model,
          prompt_version: BASELINE_GEN_PROMPT_VERSION,
        },
        { onConflict: "brand,garment_category,style", ignoreDuplicates: true },
      )
      .then(() => {}, () => {});
    return brief;
  } catch (err) {
    console.error(
      "[garment-baselines] lookup/generation failed (grading proceeds baseline-free):",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
