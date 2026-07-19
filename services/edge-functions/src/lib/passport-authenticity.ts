// US-2142: append the authenticity verdict to the garment passport ledger.
//
// The passport is append-only by RLS (no update/delete policy) — a later
// assessment supersedes an earlier one by being a NEWER row, never by rewriting
// it. That property is why writing a verdict here is safe even though the
// authenticity pass has not yet cleared its eval gate (US-2130): every entry
// carries the prompt version and whether the gate was satisfied at write time,
// so entries produced by an unvalidated pass stay identifiable forever rather
// than blending into the record.
//
// Only the COARSE verdict is written. Red flags and per-tell findings stay
// operator-side, matching what the public certificate view projects — the
// passport is buyer-visible, so it must not become the leak the certificate
// view was careful to avoid.

import { supabaseAdmin } from "./supabase.ts";
import type { AuthenticityAssessment } from "./ai-authenticity.ts";

export interface AuthenticityEventPayload {
  verdict: string;
  verdict_confidence: number;
  brand_assessed: string | null;
  prompt_version: string;
  /** Whether the producing prompt version had a passing eval run at write time. */
  gated: boolean;
}

/**
 * Build the event payload from an assessment. Pure + exported for tests.
 *
 * Returns null when there is nothing worth recording — the add-on did not run,
 * or no brand was recognizable so the pass could not authenticate anything. An
 * "inconclusive because there was no brand" row would be noise in a ledger meant
 * to carry findings.
 */
export function buildAuthenticityEventPayload(
  assessment: AuthenticityAssessment | null,
  gated: boolean,
): AuthenticityEventPayload | null {
  if (!assessment || !assessment.assessed) return null;
  if (!assessment.brand_assessed) return null;
  return {
    verdict: assessment.verdict,
    verdict_confidence: assessment.verdict_confidence,
    brand_assessed: assessment.brand_assessed,
    prompt_version: assessment.prompt_version,
    gated,
  };
}

/**
 * Append an 'authenticity_assessed' event. Best-effort: a passport write must
 * never fail a paid grade, which is the same contract the rest of the passport
 * writers follow.
 *
 * `confidence` is the LEDGER's confidence vocabulary (how reliable the event
 * record is), not the model's — a photo-only assessment is 'probable' at best,
 * and deliberately never 'deterministic' the way a sale or a transfer is.
 */
export async function appendAuthenticityEvent(
  garmentId: string,
  assessment: AuthenticityAssessment | null,
  gated: boolean,
): Promise<void> {
  const payload = buildAuthenticityEventPayload(assessment, gated);
  if (!payload) return;
  try {
    const { data: garment } = await supabaseAdmin
      .from("garments")
      .select("current_owner_node_id")
      .eq("id", garmentId)
      .maybeSingle();
    const actorNodeId =
      (garment as { current_owner_node_id: string | null } | null)?.current_owner_node_id ?? null;

    await supabaseAdmin.from("garment_events").insert({
      garment_id: garmentId,
      event_type: "authenticity_assessed",
      actor_node_id: actorNodeId,
      payload,
      confidence: "probable",
      source: `authenticity:${payload.prompt_version}`.slice(0, 200),
    });
  } catch (e) {
    console.error(
      "[passport-authenticity] appendAuthenticityEvent failed:",
      e instanceof Error ? e.message : e,
    );
  }
}
