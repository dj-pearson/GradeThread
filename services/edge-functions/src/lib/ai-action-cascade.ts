// Quality-gated model cascade for FlipDesk AI ACTIONS (US-1065 follow-up).
//
// The sibling of model-routing.ts (which cascades GRADING on a confidence
// score). This one cascades the tool-use / structured-output AI actions —
// AutoLister listing generation first — on a QUALITY assessment: run the cheap
// lightweight model (Haiku) first, and only re-run ("revise") on the stronger
// default model (Sonnet) when the first pass comes back missing fields, weak, or
// errors. For the confident majority that's ~3× cheaper with no quality loss;
// the rest get a second, stronger pass.
//
// Config-driven through the system_settings registry (`ai_action_model_cascade`)
// so it can be tuned or turned off WITHOUT a deploy, and it is OFF by default:
// grading behavior and listing quality are unchanged until an operator enables
// it (mirrors the grading cascade's deliberate opt-in). When enabled with no
// explicit models, first pass = lightweight (Haiku), escalation = the default
// model (Sonnet).

import { getSetting } from "./system-settings.ts";
import { getDefaultModel, getLightweightModel } from "./ai-config.ts";

export const AI_ACTION_CASCADE_SETTING_KEY = "ai_action_model_cascade";

export interface ActionCascadeConfig {
  enabled: boolean;
  /** Cheap model the first pass runs on. */
  firstPassModel: string;
  /** Stronger model a weak / missing / errored first pass is re-run on. */
  escalationModel: string;
  /** Escalate when the first-pass self-reported confidence is below this (0–1]. */
  confidenceThreshold: number;
}

// Cascade OFF by default → behavior is exactly today's single Sonnet pass. When
// enabled with no explicit models: first = Haiku, escalation = Sonnet.
export function defaultActionCascadeConfig(): ActionCascadeConfig {
  return {
    enabled: false,
    firstPassModel: getLightweightModel(),
    escalationModel: getDefaultModel(),
    confidenceThreshold: 0.7,
  };
}

function clampConfidence(raw: unknown, fallback: number): number {
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : fallback;
}

/**
 * Validate + normalize a raw settings value into an ActionCascadeConfig. Unlike
 * grading, AI actions have no model allowlist (any Coolify-configured model is
 * fine), so a non-string model just falls back to the default. Pure + exported
 * for unit tests.
 */
export function normalizeActionCascadeConfig(raw: unknown): ActionCascadeConfig {
  const d = defaultActionCascadeConfig();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.trim() ? v.trim() : fallback;
  return {
    enabled: r.enabled === true,
    firstPassModel: str(r.firstPassModel, d.firstPassModel),
    escalationModel: str(r.escalationModel, d.escalationModel),
    confidenceThreshold: clampConfidence(r.confidenceThreshold, d.confidenceThreshold),
  };
}

/**
 * Read + normalize the cascade config from the settings registry. Never throws
 * (getSetting serves a stale/fallback value on a DB hiccup), so a config-read
 * failure simply leaves AI actions on their default single-model behavior.
 */
export async function getActionCascadeConfig(): Promise<ActionCascadeConfig> {
  const raw = await getSetting<unknown>(AI_ACTION_CASCADE_SETTING_KEY, null);
  return normalizeActionCascadeConfig(raw);
}

/** A first-pass result's quality verdict. `sufficient` → keep it; else escalate. */
export interface CascadeAssessment {
  sufficient: boolean;
  /** Short machine-ish reason for logs (e.g. "low_confidence", "missing_category"). */
  reason: string;
}

export type ActionCascadeOutcome =
  | "cascade_disabled"
  | "no_stronger_model"
  | "first_pass_sufficient"
  | "first_pass_insufficient"
  | "first_pass_error";

export interface ActionCascadeResult<T> {
  result: T;
  /** The model whose output is being returned. */
  model: string;
  escalated: boolean;
  outcome: ActionCascadeOutcome;
  /** The assessor's reason when the first pass was rejected (else null). */
  reason: string | null;
}

/**
 * Run an AI action under the quality-gated cascade.
 *
 * - Cascade off, or first === escalation model → single pass on the escalation
 *   (default) model, exactly like today.
 * - Otherwise: run the first (cheap) model; if `assess` says the result is
 *   sufficient, return it. If it's insufficient — or the first pass THROWS
 *   (Haiku couldn't produce a valid result) — re-run on the stronger model and
 *   return that.
 *
 * `runOn` and `assess` are supplied by the caller so this stays generic across
 * action shapes. Spend attribution is the caller's (enterAiFeature) — both
 * passes are tagged to the same feature and land in the ai_usage ledger.
 */
export async function runActionCascade<T>(opts: {
  config: ActionCascadeConfig;
  runOn: (model: string) => Promise<T>;
  assess: (result: T, model: string) => CascadeAssessment;
  /** Optional log sink (feature label) — defaults to no-op. */
  onEscalate?: (info: { from: string; to: string; reason: string }) => void;
}): Promise<ActionCascadeResult<T>> {
  const { config, runOn, assess } = opts;

  if (!config.enabled || config.firstPassModel === config.escalationModel) {
    const result = await runOn(config.escalationModel);
    return {
      result,
      model: config.escalationModel,
      escalated: false,
      outcome: config.enabled ? "no_stronger_model" : "cascade_disabled",
      reason: null,
    };
  }

  let reason: string;
  try {
    const first = await runOn(config.firstPassModel);
    const verdict = assess(first, config.firstPassModel);
    if (verdict.sufficient) {
      return {
        result: first,
        model: config.firstPassModel,
        escalated: false,
        outcome: "first_pass_sufficient",
        reason: null,
      };
    }
    reason = verdict.reason;
  } catch (err) {
    // Haiku couldn't produce a valid result — don't fail the action, escalate.
    reason = `first_pass_error:${err instanceof Error ? err.message : String(err)}`;
  }

  opts.onEscalate?.({ from: config.firstPassModel, to: config.escalationModel, reason });
  const escalated = await runOn(config.escalationModel);
  return {
    result: escalated,
    model: config.escalationModel,
    escalated: true,
    outcome: reason.startsWith("first_pass_error")
      ? "first_pass_error"
      : "first_pass_insufficient",
    reason,
  };
}
