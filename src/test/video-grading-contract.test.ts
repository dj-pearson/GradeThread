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
  videoSubmitRejection,
  VIDEO_SUBMIT_FORMATS,
  VIDEO_SUBMIT_MAX_BYTES,
  VIDEO_SUBMIT_MAX_DURATION_SECONDS,
  VIDEO_UPLOAD_COMPLETE_IS_NOT_GRADED,
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

/**
 * Source with comments stripped. Prose that DESCRIBES a value is not the value,
 * and the file documenting a limit best is the one most likely to quote it.
 */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
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

// ── US-2504 slice 2: what the submit route will actually accept ────────────
//
// A recorder built to the wrong numbers produces clips the server refuses, and
// the refusal arrives after the whole upload has gone up a phone connection.
// None of this was written down; all of it is read back out of the route here.

describe("the caps a recorder must be built to (US-2504 AC2)", () => {
  it("takes the ROUTE's limits, which are stricter than the validator's", () => {
    // The trap. lib/video-validation.ts defaults to 100 MB / 60s and
    // routes/grade.ts passes its own caps, so a client built by reading the
    // validation library gets rejections at sizes that library calls fine.
    const route = code(EDGE);
    const bytes = /MAX_VIDEO_BYTES = (\d+) \* 1024 \* 1024/.exec(route);
    const secs = /MAX_VIDEO_DURATION_SECONDS = (\d+)/.exec(route);
    expect(bytes, "MAX_VIDEO_BYTES moved").toBeTruthy();
    expect(secs, "MAX_VIDEO_DURATION_SECONDS moved").toBeTruthy();
    expect(Number(bytes![1]) * 1024 * 1024).toBe(VIDEO_SUBMIT_MAX_BYTES);
    expect(Number(secs![1])).toBe(VIDEO_SUBMIT_MAX_DURATION_SECONDS);

    // And they really are stricter, which is the whole reason to pin them.
    const lib = code("services/edge-functions/src/lib/video-validation.ts");
    const libBytes = /DEFAULT_MAX_VIDEO_BYTES = (\d+) \* 1024 \* 1024/.exec(lib);
    const libSecs = /DEFAULT_MAX_VIDEO_SECONDS = (\d+)/.exec(lib);
    expect(Number(libBytes![1]) * 1024 * 1024).toBeGreaterThan(VIDEO_SUBMIT_MAX_BYTES);
    expect(Number(libSecs![1])).toBeGreaterThan(VIDEO_SUBMIT_MAX_DURATION_SECONDS);
  });

  it("names the containers the sniffer accepts", () => {
    const lib = code("services/edge-functions/src/lib/video-validation.ts");
    const m = /export type VideoFormat = ([^;]+);/.exec(lib);
    expect(m, "VideoFormat moved").toBeTruthy();
    const formats = [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
    expect(formats.sort()).toEqual([...VIDEO_SUBMIT_FORMATS].sort());
  });

  it("still sniffs magic bytes rather than trusting the name", () => {
    // A client that renames a file .mp4 has not made it one.
    expect(code(EDGE)).toContain("validateVideoUpload");
    expect(code("services/edge-functions/src/lib/video-validation.ts"))
      .toContain("sniffVideoFormat");
  });
});

describe("photos and a clip are mutually exclusive (US-2504 AC2)", () => {
  it("the server refuses both, before a row or a charge exists", () => {
    // The rule a second client is most likely to break, because the natural iOS
    // flow is additive: stage photos, then also record a walk-around.
    const route = code(EDGE);
    expect(route).toContain("videoPhotoConflict");
    const conflict = code("services/edge-functions/src/lib/video-grading-cost.ts");
    expect(conflict).toMatch(/uploadedPhotoCount <= 0\) return null/);
  });

  it("the contract rejects the same combination", () => {
    expect(
      videoSubmitRejection({
        bytes: 1000,
        durationSeconds: 10,
        format: "mp4",
        stagedPhotoCount: 1,
      }),
    ).toMatch(/photos can't be included/i);
  });

  it("says so BEFORE the size and format checks", () => {
    // Ordering is the message quality: a clip that is both too long and carries
    // photos should name the thing the seller can act on without re-recording.
    const msg = videoSubmitRejection({
      bytes: VIDEO_SUBMIT_MAX_BYTES + 1,
      durationSeconds: 900,
      format: "avi",
      stagedPhotoCount: 2,
    });
    expect(msg).toMatch(/photos/i);
  });
});

describe("the pre-upload rejection mirrors the server", () => {
  const ok = { bytes: 1024, durationSeconds: 12, format: "mp4", stagedPhotoCount: 0 };

  it("passes a clip the server would take", () => {
    expect(videoSubmitRejection(ok)).toBeNull();
  });

  it("catches an oversize clip before it is uploaded", () => {
    expect(
      videoSubmitRejection({ ...ok, bytes: VIDEO_SUBMIT_MAX_BYTES + 1 }),
    ).toMatch(/too large/i);
    // Exactly at the cap is allowed — the server compares with >, not >=.
    expect(videoSubmitRejection({ ...ok, bytes: VIDEO_SUBMIT_MAX_BYTES })).toBeNull();
  });

  it("catches an overlong clip, and allows one exactly at the cap", () => {
    expect(
      videoSubmitRejection({
        ...ok,
        durationSeconds: VIDEO_SUBMIT_MAX_DURATION_SECONDS + 0.1,
      }),
    ).toMatch(/too long/i);
    expect(
      videoSubmitRejection({
        ...ok,
        durationSeconds: VIDEO_SUBMIT_MAX_DURATION_SECONDS,
      }),
    ).toBeNull();
  });

  it("catches a container the sniffer will not take", () => {
    expect(videoSubmitRejection({ ...ok, format: "avi" })).toMatch(/format/i);
  });

  it("lets an UNREADABLE duration through to the server", () => {
    // null means the client could not read it, which is not the same as knowing
    // it is bad. The server refuses it with the right message; guessing here
    // would block clips the server would have accepted.
    expect(videoSubmitRejection({ ...ok, durationSeconds: null })).toBeNull();
    // A duration that IS read and is zero is a different thing, and is caught.
    expect(videoSubmitRejection({ ...ok, durationSeconds: 0 })).toMatch(/length/i);
  });

  it("rejects an empty clip", () => {
    expect(videoSubmitRejection({ ...ok, bytes: 0 })).toMatch(/empty/i);
  });
});

describe("upload progress is not grading progress (US-2504 AC4)", () => {
  it("the web holds the bar at 100 rather than calling it done", () => {
    // AC4 one step later: a client that dismisses at 100% tells the seller their
    // grade is ready while the server has not started extracting frames.
    const page = code("src/pages/new-submission.tsx");
    expect(page).toContain("xhr.upload.onprogress");
    expect(page).toContain("xhr.upload.onload = () => onProgress(100)");
    expect(VIDEO_UPLOAD_COMPLETE_IS_NOT_GRADED).toBe(true);
  });

  it("uses XHR for the clip because fetch cannot report upload progress", () => {
    // The reason the video path differs from the photo path at all. A native
    // client has upload progress natively and needs no equivalent workaround —
    // recorded so nobody ports the XHR branch to Swift as if it were the point.
    expect(code("src/pages/new-submission.tsx")).toContain("new XMLHttpRequest()");
  });
});
