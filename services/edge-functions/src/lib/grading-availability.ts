// US-3530: refuse a grade BEFORE charging when it cannot be graded soon.
//
// When Anthropic was down, each call could take 120s x 3 tries, every image
// slot filled, the in-memory queue grew without limit, and /submit kept
// accepting and charging. Two signals now stop that at the door:
//
//   1. The shared "anthropic" circuit breaker (ai-provider-anthropic.ts wraps
//      every call). Five consecutive transient failures (5xx, 429, timeout,
//      network) open it for 30s; while open, calls fail fast instead of
//      waiting out timeouts, and submits answer 503.
//   2. The grading image-buffer queue. More than GRADING_MAX_QUEUED_PIPELINES
//      (default 24) submissions already waiting for a slot means a new one
//      would wait tens of minutes and outlive its lease, so it is refused.
//
// Both are per process, like the queue and breaker themselves.

import { getBreaker } from "./circuit-breaker.ts";
import { isRetryableError } from "./retry.ts";
import { gradingQueueWaiting } from "./grading-capacity.ts";
import { promptGateBlocked } from "./prompt-serving-gate.ts";

// US-3521: a third signal, off unless GRADING_PROMPT_EVAL_GATE=enforce. See
// prompt-serving-gate.ts.
export type GradingUnavailableReason =
  | "ai_unavailable"
  | "queue_full"
  | "prompt_unevaluated";

export function anthropicBreaker() {
  return getBreaker("anthropic", {
    failureThreshold: 5,
    cooldownMs: 30_000,
    isFailure: isRetryableError,
  });
}

export function maxQueuedPipelines(): number {
  const raw = Number(Deno.env.get("GRADING_MAX_QUEUED_PIPELINES"));
  return Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : 24;
}

/** Pure: why grading should refuse new work right now, or null. */
export function gradingUnavailableReason(
  breakerState: "closed" | "open" | "half_open",
  queued: number,
  maxQueued = maxQueuedPipelines(),
  promptBlocked = false,
): GradingUnavailableReason | null {
  if (promptBlocked) return "prompt_unevaluated";
  if (breakerState === "open") return "ai_unavailable";
  if (queued >= maxQueued) return "queue_full";
  return null;
}

export function currentGradingUnavailableReason(): GradingUnavailableReason | null {
  return gradingUnavailableReason(
    anthropicBreaker().getState(),
    gradingQueueWaiting(),
    maxQueuedPipelines(),
    promptGateBlocked(),
  );
}

export const GRADING_BUSY_RETRY_AFTER_SECONDS = 60;

export function gradingUnavailableBody(
  reason: GradingUnavailableReason,
) {
  if (reason === "prompt_unevaluated") {
    return {
      error: "Grading is paused while we check a grading update. You were not charged. Try again later.",
      code: "GRADING_PAUSED",
    };
  }
  return {
    error: reason === "ai_unavailable"
      ? "Grading is paused for a moment because our AI provider is not responding. You were not charged. Try again in a minute."
      : "Grading is very busy right now. You were not charged. Try again in a minute.",
    code: reason === "ai_unavailable" ? "AI_UNAVAILABLE" : "GRADING_QUEUE_FULL",
  };
}
