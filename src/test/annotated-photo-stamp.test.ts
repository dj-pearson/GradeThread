// US-2567: the preview must show the artifact, not a rehearsal of it.
//
// The seller decides whether to attach disclosure imagery by looking at the
// canvas in the disclosure panel. If that canvas omits the certificate stamp the
// worker burns in, the seller approves one image and ships a different one —
// and the difference is the entire evidentiary value of the pack.
//
// The two renderers cannot share a module: one runs in Deno with ImageScript,
// the other in the browser with Canvas2D. So the format is pinned from both
// sides. This is the web half; services/edge-functions/src/tests/evidence-pack_test.ts
// is the edge half, and they assert the same strings.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stampLine } from "@/lib/evidence-stamp";

describe("stampLine", () => {
  it("names the certificate, the score and where to check it", () => {
    const line = stampLine({
      certificateNumber: "GT-A1B2C3D",
      overallScore: 8.5,
      gradeTier: "Excellent",
    });
    expect(line).toContain("GT-A1B2C3D");
    expect(line).toContain("8.5 / 10");
    expect(line).toContain("Excellent");
    expect(line).toContain("gradethread.com/verify");
  });

  it("prints NO stamp for an uncertified grade", () => {
    // A stamp implying a certificate that does not exist is worse than none.
    expect(
      stampLine({ certificateNumber: null, overallScore: 8.5, gradeTier: "Excellent" }),
    ).toBeNull();
    expect(stampLine(null)).toBeNull();
    expect(stampLine(undefined)).toBeNull();
  });

  it("does not leave a dangling separator when the tier is blank", () => {
    const line = stampLine({
      certificateNumber: "GT-A1B2C3D",
      overallScore: 7,
      gradeTier: "   ",
    });
    expect(line).not.toContain("·  ·");
    expect(line).toContain("7.0 / 10");
  });

  it("formats the score to one decimal, matching the grading scale", () => {
    expect(
      stampLine({ certificateNumber: "GT-X", overallScore: 9, gradeTier: "Near mint" }),
    ).toContain("9.0 / 10");
  });
});

describe("edge/web parity", () => {
  // A drift guard, not a re-test. Two independent implementations of one visual
  // format will diverge the moment somebody edits one of them, and the failure
  // is invisible: both images render, they just no longer match.
  const edgeSource = readFileSync(
    resolve(
      process.cwd(),
      "services/edge-functions/src/lib/evidence-pack.ts",
    ),
    "utf8",
  );

  it("the edge builds the same stamp string", () => {
    expect(edgeSource).toContain('gradethread.com/verify');
    expect(edgeSource).toContain('`${score} / 10`');
    expect(edgeSource).toContain('parts.join("  ·  ")');
  });

  it("the edge stamp is also null for an uncertified grade", () => {
    expect(edgeSource).toContain("if (!stamp.certificateNumber) return null;");
  });

  it("the layout constant the two share is the same value", () => {
    const clientSource = readFileSync(
      resolve(process.cwd(), "src/components/disclosure/annotated-photo.tsx"),
      "utf8",
    );
    const edgeAnnotations = readFileSync(
      resolve(
        process.cwd(),
        "services/edge-functions/src/lib/defect-annotations.ts",
      ),
      "utf8",
    );
    const clientStamp = clientSource.match(/const STAMP_LINE_H = (\d+);/)?.[1];
    const edgeStamp = edgeAnnotations.match(/const STAMP_LINE_H = (\d+);/)?.[1];
    expect(clientStamp).toBeDefined();
    expect(edgeStamp).toBeDefined();
    expect(clientStamp).toBe(edgeStamp);
  });
});
