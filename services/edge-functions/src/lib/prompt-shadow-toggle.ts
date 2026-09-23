// What PATCH /prompts/:id/shadow may write, for either grading stage.
//
// The route used to refuse every per_image row ("Only composite-stage prompts
// can be shadowed"), from before US-2443 built per-image shadow. The only way to
// start one was hand-written SQL (scripts/shadow-footwear-criteria.sql), which
// skips the audit row and every check below.
//
// The two stages cost different things, and that is the whole reason this is
// more than a validator:
//
//   composite  re-runs ONE text composite per sampled submission, reusing the
//              champion's per-image analyses. Cheap; unchanged here.
//   per_image  re-analyzes EVERY photo under the challenger, plus a composite:
//              ~7 vision calls per sampled submission. That is a bill, so it
//              gets three extra rules and a step-up:
//                1. PER_IMAGE_SHADOW_DAILY_VISION_CAP must be set. With it
//                   unset the orchestrator does nothing at all, and a toggle
//                   that reports "on" while nothing runs is worse than a 422.
//                2. sample rate at most PER_IMAGE_SHADOW_MAX_SAMPLE_RATE.
//                3. a non-empty prompt_text, a rate above 0 and a daily cap
//                   above 0 -- the per-image loader skips any row missing one,
//                   so each is another "on but idle" state.
//
// Stopping a shadow (is_shadow: false) never needs step-up and is never
// refused for a missing env var: turning spend OFF must always be easy.
//
// Pure, so every branch is tested without a database (prompt-shadow-toggle_test.ts).

/**
 * Highest per-image shadow sample rate the admin route will write. At 400
 * submissions/day and 6 photos each, 5% is ~20 sampled submissions x 7 calls =
 * ~140 extra vision calls a day for one candidate (projectedVisionCalls in
 * grading-shadow-per-image.ts is the same arithmetic). Anything wider is a
 * decision for SQL and a conversation, not a form field.
 */
export const PER_IMAGE_SHADOW_MAX_SAMPLE_RATE = 0.05;

export interface ShadowToggleRow {
  stage: string;
  prompt_text: string | null;
  is_shadow: boolean | null;
  shadow_sample_rate: number | string | null;
  shadow_daily_cap: number | null;
}

export interface ShadowToggleBody {
  is_shadow?: unknown;
  shadow_sample_rate?: unknown;
  shadow_daily_cap?: unknown;
}

export type ShadowTogglePlan =
  | { ok: true; update: Record<string, unknown>; needsStepUp: boolean }
  | { ok: false; status: 400 | 422; error: string };

export function planShadowToggle(
  row: ShadowToggleRow,
  body: ShadowToggleBody,
  perImageVisionCap: number,
): ShadowTogglePlan {
  const stage = row.stage;
  if (stage !== "composite" && stage !== "per_image") {
    return {
      ok: false,
      status: 422,
      error: "Only grading prompts (per_image or composite) can be shadowed",
    };
  }

  const update: Record<string, unknown> = {};
  if (typeof body.is_shadow === "boolean") update.is_shadow = body.is_shadow;
  if (body.shadow_sample_rate !== undefined) {
    const r = Number(body.shadow_sample_rate);
    if (!Number.isFinite(r) || r < 0 || r > 1) {
      return { ok: false, status: 400, error: "shadow_sample_rate must be between 0 and 1" };
    }
    update.shadow_sample_rate = r;
  }
  if (body.shadow_daily_cap !== undefined) {
    const cap = Number(body.shadow_daily_cap);
    if (!Number.isInteger(cap) || cap < 0) {
      return { ok: false, status: 400, error: "shadow_daily_cap must be a non-negative integer" };
    }
    update.shadow_daily_cap = cap;
  }
  if (Object.keys(update).length === 0) {
    return { ok: false, status: 400, error: "Nothing to update" };
  }

  if (stage === "composite") return { ok: true, update, needsStepUp: false };

  // ── per_image ──
  const rate = Number(update.shadow_sample_rate ?? row.shadow_sample_rate ?? 0);
  const willRun = update.is_shadow === true ||
    (update.is_shadow === undefined && row.is_shadow === true);
  // A stop, or an edit to a stopped row: spends nothing, so no step-up, no env
  // requirement and no rate ceiling. A row started by SQL at a wider rate must
  // still be stoppable from here.
  if (!willRun) return { ok: true, update, needsStepUp: false };

  if (rate > PER_IMAGE_SHADOW_MAX_SAMPLE_RATE) {
    return {
      ok: false,
      status: 400,
      error: `Per-image shadow re-analyzes every photo, so its sample rate is capped at ` +
        `${PER_IMAGE_SHADOW_MAX_SAMPLE_RATE * 100}%`,
    };
  }

  if (perImageVisionCap <= 0) {
    return {
      ok: false,
      status: 422,
      error: "Per-image shadow is off on this server: PER_IMAGE_SHADOW_DAILY_VISION_CAP is not set. " +
        "Set it on the edge service first, or nothing will run.",
    };
  }
  if (!String(row.prompt_text ?? "").trim()) {
    return {
      ok: false,
      status: 422,
      error: "This version has no prompt text of its own, so there is nothing to compare",
    };
  }
  const cap = Number(update.shadow_daily_cap ?? row.shadow_daily_cap ?? 0);
  if (!(rate > 0) || !(cap > 0)) {
    return {
      ok: false,
      status: 422,
      error: "Set a sample rate and a daily cap above 0, or the shadow will never run",
    };
  }
  return { ok: true, update, needsStepUp: true };
}
