// US-1844: buyer-facing trust signals — the SINGLE public projection of the
// verified/trust cues (Verified Capture US-340, Live-Verified US-1283,
// 360-Verified US-1281, Original-Photos US-861, plus verified-seller US-1761
// and cert-integrity US-1109) that buyer surfaces render.
//
// It is the same positive-only projection the public certificate page uses
// (content-public.ts) — reused here so the extension overlay, alerts,
// watchlist, and portfolio show EXACTLY the coarse labels a public cert shows,
// and never an internal signal. Pure: no DB, no I/O — unit-testable in
// isolation. The raw downgrade reasons / device metrics / reuse-scan counts
// stay server-side; only the earned booleans cross this boundary.

/** The raw grade_report columns these signals are derived from. */
export interface TrustSignalSource {
  verified_capture?: { verified?: boolean } | null;
  original_photos?: { verified?: boolean } | null;
  live_capture?: { badge?: string } | null;
  verified_360?: { badge?: string } | null;
}

/** Signals that don't live on the grade_report row (resolved by the caller). */
export interface TrustSignalContext {
  /** The grading seller runs a public GradeThread Verified profile (US-1761). */
  verifiedSeller?: boolean;
  /** The certificate's content signature verified (US-1109 integrity). */
  certIntegrityOk?: boolean;
}

/** The coarse, positive-only trust signals safe to show any buyer. */
export interface TrustSignals {
  verifiedCapture: boolean;
  liveCaptureVerified: boolean;
  verified360: boolean;
  originalPhotos: boolean;
  verifiedSeller: boolean;
  certIntegrityOk: boolean;
}

/**
 * Project a grade_report row (+ optional off-row context) to the coarse public
 * trust-signal set. Mirrors the content-public.ts cert projection byte-for-byte
 * so the buyer surfaces and the public cert page can never diverge.
 */
export function projectTrustSignals(
  rep: TrustSignalSource | null | undefined,
  ctx: TrustSignalContext = {},
): TrustSignals {
  return {
    verifiedCapture: rep?.verified_capture?.verified === true,
    liveCaptureVerified: rep?.live_capture?.badge === "live_verified",
    verified360: rep?.verified_360?.badge === "verified_360",
    originalPhotos: rep?.original_photos?.verified === true,
    verifiedSeller: ctx.verifiedSeller === true,
    certIntegrityOk: ctx.certIntegrityOk === true,
  };
}

/** A renderable trust badge: a stable key + the buyer-facing label. */
export interface TrustBadge {
  key: keyof TrustSignals;
  label: string;
}

// Ordered strongest → supporting, so a surface that shows only the top N picks
// the most meaningful cues first.
const BADGE_LABELS: Array<{ key: keyof TrustSignals; label: string }> = [
  { key: "verified360", label: "360-Verified" },
  { key: "liveCaptureVerified", label: "Live-Verified" },
  { key: "verifiedCapture", label: "Verified Capture" },
  { key: "certIntegrityOk", label: "Integrity Verified" },
  { key: "verifiedSeller", label: "Verified Seller" },
  { key: "originalPhotos", label: "Original Photos" },
];

/** The earned badges, strongest first — empty when nothing is verified. */
export function trustSignalBadges(sig: TrustSignals): TrustBadge[] {
  return BADGE_LABELS.filter((b) => sig[b.key] === true);
}

/** True iff the item carries any buyer-visible trust signal at all. */
export function hasAnyTrustSignal(sig: TrustSignals): boolean {
  return trustSignalBadges(sig).length > 0;
}
