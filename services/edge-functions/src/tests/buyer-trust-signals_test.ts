// US-1844: the pure buyer trust-signal projection. Byte-for-byte the coarse,
// positive-only cues the public cert page shows — proven to expose ONLY earned
// booleans (never an internal reason/metric) and to order badges strongest-first.
import { assert, assertEquals } from "@std/assert";
import {
  hasAnyTrustSignal,
  projectTrustSignals,
  trustSignalBadges,
} from "../lib/buyer-trust-signals.ts";

Deno.test("projectTrustSignals: earned booleans only, on the exact source shapes", () => {
  const sig = projectTrustSignals(
    {
      verified_capture: { verified: true },
      original_photos: { verified: true },
      live_capture: { badge: "live_verified" },
      verified_360: { badge: "verified_360" },
      video_capture: { badge: "video_verified", live_captured: true },
    },
    { verifiedSeller: true, certIntegrityOk: true },
  );
  assertEquals(sig, {
    verifiedCapture: true,
    liveCaptureVerified: true,
    verified360: true,
    videoCaptureVerified: true,
    videoLiveCaptureVerified: true,
    originalPhotos: true,
    verifiedSeller: true,
    certIntegrityOk: true,
  });
});

// US-1762: the video badge is the newest member of this projection, so it gets
// the same NON-badge-tier proof the others have — a shipped-but-unchecked
// projection is how a "verified" boolean ends up true for a tier that never
// earned it.
Deno.test("projectTrustSignals: a non-'video_verified' video tier is not a badge", () => {
  const sig = projectTrustSignals({ video_capture: { badge: "attempted" } });
  assertEquals(sig.videoCaptureVerified, false);
  assertEquals(hasAnyTrustSignal(sig), false);
  const earned = projectTrustSignals({ video_capture: { badge: "video_verified" } });
  assertEquals(earned.videoCaptureVerified, true);
  assertEquals(trustSignalBadges(earned).map((b) => b.label), ["Video-Verified"]);
});

// US-1766: the live reading is a stronger telling of the SAME badge.
Deno.test("projectTrustSignals: live_captured upgrades the label, never adds a badge", () => {
  const live = projectTrustSignals({
    video_capture: { badge: "video_verified", live_captured: true },
  });
  assertEquals(live.videoCaptureVerified, true);
  assertEquals(live.videoLiveCaptureVerified, true);
  // ONE badge, with the fuller label — two "video" rows would read to a buyer
  // as two independent checks.
  assertEquals(trustSignalBadges(live).map((b) => b.label), ["Video-Verified (live)"]);

  // live_captured without the badge (a shape the evaluator never writes) must
  // not smuggle the stronger claim through this projection.
  const unearned = projectTrustSignals({
    video_capture: { badge: "attempted", live_captured: true },
  });
  assertEquals(unearned.videoLiveCaptureVerified, false);
  assertEquals(trustSignalBadges(unearned), []);
});

Deno.test("projectTrustSignals: a NON-badge tier never counts as verified", () => {
  // Live-Capture that only earned a weaker tier, and a 360 with no badge, must
  // NOT surface — positive-only means the STRONGEST earned badge, nothing less.
  const sig = projectTrustSignals({
    live_capture: { badge: "recorded" },
    verified_360: { badge: "partial" },
    video_capture: { badge: "partial" },
    verified_capture: { verified: false },
  });
  assertEquals(sig.liveCaptureVerified, false);
  assertEquals(sig.verified360, false);
  assertEquals(sig.verifiedCapture, false);
});

Deno.test("projectTrustSignals: null/absent report → all false, no throw", () => {
  const sig = projectTrustSignals(null);
  assertEquals(hasAnyTrustSignal(sig), false);
  assertEquals(trustSignalBadges(sig), []);
  const sig2 = projectTrustSignals(undefined, {});
  assertEquals(hasAnyTrustSignal(sig2), false);
});

Deno.test("projectTrustSignals: off-row context defaults to false when omitted", () => {
  const sig = projectTrustSignals({ verified_capture: { verified: true } });
  assertEquals(sig.verifiedCapture, true);
  assertEquals(sig.verifiedSeller, false);
  assertEquals(sig.certIntegrityOk, false);
});

Deno.test("trustSignalBadges: strongest-first ordering + human labels", () => {
  const sig = projectTrustSignals(
    {
      verified_capture: { verified: true },
      original_photos: { verified: true },
      verified_360: { badge: "verified_360" },
    },
    { verifiedSeller: true, certIntegrityOk: true },
  );
  const badges = trustSignalBadges(sig);
  // 360 (strongest) first; Original Photos (supporting) last.
  assertEquals(badges[0]?.key, "verified360");
  assertEquals(badges[0]?.label, "360-Verified");
  assertEquals(badges.at(-1)?.key, "originalPhotos");
  // Live-Verified was NOT earned here, so it isn't in the list.
  assert(!badges.some((b) => b.key === "liveCaptureVerified"));
  assert(hasAnyTrustSignal(sig));
});
