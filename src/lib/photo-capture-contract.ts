// US-2802: the multipart contract for LIVE PHOTO CAPTURE, written down in one
// place, for the same reason video-grading-contract.ts exists.
//
// WHY THIS FILE EXISTS, and it is not the usual tidiness argument. The server
// side of Live Capture has been complete since US-340: routes/grade.ts reads
// `live_capture_opt_in` and a per-image `capture_sources` array, validates that
// the two agree, and verified-capture.ts awards the `live_verified` badge that
// the pipeline calls the strongest provenance tier. None of it has ever run.
// No client on web, iOS or Android sent either field, so evaluateLiveCapture
// returned `['not opted into Live Capture']` for every submission ever made,
// and certificate.tsx has only ever rendered the not-earned branch.
//
// A handshake spelled inline in one page is fine with one client. This one had
// ZERO, which is worse: there was nothing to read and nothing to copy, so each
// of the three clients would have reverse-engineered the same four strings out
// of edge route code. The names live here, both ends are asserted against them
// by src/test/photo-capture-contract.test.ts, and the native clients get a spec
// instead of a scavenger hunt.
//
// ⚠ THESE ARE NOT THE VIDEO CONSTANTS. The walk-around clip tier (US-1762) has
// its own source vocabulary in video-capture.ts and its in-app value is
// `in_app_recorder`. The photo value is `in_app_camera`. They are different
// strings for different tiers and swapping them silently earns nothing, since
// each is compared against its own literal server-side.

/**
 * "Every photo in this submission was taken live, in the app." Sent as the
 * exact string "true"; grade.ts compares against that literal, so "1", "TRUE"
 * and other true-ish values do NOT opt in.
 */
export const LIVE_CAPTURE_OPT_IN_FIELD = "live_capture_opt_in";
export const LIVE_CAPTURE_OPT_IN = "true";

/**
 * Per-image provenance, appended once per photo IN IMAGE ORDER — parallel to
 * `images` / `image_types` / `phashes` / `quality_scores`, exactly like those.
 * A missing or empty entry reads as unknown, which fails the live check rather
 * than defaulting to a claim.
 */
export const CAPTURE_SOURCES_FIELD = "capture_sources";

/**
 * Where one photo came from.
 *
 * Mirrors IN_APP_CAPTURE_SOURCE in
 * services/edge-functions/src/lib/verified-capture.ts. The server lowercases
 * before comparing, but send the literal.
 */
export const IN_APP_CAPTURE_SOURCE = "in_app_camera";

/**
 * Chosen from the device's photo library / file picker. Honest and ordinary —
 * it simply earns no live-capture badge. There is no third value: anything the
 * app did not watch being taken is a library photo.
 */
export const LIBRARY_CAPTURE_SOURCE = "library";

export const PHOTO_CAPTURE_SOURCES = [
  IN_APP_CAPTURE_SOURCE,
  LIBRARY_CAPTURE_SOURCE,
] as const;

export type PhotoCaptureSource = (typeof PHOTO_CAPTURE_SOURCES)[number];

// NOTHING FOR VERIFIED 360 LIVES HERE YET, deliberately, and this note does
// not write its two field names down either.
//
// The 360 opt-in and its metrics blob were found unfed in the same sweep and
// are carried by the same story, so declaring them beside these looked
// obvious. It is a trap twice over. check-unfed-form-fields.mjs decides a
// field is fed by finding its bare name anywhere under src/ that is not a
// test — no quotes required — and its own header admits it cannot tell a
// name that is MENTIONED from one that is actually appended. So exporting
// those constants marks both fields fed and drops them out of the guard
// while nothing sends them; and so does prose that merely spells them, which
// is why this paragraph talks around them. Both mistakes were made here
// before this comment was written.
//
// A browser cannot measure the photogrammetric/LiDAR coverage that
// verified-360.ts scores, so web has nothing honest to declare. Add the
// constants in the commit that ships a client with the sensors, not before.
/**
 * Whether this submission may claim the live tier.
 *
 * DELIBERATELY NOT A CHECKBOX. The claim is "every one of these photos was
 * taken live in the app", which is a statement of fact about how the seller
 * shot them, not a preference they can hold. So it is DERIVED: it is true when
 * the seller has consented to the provenance path at all (Verified Capture,
 * which Live Capture builds on) and every photo actually came from the in-app
 * camera.
 *
 * Deriving it also means the client can never send the one combination
 * grade.ts rejects — opted in, with a library photo in the set — so the seller
 * cannot be shown a submit-time error for a box they were invited to tick.
 * An empty photo set is NOT live: `every` on an empty array is vacuously true,
 * and a submission with no photos claiming the strongest provenance tier is
 * exactly the vacuous pass this rule exists to refuse.
 */
export function qualifiesForLiveCapture(
  sources: readonly PhotoCaptureSource[],
  verifiedCaptureOptIn: boolean,
): boolean {
  if (!verifiedCaptureOptIn) return false;
  if (sources.length === 0) return false;
  return sources.every((s) => s === IN_APP_CAPTURE_SOURCE);
}
