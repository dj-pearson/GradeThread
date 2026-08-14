import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  VIDEO_CAPTURE_SOURCES,
  VIDEO_CAPTURE_SOURCE_FIELD,
  VIDEO_FIELD,
  VIDEO_GRADING_FIELD,
  VIDEO_GRADING_OPT_IN,
  VIDEO_SLOT_MARKS_FIELD,
  VIDEO_SUBMIT_FIELDS,
  VIDEO_ABSTAIN_STATUS,
  isVideoAbstain,
} from "@/lib/video-grading-contract";

// US-2504, slice 1. Walk-around video grading is web-only, on the platform
// without the camera. The iOS recorder cannot be built or run from this Windows
// checkout — but the CONTRACT it has to speak can be pinned here, so a native
// client implements a spec instead of reverse-engineering field names out of
// new-submission.tsx.

const WEB = "src/pages/new-submission.tsx";
const EDGE = "services/edge-functions/src/routes/grade.ts";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("both ends speak the same field names (US-2504 AC2)", () => {
  it("the edge reads every field the contract declares", () => {
    const edge = read(EDGE);
    for (const field of VIDEO_SUBMIT_FIELDS) {
      expect(edge, `the edge never reads "${field}"`).toContain(
        `formData.get("${field}")`,
      );
    }
  });

  it("the web sends them from the contract, not from spelled literals", () => {
    // A rename on either side used to be a silent break for whichever client
    // nobody was looking at.
    const web = read(WEB);
    expect(web).toContain('from "@/lib/video-grading-contract"');
    expect(web).toContain("formData.append(VIDEO_FIELD, videoFile)");
    expect(web).toContain(
      "formData.append(VIDEO_GRADING_FIELD, VIDEO_GRADING_OPT_IN)",
    );
    expect(web).toContain("formData.append(VIDEO_SLOT_MARKS_FIELD, marks)");
    expect(web).toContain(
      "formData.append(VIDEO_CAPTURE_SOURCE_FIELD, videoSource)",
    );
  });

  it("the opt-in is an exact string, and the server compares it exactly", () => {
    // "1", "TRUE" and a JSON boolean do NOT opt in. A native client that sends
    // one of those would attach a clip and be graded from photos it never sent.
    expect(VIDEO_GRADING_OPT_IN).toBe("true");
    const edge = read(EDGE);
    expect(edge).toContain(
      `(formData.get("${VIDEO_GRADING_FIELD}") as string | null) === "${VIDEO_GRADING_OPT_IN}"`,
    );
  });

  it("the capture sources are the two the server normalises to", () => {
    const norm = read("services/edge-functions/src/lib/verified-capture.ts");
    for (const source of VIDEO_CAPTURE_SOURCES) {
      expect(norm, `the server does not know "${source}"`).toContain(source);
    }
  });

  it("the field names are what they have always been", () => {
    // Pinned literally: this file is now the spec a native client implements,
    // so a rename has to be a deliberate, visible change here.
    expect(VIDEO_FIELD).toBe("video");
    expect(VIDEO_GRADING_FIELD).toBe("video_grading");
    expect(VIDEO_SLOT_MARKS_FIELD).toBe("video_slot_marks");
    expect(VIDEO_CAPTURE_SOURCE_FIELD).toBe("video_capture_source");
  });
});

describe("an unusable clip is never charged (US-2504 AC3)", () => {
  // The AC calls this "matching the web behaviour", which undersells it: the
  // guarantee is the SERVER's. Any client posting the contract inherits it, and
  // a client-side "don't charge" would not be a guarantee at all.
  const edge = () => read(EDGE);

  it("the abstain path returns before payment runs", () => {
    const src = edge();
    expect(src).toContain("async function failVideoGrading");
    expect(src).toMatch(/returns BEFORE payment precedence runs/);
  });

  it("it lands the submission retakeable, not failed", () => {
    const src = edge();
    const start = src.indexOf("async function failVideoGrading");
    const block = src.slice(start, src.indexOf("// ── POST /submit", start));
    expect(block).toContain(`status: "${VIDEO_ABSTAIN_STATUS}"`);
    expect(block).toContain("video_graded: false");
  });

  it("it refunds a buyer debit taken at the gate", () => {
    // The buyer path debits before the submission row exists, so this is the
    // one place that unit can be handed back.
    const src = edge();
    const start = src.indexOf("async function failVideoGrading");
    const block = src.slice(start, src.indexOf("// ── POST /submit", start));
    expect(block).toContain("refundBuyerMeterSource");
  });

  it("and says so in the response, so a client can trust it", () => {
    const src = edge();
    expect(src).toContain("payment: { paid: false, charged: false }");
  });

  it("the helper recognises that response", () => {
    expect(
      isVideoAbstain({
        submissionId: "s1",
        status: "needs_photos",
        videoGrading: { ok: false, reason: "no usable frames" },
        photo_requests: [],
        payment: { paid: false, charged: false },
      }),
    ).toBe(true);
    // A charged response, a graded one, and junk are all not the abstain case.
    expect(isVideoAbstain({ status: "needs_photos", payment: { charged: true } })).toBe(false);
    expect(isVideoAbstain({ status: "completed", payment: { charged: false } })).toBe(false);
    expect(isVideoAbstain(null)).toBe(false);
    expect(isVideoAbstain("nope")).toBe(false);
  });
});

describe("what this slice does NOT claim (US-2504)", () => {
  it("no iOS recorder is asserted to exist", () => {
    // AC2's recorder and AC4's upload progress are Swift that cannot be
    // compiled or run here. A guard that went green while the recorder did not
    // exist is the failure mode this file is written to avoid; when the
    // recorder lands, it extends THIS spec rather than inventing a second one.
    const tracker = read("docs/reviews/full-surface-2026-08/FIX-PROGRESS.md");
    expect(tracker).toContain("US-2504");
  });
});
