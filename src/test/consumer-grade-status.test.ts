import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2016, the status half. Pinned against the CANONICAL definitions rather
// than against the neighbouring Swift, because every mistake this feature has
// made so far came from modelling a neighbour instead of a source:
//
//   • the image cap, copied from memory as 12 when the route says 14;
//   • an abstain read off the SUBMIT reply, which is a video-path field the
//     photo path never sends;
//   • three invented statuses (refunded, pending_payment, grading) and two
//     missed ones (pending, disputed) - `grading` being the sharp one, since it
//     is a real status on the flipdesk_grading_submissions BRIDGE row and not on
//     `submissions`, so it reads correct at a glance;
//   • a quality-feedback field named `reason` when the pipeline writes
//     `problem` / `severity` / `message`.
//
// None of those failed anything. All four were found by opening the definition.

const TYPES = "src/types/database.ts";
const SWIFT = "ios/GradeThread/Grading/PhotoGradeStatus.swift";
const ROUTE = "services/edge-functions/src/routes/grade.ts";
const PIPELINE = "services/edge-functions/src/lib/grading-pipeline.ts";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*\/\/\/.*$/gm, "");
}

/** The canonical submission statuses, from the SubmissionStatus union. */
function canonicalStatuses(): string[] {
  const src = read(TYPES);
  const start = src.indexOf("export type SubmissionStatus =");
  expect(start, "SubmissionStatus moved in database.ts").toBeGreaterThan(-1);
  const block = src.slice(start, src.indexOf(";", start));
  return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

/** Every status string the Swift claims to know about. */
function swiftStatuses(): string[] {
  const src = code(SWIFT);
  return [...src.matchAll(/"([a-z_]+)"/g)]
    .map((m) => m[1]!)
    // Field names and copy live in the same file; only compare things that
    // could plausibly be a status.
    .filter((s) => !["block", "warn", "label", "label_2", "tag"].includes(s));
}

describe("the iOS status model knows the real statuses (US-2016)", () => {
  it("invents none", () => {
    // The failure this catches is silent: a status the server never sends is a
    // branch that never runs, and on a polling screen that means a spinner
    // nobody can explain.
    const canonical = new Set(canonicalStatuses());
    const invented = swiftStatuses().filter((s) => !canonical.has(s));
    expect(
      invented,
      "these appear in PhotoGradeStatus.swift and are not in SubmissionStatus " +
        "(src/types/database.ts). `grading` is the trap: it IS a real status, on " +
        "the flipdesk_grading_submissions bridge row, not on submissions.",
    ).toEqual([]);
  });

  it("treats every non-terminal status as still working", () => {
    // Anything not terminal must keep polling. A status that is neither
    // terminal nor recognised as in-progress falls through to a default that
    // says "Working…" forever.
    const src = code(SWIFT);
    const terminalBlock = /terminalStatuses: Set<String> = \[([^\]]*)\]/.exec(src);
    expect(terminalBlock, "terminalStatuses vanished").toBeTruthy();
    const terminal = [...terminalBlock![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    for (const t of ["completed", "needs_photos", "failed", "expired"]) {
      expect(terminal, `${t} must be terminal`).toContain(t);
    }
    // pending_review is NOT terminal: a sub-0.75 grade goes to a human and does
    // move afterwards, so polling has to continue.
    expect(terminal).not.toContain("pending_review");
  });

  it("the abstain signal is the one the pipeline writes", () => {
    // needs_photos + quality_feedback, set together in grading-pipeline.ts.
    const pipeline = code(PIPELINE);
    expect(pipeline).toContain('status: "needs_photos"');
    expect(pipeline).toContain("quality_feedback: {");
    expect(code(SWIFT)).toContain('status == "needs_photos"');
  });

  it("the feedback fields are the ones actually written", () => {
    // summary / photo_requests / issues, and each issue carries
    // image_type / problem / severity / message. An earlier draft invented
    // `reason`, which would have decoded to nil forever.
    const swift = code(SWIFT);
    for (const field of ["summary", "photo_requests", "issues"]) {
      expect(swift, `quality_feedback.${field}`).toContain(field);
    }
    for (const field of ["image_type", "problem", "severity", "message"]) {
      expect(swift, `issue.${field}`).toContain(field);
    }
    expect(swift).not.toContain("abstain_reason");
  });

  it("shows the server's own photo_requests rather than rebuilding them", () => {
    // The gate de-duplicates its issues into sentences written for this screen.
    // Deriving copy from `issues` instead would be worse sentences from better
    // data.
    const swift = code(SWIFT);
    const start = swift.indexOf("retakeMessages");
    expect(start).toBeGreaterThan(-1);
    const block = swift.slice(start, start + 500);
    expect(block).toContain("photo_requests");
  });

  it("only BLOCKING issues drive the retake list", () => {
    // A warn did not stop the grade. Listing it beside the blockers tells
    // someone to redo a photo that was accepted.
    const swift = code(SWIFT);
    expect(swift).toContain('issue.severity == "block"');
  });

  it("the endpoint it polls is the one that returns this shape", () => {
    const route = code(ROUTE);
    expect(route).toContain('gradeRoutes.get("/status/:id"');
    expect(route).toContain("quality_feedback: submission.quality_feedback");
  });
});
