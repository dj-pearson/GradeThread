// US-1066: confidence-gated model routing (cheaper-model cascade) for grading.
//
// Grading runs a cheap FIRST PASS (e.g. haiku) and escalates to a stronger model
// (sonnet/opus) ONLY when the first-pass confidence is low or the item is
// high-value — cutting AI spend on the confident majority without hurting grade
// quality. The cascade is config-driven through the system_settings registry
// (`grading_model_cascade`, migration 00239) so it can be tuned or turned off
// WITHOUT a deploy.
//
// It is OFF by default so grading behavior is unchanged until an operator BOTH
// qualifies the cheap first-pass model against the eval gate (runEval with a
// modelOverride — grading-eval.ts) AND enables it. Both models are validated
// against the grading allowlist (ai-config.ts) — an unvetted model can never
// silently grade traffic, exactly like getGradingCompositeModel().

import { getSetting } from "./system-settings.ts";
import {
  getDefaultModel,
  getLightweightModel,
  isAllowedGradingModel,
} from "./ai-config.ts";

export const GRADING_CASCADE_SETTING_KEY = "grading_model_cascade";

export interface CascadeConfig {
  enabled: boolean;
  /** Cheap model the first grading pass runs on. */
  firstPassModel: string;
  /** Stronger model a low-confidence / high-value grade is re-run on. */
  escalationModel: string;
  /** Escalate when the first-pass confidence is strictly below this (0–1]. */
  confidenceThreshold: number;
  /** Escalate regardless of confidence when the item's value (USD) is at least
   *  this. `null` disables value-based escalation. */
  highValueUsd: number | null;
}

// Cascade OFF by default. When enabled with no explicit models, first pass =
// lightweight (haiku), escalation = the default grading model (sonnet); the
// confidence gate mirrors the human-review threshold default.
export function defaultCascadeConfig(): CascadeConfig {
  return {
    enabled: false,
    firstPassModel: getLightweightModel(),
    escalationModel: getDefaultModel(),
    confidenceThreshold: 0.75,
    highValueUsd: null,
  };
}

function clampConfidence(raw: unknown, fallback: number): number {
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : fallback;
}

/**
 * Validate + normalize a raw settings value into a CascadeConfig. A first- or
 * escalation-model that isn't on the grading allowlist is rejected (warn + fall
 * back to the default model) so an unvetted model can never silently grade.
 * Pure + exported for unit tests.
 */
export function normalizeCascadeConfig(raw: unknown): CascadeConfig {
  const d = defaultCascadeConfig();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;

  const resolveModel = (value: unknown, fallback: string, label: string): string => {
    if (typeof value !== "string") return fallback;
    if (isAllowedGradingModel(value)) return value.trim();
    console.warn(
      `[model-routing] ${label} "${value}" is NOT on the grading allowlist — ` +
        `falling back to ${fallback}. Add it to GRADING_MODEL_ALLOWLIST once ` +
        `qualified against the eval gate.`,
    );
    return fallback;
  };

  let highValueUsd: number | null = d.highValueUsd;
  if (r.highValueUsd === null) {
    highValueUsd = null;
  } else if (
    typeof r.highValueUsd === "number" &&
    Number.isFinite(r.highValueUsd) &&
    r.highValueUsd > 0
  ) {
    highValueUsd = r.highValueUsd;
  }

  return {
    enabled: r.enabled === true,
    firstPassModel: resolveModel(r.firstPassModel, d.firstPassModel, "firstPassModel"),
    escalationModel: resolveModel(r.escalationModel, d.escalationModel, "escalationModel"),
    confidenceThreshold: clampConfidence(r.confidenceThreshold, d.confidenceThreshold),
    highValueUsd,
  };
}

/**
 * Read + normalize the cascade config from the settings registry. Never throws
 * (getSetting serves a stale/fallback value on a DB hiccup), so a config-read
 * failure simply leaves grading on its default single-model behavior.
 */
export async function getCascadeConfig(): Promise<CascadeConfig> {
  const raw = await getSetting<unknown>(GRADING_CASCADE_SETTING_KEY, null);
  return normalizeCascadeConfig(raw);
}

export type EscalationReason =
  | "cascade_disabled"
  | "no_stronger_model"
  | "high_value"
  | "low_confidence"
  | "confident";

export interface EscalationDecision {
  escalate: boolean;
  reason: EscalationReason;
}

/**
 * Pure decision: should the first-pass grade be re-run on the escalation model?
 * High-value short-circuits the confidence gate (a costly item is worth the
 * stronger model regardless); otherwise escalate only when confidence is below
 * the threshold. Exported + pure for unit tests.
 */
export function decideEscalation(input: {
  confidence: number;
  itemValueUsd: number | null;
  config: CascadeConfig;
}): EscalationDecision {
  const { confidence, itemValueUsd, config } = input;
  if (!config.enabled) return { escalate: false, reason: "cascade_disabled" };
  // Re-running the same model would just double-spend for no quality gain.
  if (config.firstPassModel === config.escalationModel) {
    return { escalate: false, reason: "no_stronger_model" };
  }
  if (
    config.highValueUsd !== null &&
    itemValueUsd !== null &&
    itemValueUsd >= config.highValueUsd
  ) {
    return { escalate: true, reason: "high_value" };
  }
  if (confidence < config.confidenceThreshold) {
    return { escalate: true, reason: "low_confidence" };
  }
  return { escalate: false, reason: "confident" };
}
