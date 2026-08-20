import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2016. The paid consumer grading path on iOS, pinned against the route it
// posts to.
//
// The owner decided on 2026-08-19 that this path belongs on the phone. The
// endpoint, the multipart shape and the field set were already proven there by
// VideoGradeUploader, which posts to the SAME route for walk-around video
// grading - so what this file guards is not "does iOS reach the route" but the
// three values a client can get wrong without anything failing until a customer
// hits it:
//
//   • the image-type vocabulary, where the route says `label` and the phone's
//     capture strip says `tag` (US-2304 found those two lists disagreeing once
//     already);
//   • the required set, which decides whether the seller is told BEFORE paying
//     or after a charge, a vision call per image and a refund;
//   • the image cap, which I first wrote as 12 from memory when the route says
//     14.

const ROUTE = "services/edge-functions/src/routes/grade.ts";
const SWIFT = "ios/GradeThread/Grading/PhotoGradeUploader.swift";
const VIDEO = "ios/GradeThread/Grading/VideoGradeUploader.swift";
const QUALITY = "services/edge-functions/src/lib/image-quality.ts";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/** Comments stripped: a paragraph naming a constant is not the constant. */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*\/\/\/.*$/gm, "");
}

/** The route's own IMAGE_TYPES list, which is also its per-submission cap. */
function routeImageTypes(): string[] {
  const src = read(ROUTE);
  const block = /const IMAGE_TYPES = \[([\s\S]*?)\] as const;/.exec(src);
  expect(block, "IMAGE_TYPES moved or changed shape in grade.ts").toBeTruthy();
  return [...block![1]!.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]!);
}

function swiftNumber(name: string): number {
  const m = new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(code(SWIFT));
  expect(m, `${name} vanished from the Swift`).toBeTruthy();
  return Number(m![1]);
}

describe("the iOS consumer submit agrees with the route (US-2016)", () => {
  it("the image cap IS the route's cap", () => {
    // MAX_IMAGES_PER_SUBMISSION = IMAGE_TYPES.length. Over it the whole
    // submission is refused - after the upload.
    expect(swiftNumber("maxImages")).toBe(routeImageTypes().length);
  });

  it("the required set IS the route's required set", () => {
    // Missing one of these is charged, runs a vision call per image, abstains
    // to needs_photos and refunds: the money comes back and the AI spend does
    // not (US-2304). Checking client-side is what stops that round trip.
    const required = /REQUIRED_IMAGE_TYPES = \[([^\]]*)\]/.exec(read(QUALITY));
    expect(required, "REQUIRED_IMAGE_TYPES moved in image-quality.ts").toBeTruthy();
    const fromServer = [...required![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    const swift = /requiredGradingTypes = \[([^\]]*)\]/.exec(code(SWIFT));
    expect(swift, "requiredGradingTypes vanished from the Swift").toBeTruthy();
    const fromSwift = [...swift![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(fromSwift).toEqual(fromServer);
  });

  it("the tag/label split is translated, not assumed", () => {
    // The route's vocabulary is `label`; the capture strip's is `tag`. The
    // server maps grading -> FlipDesk in gradingImageTypeToPhotoType; the Swift
    // holds the inverse, which is the direction a client needs.
    const src = code(SWIFT);
    expect(src).toContain('case .tag: return "label"');
    expect(src).toContain('case .tag2: return "label_2"');
    // And every type it can send is one the route accepts.
    const accepted = new Set(routeImageTypes());
    for (const t of ["front", "back", "label", "label_2", "detail", "defect"]) {
      expect(accepted.has(t), `${t} is not in the route's IMAGE_TYPES`).toBe(true);
    }
  });

  it("the error copy uses the seller's word, not the route's", () => {
    // "Add the label photo" sends someone looking for a control that does not
    // exist on the strip.
    const src = code(SWIFT);
    expect(src).toContain('case "label": return "tag"');
  });

  it("photos and a clip are never sent together", () => {
    // The route refuses the combination and the refusal arrives AFTER the
    // upload. The video uploader states the rule from its side; the photo one
    // must not undo it by learning to attach a clip.
    expect(code(VIDEO)).not.toContain('("images"');
    const photo = code(SWIFT);
    expect(photo).not.toContain("videoField");
    expect(photo).not.toContain("video_grading");
  });

  it("it sends the same non-file fields the video path proved", () => {
    // Same route, same required fields. Divergence here is the kind that only
    // shows up as a 400 on one of the two paths.
    const photo = code(SWIFT);
    for (const f of ["garment_type", "garment_category", "title", "tier"]) {
      expect(photo).toContain(`("${f}"`);
    }
    // Both opt-ins explicit rather than defaulted, for the reason the video
    // uploader records: a default can change server-side without this client
    // knowing what it asked for.
    expect(photo).toContain('("verified_capture_opt_in", "false")');
    expect(photo).toContain('("authenticity_addon", "false")');
  });
});
