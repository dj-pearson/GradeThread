// The admin form behind PATCH /api/admin/grading/prompts/:id/shadow.
//
// The edge (services/edge-functions/src/lib/prompt-shadow-toggle.ts) is the
// authority and refuses anything this lets through; this file only keeps the
// form from offering what the server will refuse. The per_image ceiling is
// mirrored rather than imported (two projects), and
// src/test/prompt-shadow.test.ts fails if the two numbers drift.

/** Mirror of the edge's PER_IMAGE_SHADOW_MAX_SAMPLE_RATE. */
export const PER_IMAGE_SHADOW_MAX_SAMPLE_RATE = 0.05;

export type ShadowStage = "per_image" | "composite";

export interface ShadowFormInput {
  /** Percent, as typed: "2" means 2%. */
  ratePercent: string;
  dailyCap: string;
}

export type ShadowFormResult =
  | { ok: true; body: { is_shadow: true; shadow_sample_rate: number; shadow_daily_cap: number } }
  | { ok: false; error: string };

/** The largest percent the form accepts for this stage. */
export function maxShadowPercent(stage: ShadowStage): number {
  return stage === "per_image" ? PER_IMAGE_SHADOW_MAX_SAMPLE_RATE * 100 : 100;
}

/** Validate the form and build the request body that STARTS (or retunes) a shadow. */
export function buildShadowStartBody(stage: ShadowStage, input: ShadowFormInput): ShadowFormResult {
  const pct = Number(input.ratePercent.trim());
  const cap = Number(input.dailyCap.trim());
  const max = maxShadowPercent(stage);
  if (input.ratePercent.trim() === "" || !Number.isFinite(pct) || pct <= 0 || pct > max) {
    return { ok: false, error: `Sample rate must be above 0% and at most ${max}%.` };
  }
  if (input.dailyCap.trim() === "" || !Number.isInteger(cap) || cap < 1) {
    return { ok: false, error: "Daily cap must be a whole number of at least 1." };
  }
  // Four decimal places is what the column stores (numeric(5,4)).
  const rate = Math.round(pct * 100) / 10000;
  return { ok: true, body: { is_shadow: true, shadow_sample_rate: rate, shadow_daily_cap: cap } };
}
