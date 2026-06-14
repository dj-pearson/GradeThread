import { assert, assertEquals } from "@std/assert";
import {
  mergeZoomIntoIssue,
  selectDefectsForZoom,
  type DetectedIssue,
  type PerImageAnalysis,
} from "../lib/ai-grading.ts";

function issue(p: Partial<DetectedIssue>): DetectedIssue {
  return {
    issue: "x",
    severity: "moderate",
    location: "front",
    is_intentional: false,
    ...p,
  };
}

function img(image_type: string, issues: DetectedIssue[]): PerImageAnalysis {
  return {
    image_type,
    detected_issues: issues,
    condition_signals: [],
    style_attributes: [],
    estimated_scores: {
      fabric_condition: 8,
      structural_integrity: 8,
      cosmetic_appearance: 8,
      functional_elements: 8,
      odor_cleanliness: 8,
    },
  };
}

Deno.test("selectDefectsForZoom: small bbox'd genuine defect is selected", () => {
  const r = [
    img("front", [
      issue({ size_bucket: "small", bbox: [0.4, 0.4, 0.02, 0.02], size_confidence: 0.5 }),
    ]),
  ];
  const c = selectDefectsForZoom(r);
  assertEquals(c.length, 1);
  assertEquals(c[0].image_type, "front");
  assertEquals(c[0].issueIndex, 0);
});

Deno.test("selectDefectsForZoom: skips intentional, no-bbox, and confident-medium", () => {
  const r = [
    img("front", [
      issue({ size_bucket: "small", bbox: [0.1, 0.1, 0.02, 0.02], is_intentional: true }),
      issue({ size_bucket: "small", bbox: null }),
      issue({ size_bucket: "medium", bbox: [0.1, 0.1, 0.05, 0.05], size_confidence: 0.9 }),
    ]),
  ];
  assertEquals(selectDefectsForZoom(r).length, 0);
});

Deno.test("selectDefectsForZoom: unknown size or low confidence qualifies", () => {
  const r = [
    img("back", [
      issue({ size_bucket: "unknown", bbox: [0.2, 0.2, 0.03, 0.03] }),
      issue({ size_bucket: "large", bbox: [0.5, 0.5, 0.1, 0.1], size_confidence: 0.2 }),
    ]),
  ];
  assertEquals(selectDefectsForZoom(r).length, 2);
});

Deno.test("selectDefectsForZoom: caps and prioritizes least-confident/smallest first", () => {
  const r = [
    img("front", [
      issue({ size_bucket: "small", bbox: [0.1, 0.1, 0.2, 0.2], size_confidence: 0.45 }),
      issue({ size_bucket: "small", bbox: [0.1, 0.1, 0.01, 0.01], size_confidence: 0.1 }),
      issue({ size_bucket: "small", bbox: [0.1, 0.1, 0.02, 0.02], size_confidence: 0.3 }),
    ]),
  ];
  const c = selectDefectsForZoom(r, 2);
  assertEquals(c.length, 2);
  // The 0.1-confidence tiny box is the top priority.
  assertEquals(c[0].issueIndex, 1);
  assertEquals(c[1].issueIndex, 2);
});

Deno.test("mergeZoomIntoIssue: high-res zoom upgrades size + severity", () => {
  const original = issue({
    defect_type: "hole_puncture",
    severity: "minor",
    size_bucket: "small",
    size_confidence: 0.4,
  });
  const zoom = img("defect", [
    issue({
      defect_type: "hole_puncture",
      severity: "major",
      size_bucket: "large",
      area_pct: 8,
      size_confidence: 0.85,
    }),
  ]);
  const merged = mergeZoomIntoIssue(original, zoom);
  assertEquals(merged.severity, "major");
  assertEquals(merged.size_bucket, "large");
  assertEquals(merged.area_pct, 8);
  assert((merged.size_confidence ?? 0) >= 0.85);
});

Deno.test("mergeZoomIntoIssue: zoom finds nothing genuine → lower size confidence", () => {
  const original = issue({ size_bucket: "small", size_confidence: 0.6 });
  const zoom = img("defect", [issue({ is_intentional: true })]); // only intentional
  const merged = mergeZoomIntoIssue(original, zoom);
  assert((merged.size_confidence ?? 1) <= 0.3);
  // Size/severity are not upgraded when nothing genuine was confirmed.
  assertEquals(merged.size_bucket, "small");
});

Deno.test("mergeZoomIntoIssue: never downgrades a worse original", () => {
  const original = issue({ severity: "major", size_bucket: "large", size_confidence: 0.9 });
  const zoom = img("defect", [
    issue({ severity: "minor", size_bucket: "small", size_confidence: 0.5 }),
  ]);
  const merged = mergeZoomIntoIssue(original, zoom);
  assertEquals(merged.severity, "major");
  assertEquals(merged.size_bucket, "large");
  assert((merged.size_confidence ?? 0) >= 0.9);
});
