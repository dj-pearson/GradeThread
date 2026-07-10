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
    },
    { verifiedSeller: true, certIntegrityOk: true },
  );
  assertEquals(sig, {
    verifiedCapture: true,
    liveCaptureVerified: true,
    verified360: true,
    originalPhotos: true,
    verifiedSeller: true,
    certIntegrityOk: true,
  });
});

Deno.test("projectTrustSignals: a NON-badge tier never counts as verified", () => {
  // Live-Capture that only earned a weaker tier, and a 360 with no badge, must
  // NOT surface — positive-only means the STRONGEST earned badge, nothing less.
  const sig = projectTrustSignals({
    live_capture: { badge: "recorded" },
    verified_360: { badge: "partial" },
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
