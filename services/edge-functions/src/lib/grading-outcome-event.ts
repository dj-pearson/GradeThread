// US-3525: one analytics event per grade, success or failure.
//
// The pipeline logged total_ms to the console and sent PostHog events only for
// edge cases (era conflicts, escalations, injection). So nothing outside the
// container log could chart how long grades take, what they cost, how many go
// to a human, or how often they fail. This sends grading.completed or
// grading.failed with those numbers, keyed on the grading engine like every
// other grading event. Fire-and-forget: it never throws into the pipeline.

import { supabaseAdmin } from "./supabase.ts";
import { captureServer } from "./posthog.ts";

export interface GradingOutcome {
  outcome: "completed" | "failed";
  submissionId: string;
  durationMs: number;
  promptVersion?: string | null;
  overallScore?: number | null;
  confidenceScore?: number | null;
  needsHumanReview?: boolean | null;
  autoApproved?: boolean | null;
  garmentCategory?: string | null;
  error?: string | null;
}

export interface GradingOutcomeDeps {
  sumCostUsd: (submissionId: string) => Promise<number | null>;
  capture: (event: string, props: Record<string, unknown>) => Promise<void>;
}

export const defaultGradingOutcomeDeps: GradingOutcomeDeps = {
  sumCostUsd: async (submissionId) => {
    const { data, error } = await supabaseAdmin
      .from("ai_usage_events")
      .select("cost_usd")
      .eq("submission_id", submissionId);
    if (error) return null;
    return ((data ?? []) as Array<{ cost_usd: number | string | null }>)
      .reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
  },
  capture: (event, props) => captureServer("grading-engine", event, props),
};

/** The event name and properties. Pure, so the shape is testable. */
export function gradingOutcomeEvent(
  o: GradingOutcome,
  costUsd: number | null,
): { event: string; props: Record<string, unknown> } {
  return {
    event: o.outcome === "completed" ? "grading.completed" : "grading.failed",
    props: {
      submission_id: o.submissionId,
      duration_ms: Math.round(o.durationMs),
      cost_usd: costUsd === null ? null : Number(costUsd.toFixed(6)),
      prompt_version: o.promptVersion ?? null,
      overall_score: o.overallScore ?? null,
      confidence_score: o.confidenceScore ?? null,
      needs_human_review: o.needsHumanReview ?? null,
      auto_approved: o.autoApproved ?? null,
      garment_category: o.garmentCategory ?? null,
      // Truncated: an error string can carry a whole provider response.
      error: o.error ? o.error.slice(0, 300) : null,
    },
  };
}

export async function emitGradingOutcome(
  o: GradingOutcome,
  deps: GradingOutcomeDeps = defaultGradingOutcomeDeps,
): Promise<void> {
  try {
    const cost = await deps.sumCostUsd(o.submissionId).catch(() => null);
    const { event, props } = gradingOutcomeEvent(o, cost);
    await deps.capture(event, props);
  } catch {
    // Analytics must never fail a grade.
  }
}
