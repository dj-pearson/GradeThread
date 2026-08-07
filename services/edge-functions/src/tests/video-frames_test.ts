// US-1764/US-1765: the PURE half of walk-around video grading — the part that
// decides what a clip costs and whether it can be graded at all.
//
// ffmpeg is not exercised here (it is one thin impure call). What IS exercised
// is everything a wrong answer would be expensive or invisible in: the frame
// cap (every frame is a paid Vision call), the required-slot bar (a clip that
// never showed the back must NOT grade), near-duplicate rejection (paying twice
// for one view), and the mark parsing (client-supplied, therefore untrusted).

import { assert, assertEquals } from "@std/assert";
import {
  clampFrameCount,
  DEFAULT_MAX_VIDEO_FRAMES,
  type FrameCandidate,
  hammingHex,
  HARD_MAX_VIDEO_FRAMES,
  laplacianVariance,
  lumaPlane,
  MAX_FRAME_EXTRACTIONS,
  meanLuma,
  MIN_VIDEO_FRAMES,
  parseVideoSlotMarks,
  planExtractionCount,
  planVideoFrames,
  REQUIRED_VIDEO_FRAME_SLOTS,
  selectVideoFrames,
  VIDEO_FRAME_SLOT_ORDER,
} from "../lib/video-frames.ts";
import {
  MIN_VIDEO_VERIFIED_FRAMES,
  VIDEO_FRAME_CAPTURE_SOURCE,
} from "../lib/verified-capture.ts";

// ── The invariant the badge floor rests on ───────────────────────────────────

// verified-capture.ts hard-codes MIN_VIDEO_VERIFIED_FRAMES because it must not
// import this module (it owns provenance and stays dependency-free). That is a
// deliberate duplication, so it gets a guard: a lower floor there would badge a
// clip that never actually showed all four required views.
Deno.test("video badge floor equals the required-slot count", () => {
  assertEquals(MIN_VIDEO_VERIFIED_FRAMES, REQUIRED_VIDEO_FRAME_SLOTS.length);
  assertEquals(MIN_VIDEO_FRAMES, REQUIRED_VIDEO_FRAME_SLOTS.length);
  // The required slots are the FIRST ones filled, so any cap >= MIN includes them.
  assertEquals(
    VIDEO_FRAME_SLOT_ORDER.slice(0, REQUIRED_VIDEO_FRAME_SLOTS.length),
    [...REQUIRED_VIDEO_FRAME_SLOTS],
  );
  assertEquals(VIDEO_FRAME_CAPTURE_SOURCE, "video_frame");
});

// ── Cost cap ─────────────────────────────────────────────────────────────────

Deno.test("clampFrameCount: an operator setting can never widen past the ceiling", () => {
  assertEquals(clampFrameCount(1), MIN_VIDEO_FRAMES);
  assertEquals(clampFrameCount(0), MIN_VIDEO_FRAMES);
  assertEquals(clampFrameCount(-50), MIN_VIDEO_FRAMES);
  assertEquals(clampFrameCount(999), HARD_MAX_VIDEO_FRAMES);
  assertEquals(clampFrameCount(6), 6);
  // Garbage falls back to the default rather than to "unbounded".
  assertEquals(clampFrameCount("nonsense"), DEFAULT_MAX_VIDEO_FRAMES);
  assertEquals(clampFrameCount(null), DEFAULT_MAX_VIDEO_FRAMES);
  assertEquals(clampFrameCount(undefined), DEFAULT_MAX_VIDEO_FRAMES);
});

Deno.test("planVideoFrames: caps slots and stays inside the extraction budget", () => {
  const plan = planVideoFrames({ durationSeconds: 30, maxFrames: 999 });
  assertEquals(plan.length, HARD_MAX_VIDEO_FRAMES);
  assert(planExtractionCount(plan) <= MAX_FRAME_EXTRACTIONS);
  for (const entry of plan) {
    for (const t of entry.candidateSeconds) {
      assert(t > 0 && t < 30, `candidate ${t} outside the clip`);
    }
  }
});

Deno.test("planVideoFrames: a zero/unknown duration plans nothing (never guesses)", () => {
  assertEquals(planVideoFrames({ durationSeconds: 0 }), []);
  assertEquals(planVideoFrames({ durationSeconds: -4 }), []);
  assertEquals(planVideoFrames({ durationSeconds: Number.NaN }), []);
});

Deno.test("planVideoFrames: guided marks win, unmarked slots sample evenly", () => {
  const plan = planVideoFrames({
    durationSeconds: 20,
    maxFrames: 4,
    marks: { front: 2, label: 11 },
  });
  assertEquals(plan.map((p) => p.slot), ["front", "back", "label", "detail"]);
  assertEquals(plan[0]!.atSeconds, 2);
  assertEquals(plan[2]!.atSeconds, 11);
  // 'back' and 'detail' were unmarked → the even-sampling fallback, in order.
  assert(plan[1]!.atSeconds > plan[0]!.atSeconds);
  assert(plan[3]!.atSeconds > plan[2]!.atSeconds);
  // Every planned point centres a burst that includes the point itself.
  for (const entry of plan) {
    assert(entry.candidateSeconds.includes(Number(entry.atSeconds.toFixed(3))));
  }
});

Deno.test("planVideoFrames: a very short clip still produces a bounded plan", () => {
  const plan = planVideoFrames({ durationSeconds: 0.5, maxFrames: 4 });
  assertEquals(plan.length, 4);
  assert(planExtractionCount(plan) <= MAX_FRAME_EXTRACTIONS);
  for (const entry of plan) {
    assert(entry.candidateSeconds.length >= 1);
    for (const t of entry.candidateSeconds) assert(t >= 0 && t <= 0.5);
  }
});

// ── Untrusted client marks ───────────────────────────────────────────────────

Deno.test("parseVideoSlotMarks: drops unknown slots, bad numbers and out-of-range times", () => {
  const marks = parseVideoSlotMarks(
    JSON.stringify({
      front: 1.5,
      back: "not a number",
      label: -3,
      detail: 99,          // past the end of the clip
      hero_shot: 2,        // not a slot
      defect: 4,
    }),
    10,
  );
  assertEquals(marks, { front: 1.5, defect: 4 });
});

Deno.test("parseVideoSlotMarks: malformed input is {} rather than a throw", () => {
  assertEquals(parseVideoSlotMarks("{not json", 10), {});
  assertEquals(parseVideoSlotMarks(null, 10), {});
  assertEquals(parseVideoSlotMarks("[1,2,3]", 10), {});
  assertEquals(parseVideoSlotMarks(42, 10), {});
  // No known duration → the range check is skipped, not failed closed.
  assertEquals(parseVideoSlotMarks({ front: 900 }, null), { front: 900 });
});

// ── Quality signals ──────────────────────────────────────────────────────────

Deno.test("meanLuma / laplacianVariance: black is dark and flat, noise is sharp", () => {
  const w = 8, h = 8;
  const black = new Uint8Array(w * h * 4);
  assertEquals(Math.round(meanLuma(black, w, h)), 0);
  assertEquals(laplacianVariance(lumaPlane(black, w, h), w, h), 0);

  // A hard checkerboard is the sharpest thing at this resolution.
  const checker = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = ((i % w) + Math.floor(i / w)) % 2 === 0 ? 255 : 0;
    checker[i * 4] = v;
    checker[i * 4 + 1] = v;
    checker[i * 4 + 2] = v;
    checker[i * 4 + 3] = 255;
  }
  assert(laplacianVariance(lumaPlane(checker, w, h), w, h) > 1000);
  // A degenerate buffer scores zero rather than throwing.
  assertEquals(meanLuma(new Uint8Array(3), 8, 8), 0);
  assertEquals(laplacianVariance(new Uint8Array(4), 8, 8), 0);
});

Deno.test("hammingHex: distance, and null on anything unusable", () => {
  assertEquals(hammingHex("0000000000000000", "0000000000000000"), 0);
  assertEquals(hammingHex("0000000000000000", "0000000000000001"), 1);
  assertEquals(hammingHex("0000000000000000", "000000000000000f"), 4);
  assertEquals(hammingHex(null, "0000000000000000"), null);
  assertEquals(hammingHex("abc", "0000000000000000"), null);
  assertEquals(hammingHex("zzzzzzzzzzzzzzzz", "0000000000000000"), null);
});

// ── Selection ────────────────────────────────────────────────────────────────

function candidate(
  slot: string,
  at: number,
  over: Partial<FrameCandidate> = {},
): FrameCandidate {
  return {
    slot: slot as FrameCandidate["slot"],
    atSeconds: at,
    bytes: new Uint8Array([1, 2, 3]),
    sharpness: 100,
    luma: 128,
    phash: null,
    ...over,
  };
}

const FOUR_SLOT_PLAN = planVideoFrames({ durationSeconds: 20, maxFrames: 4 });

Deno.test("selectVideoFrames: keeps the sharpest candidate per slot", () => {
  const candidates = FOUR_SLOT_PLAN.flatMap((entry) => [
    candidate(entry.slot, entry.atSeconds - 0.3, { sharpness: 20 }),
    candidate(entry.slot, entry.atSeconds, { sharpness: 300 }),
    candidate(entry.slot, entry.atSeconds + 0.3, { sharpness: 50 }),
  ]);
  const result = selectVideoFrames(FOUR_SLOT_PLAN, candidates);
  assert(result.ok, result.reason);
  assertEquals(result.frames.length, 4);
  for (const f of result.frames) assertEquals(f.sharpness, 300);
});

Deno.test("selectVideoFrames: dark / blown-out / blurred candidates are refused", () => {
  const candidates = FOUR_SLOT_PLAN.flatMap((entry) => [
    candidate(entry.slot, entry.atSeconds, { luma: 2, sharpness: 500 }),
    candidate(entry.slot, entry.atSeconds + 0.1, { luma: 254, sharpness: 500 }),
    candidate(entry.slot, entry.atSeconds + 0.2, { luma: 120, sharpness: 1 }),
  ]);
  const result = selectVideoFrames(FOUR_SLOT_PLAN, candidates);
  assert(!result.ok);
  assertEquals(result.frames.length, 0);
  assertEquals(result.dropped.length, 4);
  // The message must name what the seller has to change.
  assert(result.reason.includes("front"));
  assert(result.reason.includes("walk-around"));
});

Deno.test("selectVideoFrames: a missing REQUIRED view is not gradeable", () => {
  const candidates = FOUR_SLOT_PLAN
    .filter((e) => e.slot !== "back")
    .map((e) => candidate(e.slot, e.atSeconds));
  const result = selectVideoFrames(FOUR_SLOT_PLAN, candidates);
  assert(!result.ok);
  assert(result.reason.includes("back"));
  assertEquals(result.dropped.some((d) => d.slot === "back"), true);
});

Deno.test("selectVideoFrames: an OPTIONAL near-duplicate slot is dropped, not paid for", () => {
  // Six slots planned; detail_2 sees the exact same view as detail. Grading it
  // would be a second Vision call for evidence already in hand.
  const plan = planVideoFrames({ durationSeconds: 30, maxFrames: 6 });
  const shared = "ffffffffffffffff";
  const candidates = plan.map((e) =>
    candidate(e.slot, e.atSeconds, {
      phash: e.slot === "detail" || e.slot === "detail_2" ? shared : "0000000000000000",
    })
  );
  const result = selectVideoFrames(plan, candidates);
  assert(result.ok, result.reason);
  const slots = result.frames.map((f) => f.slot);
  assert(slots.includes("detail"));
  assert(!slots.includes("detail_2"));
  assertEquals(
    result.dropped.find((d) => d.slot === "detail_2")?.reason,
    "duplicate of a frame already selected",
  );
});

Deno.test("selectVideoFrames: a REQUIRED view is never dropped for looking alike", () => {
  // Front and back of a plain black tee legitimately hash the same. Refusing to
  // grade that would be wrong, so duplication only ever drops optional slots.
  const same = "abcdef0123456789";
  const candidates = FOUR_SLOT_PLAN.map((e) =>
    candidate(e.slot, e.atSeconds, { phash: same })
  );
  const result = selectVideoFrames(FOUR_SLOT_PLAN, candidates);
  assert(result.ok, result.reason);
  assertEquals(result.frames.length, 4);
  assertEquals(result.dropped.length, 0);
});
