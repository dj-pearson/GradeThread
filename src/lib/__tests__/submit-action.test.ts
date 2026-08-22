import { describe, it, expect } from "vitest";
import { decideSubmitAction, type SubmitState } from "@/lib/submit-action";

// US-2538 / US-774, tested by CALLING the decision.
//
// What existed was src/test/submission-no-double-charge.test.ts, which compares
// STRING INDEXES inside new-submission.tsx — asserting that
// `if (repricingSubmissionId)` appears earlier in the file than
// `new FormData()`. That pins the branch's POSITION. It cannot say what the
// branch decides, and it stays green through any reordering that keeps those
// two strings in the same sequence.
//
// It matters here more than most places because the failure is money: a second
// /submit for a garment that already has an unpaid submission row is a second
// charge for one garment.
//
// The scan STAYS. It holds a real property this cannot see — that the branch is
// ahead of the multipart build, so no second body is assembled even briefly.
// This holds the decision. Two instruments, two properties.

function state(over: Partial<SubmitState> = {}): SubmitState {
  return {
    repricingSubmissionId: null,
    hasGarmentInfo: true,
    captureMode: "photo",
    hasVideo: false,
    photoCount: 4,
    locked: false,
    ...over,
  };
}

describe("the Submit decision (US-2538)", () => {
  it("a normal photo submission submits", () => {
    expect(decideSubmitAction(state())).toBe("submit");
  });

  it("a video submission submits on the video, not the photo count", () => {
    expect(
      decideSubmitAction(state({ captureMode: "video", hasVideo: true, photoCount: 0 })),
    ).toBe("submit");
  });

  it("an unpaid submission RE-PRICES rather than submitting again", () => {
    // The whole story. A second /submit here is a second row and a second
    // charge for one garment.
    expect(decideSubmitAction(state({ repricingSubmissionId: "sub_1" }))).toBe("reprice");
  });
});

describe("reprice wins over every other gate, and each for its own reason", () => {
  it("beats the empty-photo check", () => {
    // THE ORDERING BUG THIS PREVENTS. The row already exists, so its media is
    // already uploaded and the component may no longer hold the photos.
    // Checking photoCount first would refuse to re-price — silently, since the
    // gate just returns — and the seller's only escape from a dead button is to
    // start again, which creates the second row.
    expect(
      decideSubmitAction({ ...state({ repricingSubmissionId: "sub_1" }), photoCount: 0 }),
    ).toBe("reprice");
  });

  it("beats the empty-video check", () => {
    expect(
      decideSubmitAction(state({
        repricingSubmissionId: "sub_1",
        captureMode: "video",
        hasVideo: false,
        photoCount: 0,
      })),
    ).toBe("reprice");
  });

  it("beats the re-entrancy lock", () => {
    // The lock guards the UPLOAD path against a double-click. Re-pricing does
    // not upload, and letting a stale lock block it strands the seller on an
    // unpaid submission.
    expect(
      decideSubmitAction(state({ repricingSubmissionId: "sub_1", locked: true })),
    ).toBe("reprice");
  });

  it("but NOT the missing-garment check", () => {
    // The one gate that must stay ahead of it: with no garment info there is
    // nothing to re-price toward, and every field the reprice reads is absent.
    expect(
      decideSubmitAction(state({ repricingSubmissionId: "sub_1", hasGarmentInfo: false })),
    ).toBe("ignore");
  });
});

describe("the gates that refuse (US-774)", () => {
  it("no garment info does nothing", () => {
    expect(decideSubmitAction(state({ hasGarmentInfo: false }))).toBe("ignore");
  });

  it("no photos does nothing", () => {
    expect(decideSubmitAction(state({ photoCount: 0 }))).toBe("ignore");
  });

  it("video mode with no video does nothing, even with photos attached", () => {
    // Mode decides which medium counts. Falling back to the photos would
    // submit a photo grade to someone who chose video.
    expect(
      decideSubmitAction(state({ captureMode: "video", hasVideo: false, photoCount: 8 })),
    ).toBe("ignore");
  });

  it("a held lock does nothing", () => {
    expect(decideSubmitAction(state({ locked: true }))).toBe("ignore");
  });

  it("an empty submission id is not a repricing id", () => {
    // "" is falsy and must read as "no submission waiting" rather than as a
    // repricing target the reprice call would then send to /api/grade/pay//.
    expect(decideSubmitAction(state({ repricingSubmissionId: "" }))).toBe("submit");
  });
});
