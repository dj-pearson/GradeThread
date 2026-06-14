// US-894: per-call AI feature attribution.
//
// Every non-streaming Anthropic call already funnels through the limiter wrapper
// in ai-config.ts (applyAiLimiter → runAiCall). That wrapper now also records
// the call's model / tokens / latency / cost to the ai_usage_events ledger —
// but it can only attribute the spend to a FEATURE if the feature is in scope.
//
// Rather than thread a `feature` argument through every lib + call site, a
// feature tags the CURRENT async operation once (at the top of its entry
// function) via enterAiFeature(); AsyncLocalStorage then carries it down through
// every awaited Anthropic call the operation makes. The capture is OPT-IN: with
// no feature set the wrapper records nothing, so the grading pipeline (which
// logs its own per-grade rows via lib/ai-usage.ts) is never double-counted.

import { AsyncLocalStorage } from "node:async_hooks";

export interface AiFeatureContext {
  /** Stable feature slug, e.g. "autolister" | "content" | "reconcile". */
  feature: string;
  /** Owning user when known; null for unattended/system flows. */
  userId: string | null;
}

const storage = new AsyncLocalStorage<AiFeatureContext>();

// Tag the current async context (and everything it awaits) with the AI feature
// making the calls. One-liner for an entry function: `enterAiFeature("content")`.
export function enterAiFeature(
  feature: string,
  userId: string | null = null,
): void {
  storage.enterWith({ feature, userId });
}

// Run `fn` with the feature context set — use when you have a clean callback
// boundary; enterAiFeature is the in-place alternative.
export function withAiFeature<T>(
  ctx: AiFeatureContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn);
}

// The feature context active for the current async call, or undefined.
export function currentAiFeature(): AiFeatureContext | undefined {
  return storage.getStore();
}
