// US-1765: the video-grading cost decisions — frame cap, ledger feature, plan
// gate, and the photo/frame conflict that made the two caps compose.
//
// Every assertion here is about MONEY, not behaviour: how many Vision calls one
// grade may buy, and whether that spend lands where the budget and the admin
// dashboards can see it.

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  clampFrameCount,
  HARD_MAX_VIDEO_FRAMES,
  MIN_VIDEO_FRAMES,
} from "../lib/video-frames.ts";
import {
  DEFAULT_VIDEO_GRADING_PLANS,
  gradingUsageFeature,
  PHOTO_GRADING_FEATURE,
  resolveVideoGradingAccess,
  resolveVideoGradingPlans,
  VIDEO_GRADE_BUYER_METER,
  VIDEO_GRADING_FEATURE,
  videoGradingPlanAllowed,
  videoPhotoConflict,
} from "../lib/video-grading-cost.ts";

// buyer-metering.ts reaches lib/supabase.ts, which throws at import time without
// these. Set them (never clobbering a real value) BEFORE the dynamic import — a
// static top-of-file import would run first and crash this file when it is run
// on its own, which is how a new edge test file gets smoke-tested.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "https://example.test");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "dummy",
);
const { BUYER_METER_ALLOWANCE } = await import("../lib/buyer-metering.ts");

Deno.test("the ledger feature for a video grade is its own, not 'grading'", () => {
  assertEquals(gradingUsageFeature(true), "video_grading");
  assertEquals(gradingUsageFeature(false), "grading");
  // The two must never collapse: the whole point of the split is that video
  // spend can be weighed on its own against what a video grade earns.
  assertNotEquals(VIDEO_GRADING_FEATURE, PHOTO_GRADING_FEATURE);
});

Deno.test("the ledger feature keys off frames landing, not the seller's opt-in", () => {
  // A request that ASKED for video but fell back to photos is a photo grade.
  // Metering it as video would overstate the clip path's cost per grade — the
  // exact number the ai_budgets ceiling and the profitability report use.
  assertEquals(gradingUsageFeature(false), PHOTO_GRADING_FEATURE);
});

Deno.test("the metered feature is the SAME string the budget and dashboards key on", () => {
  // A typo in any one of these fails silently: spend lands under a feature the
  // ai_budgets row (00532), the kill-switch flag and the admin AI-spend /
  // profitability breakout are not watching, so nothing ever alerts.
  assertEquals(VIDEO_GRADING_FEATURE, "video_grading");
  assertEquals(gradingUsageFeature(true), VIDEO_GRADING_FEATURE);
});

Deno.test("frame cap: an operator setting can never exceed the paid ceiling", () => {
  assertEquals(clampFrameCount(99), HARD_MAX_VIDEO_FRAMES);
  assertEquals(clampFrameCount(0), MIN_VIDEO_FRAMES);
  assertEquals(clampFrameCount(-5), MIN_VIDEO_FRAMES);
  // Each frame is a full Vision call against one grade's revenue, so the cap
  // being a hard code clamp (not just a settings default) is the control.
  assertEquals(clampFrameCount(HARD_MAX_VIDEO_FRAMES + 1), HARD_MAX_VIDEO_FRAMES);
});

Deno.test("plan gate: paid plans only by default, free is refused", () => {
  for (const plan of DEFAULT_VIDEO_GRADING_PLANS) {
    assertEquals(videoGradingPlanAllowed(plan, null), true);
  }
  assertEquals(videoGradingPlanAllowed("free", null), false);
});

Deno.test("plan gate: an operator can widen or narrow the allowlist", () => {
  assertEquals(videoGradingPlanAllowed("free", ["free", "pro"]), true);
  assertEquals(videoGradingPlanAllowed("starter", ["business"]), false);
});

Deno.test("plan gate: malformed settings fall back, never to an empty allowlist", () => {
  // An empty allowlist would disable the feature for EVERYONE. That is the
  // kill-switch's job (feature_flags.video_grading), and it must not be
  // reachable by fat-fingering a settings row — an operator who meant to add a
  // plan should not accidentally take the feature away from the ones that had it.
  assertEquals(resolveVideoGradingPlans([]), DEFAULT_VIDEO_GRADING_PLANS);
  assertEquals(resolveVideoGradingPlans(null), DEFAULT_VIDEO_GRADING_PLANS);
  assertEquals(resolveVideoGradingPlans("pro"), DEFAULT_VIDEO_GRADING_PLANS);
  assertEquals(resolveVideoGradingPlans([1, 2, 3]), DEFAULT_VIDEO_GRADING_PLANS);
  assertEquals(resolveVideoGradingPlans(["  ", ""]), DEFAULT_VIDEO_GRADING_PLANS);
  // A partly-junk array keeps the usable entries rather than discarding them.
  assertEquals(resolveVideoGradingPlans(["pro", 7, null]), ["pro"]);
});

Deno.test("a video grade may not also carry staged photos", () => {
  // Frames are inserted as ordinary submission_images alongside anything
  // uploaded, and the pipeline makes one Vision call per image. Accepting both
  // stacks the photo cap on top of the frame cap for a SINGLE grade's revenue,
  // so neither cap bounds the request.
  assertNotEquals(videoPhotoConflict(1), null);
  assertNotEquals(videoPhotoConflict(14), null);
  // Photo-only and clip-only submissions are both fine.
  assertEquals(videoPhotoConflict(0), null);
});

Deno.test("the conflict message tells the seller which way out to take", () => {
  const msg = videoPhotoConflict(3) ?? "";
  // A refusal that doesn't name the alternative reads as a bug to the seller,
  // who then re-records the clip instead of switching to the path that works.
  assertEquals(msg.includes("photo mode"), true);
});

// ── US-1841: who pays for a clip grade ───────────────────────────────────────

Deno.test("a paid seller plan pays for the clip; the buyer credit is untouched", () => {
  // The ordering rule this function exists for. A Business seller who ALSO holds
  // Connoisseur would otherwise be charged twice for one grade — once out of the
  // FlipDesk bundle that already covers it, once out of an allowance they never
  // needed. Both-entitled must resolve to the seller.
  assertEquals(
    resolveVideoGradingAccess({ sellerPlanAllowed: true, buyerEntitled: true }),
    { allowed: true, payer: "seller" },
  );
  assertEquals(
    resolveVideoGradingAccess({ sellerPlanAllowed: true, buyerEntitled: false }),
    { allowed: true, payer: "seller" },
  );
});

Deno.test("a buyer entitlement is the second way in when the seller plan can't pay", () => {
  // The gap US-1841 closes: both paid buyer tiers advertise video-grade credits,
  // and before this a Guard buyer on a free FlipDesk plan was answered with
  // UPGRADE_REQUIRED for a feature their plan had already sold them.
  assertEquals(
    resolveVideoGradingAccess({ sellerPlanAllowed: false, buyerEntitled: true }),
    { allowed: true, payer: "buyer" },
  );
});

Deno.test("neither entitlement means no payer at all — never a free clip grade", () => {
  const access = resolveVideoGradingAccess({ sellerPlanAllowed: false, buyerEntitled: false });
  assertEquals(access, { allowed: false, payer: null });
  // `payer` must be null and not a default, or a caller reading it without
  // checking `allowed` would silently charge the wrong pocket.
  assertEquals(access.payer, null);
});

Deno.test("the buyer meter key is a real meter mapped to the advertised allowance", () => {
  // A typo here is silent in both directions: nothing is debited, and the SQL
  // refund branch (00536) hands a unit back to a meter nobody spends.
  assertEquals(VIDEO_GRADE_BUYER_METER, "video_grades");
  assertEquals(
    BUYER_METER_ALLOWANCE[VIDEO_GRADE_BUYER_METER],
    "videoGradeCreditsPerMonth",
  );
});
