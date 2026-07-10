// US-1836: point-of-purchase fraud flags — COARSE, buyer-safe labels only.
//
// PURE (unit-tested). Turns the grader's internal authenticity signal into a
// short list of risk-FRAMED labels ("possible …", never an accusation) for the
// extension. Only booleans + a coarse confidence enter here — the internal
// `tells` / `flagged_image_types` never do. Legal posture: the endpoint that
// surfaces these is FAIL-CLOSED behind a kill-switch until the copy is
// legal-reviewed (mirrors PUBLIC_AUTHENTICITY_CHECK_ENABLED).

export interface CoarseAuthenticity {
  manipulation_suspected: boolean;
  manipulation_confidence: number; // 0.0–1.0
  screenshot_or_watermark_detected: boolean;
}

export type FraudFlagCode = "possible_edited_photos" | "possible_reused_photos";

export interface FraudFlag {
  code: FraudFlagCode;
  /** Risk-framed, buyer-safe copy — an estimate/signal, never an accusation. */
  label: string;
  severity: "info" | "warn";
}

// Only flag manipulation at meaningful confidence — a faint suspicion isn't a
// buyer-facing risk signal (and over-flagging is legally worse than under).
const MANIPULATION_MIN_CONFIDENCE = 0.6;

/**
 * Derive the coarse fraud flags a buyer should see. PURE. Returns [] when the
 * signal is clean or absent — no flag means "nothing suspicious detected", never
 * a guarantee of authenticity (the disclaimer carries that).
 */
export function deriveFraudFlags(auth: CoarseAuthenticity | null | undefined): FraudFlag[] {
  const flags: FraudFlag[] = [];
  if (!auth) return flags;

  if (auth.manipulation_suspected && auth.manipulation_confidence >= MANIPULATION_MIN_CONFIDENCE) {
    flags.push({
      code: "possible_edited_photos",
      label: "These photos show possible signs of digital editing — inspect closely and ask for more.",
      severity: "warn",
    });
  }
  if (auth.screenshot_or_watermark_detected) {
    flags.push({
      code: "possible_reused_photos",
      label: "These may be screenshots or reused/stock photos rather than the actual item — ask for fresh photos.",
      severity: "warn",
    });
  }
  return flags;
}
