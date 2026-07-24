import { assert, assertEquals } from "@std/assert";
import {
  mergeAuthenticityReread,
  mergeLabelReread,
  mergeZoomIntoIssue,
  selectDefectsForZoom,
  selectImagesForAuthenticityReread,
  selectLabelsForReread,
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

// --- US-2154: label-legibility & authenticity re-read ---

function labelImg(over: Partial<PerImageAnalysis>): PerImageAnalysis {
  return { ...img("label", []), ...over };
}

Deno.test("selectLabelsForReread: illegible label and no-fiber label qualify", () => {
  const r = [
    labelImg({
      quality: { blur: "none", lighting: "ok", framing: "full", legible: false },
      fiber_content: [{ fiber: "cotton", pct: 100 }],
    }),
    labelImg({ image_type: "label_2", fiber_content: [] }),
  ];
  assertEquals(selectLabelsForReread(r).length, 2);
});

Deno.test("selectLabelsForReread: legible label with fiber, and non-labels, are skipped", () => {
  const r = [
    labelImg({
      quality: { blur: "none", lighting: "ok", framing: "full", legible: true },
      fiber_content: [{ fiber: "wool", pct: 80 }],
    }),
    img("front", []),
    img("defect", []),
  ];
  assertEquals(selectLabelsForReread(r).length, 0);
});

Deno.test("selectLabelsForReread: caps the number of candidates", () => {
  const r = [
    labelImg({ fiber_content: [] }),
    labelImg({ image_type: "label_2", fiber_content: [] }),
  ];
  assertEquals(selectLabelsForReread(r, 1).length, 1);
});

Deno.test("mergeLabelReread: recovers fiber_content when the original had none", () => {
  const original = labelImg({ fiber_content: [] });
  const reread = labelImg({ fiber_content: [{ fiber: "cashmere", pct: 100 }] });
  const merged = mergeLabelReread(original, reread);
  assertEquals(merged.fiber_content, [{ fiber: "cashmere", pct: 100 }]);
});

Deno.test("mergeLabelReread: never overwrites existing fiber_content", () => {
  const original = labelImg({ fiber_content: [{ fiber: "cotton", pct: 100 }] });
  const reread = labelImg({ fiber_content: [{ fiber: "polyester", pct: 100 }] });
  const merged = mergeLabelReread(original, reread);
  assertEquals(merged.fiber_content, [{ fiber: "cotton", pct: 100 }]);
});

Deno.test("mergeLabelReread: improves legibility false→true, never regresses", () => {
  const original = labelImg({
    quality: { blur: "none", lighting: "ok", framing: "full", legible: false },
  });
  const better = labelImg({
    quality: { blur: "none", lighting: "ok", framing: "full", legible: true },
  });
  assertEquals(mergeLabelReread(original, better).quality?.legible, true);

  const worse = labelImg({
    quality: { blur: "none", lighting: "ok", framing: "full", legible: false },
  });
  const legibleOriginal = labelImg({
    quality: { blur: "none", lighting: "ok", framing: "full", legible: true },
  });
  assertEquals(mergeLabelReread(legibleOriginal, worse).quality?.legible, true);
});

Deno.test("selectImagesForAuthenticityReread: only manipulation-suspected images", () => {
  const suspected = img("front", []);
  suspected.authenticity = {
    manipulation_suspected: true,
    manipulation_confidence: 0.4,
    tells: ["cloned texture"],
    screenshot_or_watermark: false,
    screenshot_watermark_reason: "",
  };
  const clean = img("back", []);
  clean.authenticity = {
    manipulation_suspected: false,
    manipulation_confidence: 0,
    tells: [],
    screenshot_or_watermark: false,
    screenshot_watermark_reason: "",
  };
  const c = selectImagesForAuthenticityReread([suspected, clean]);
  assertEquals(c.length, 1);
  assertEquals(c[0].image_type, "front");
});

Deno.test("mergeAuthenticityReread: suspicion is sticky, confidence maxes, tells union", () => {
  const original = img("front", []);
  original.authenticity = {
    manipulation_suspected: true,
    manipulation_confidence: 0.4,
    tells: ["cloned texture near knee"],
    screenshot_or_watermark: false,
    screenshot_watermark_reason: "",
  };
  // A sharper read that (wrongly) clears the flag must NOT launder it clean.
  const reread = img("front", []);
  reread.authenticity = {
    manipulation_suspected: false,
    manipulation_confidence: 0.1,
    tells: ["soft halo at hem"],
    screenshot_or_watermark: false,
    screenshot_watermark_reason: "",
  };
  const merged = mergeAuthenticityReread(original, reread);
  assertEquals(merged.authenticity?.manipulation_suspected, true);
  assertEquals(merged.authenticity?.manipulation_confidence, 0.4);
  assertEquals(merged.authenticity?.tells.length, 2);
});

Deno.test("mergeAuthenticityReread: a corroborating read strengthens confidence", () => {
  const original = img("front", []);
  original.authenticity = {
    manipulation_suspected: true,
    manipulation_confidence: 0.4,
    tells: ["cloned texture"],
    screenshot_or_watermark: false,
    screenshot_watermark_reason: "",
  };
  const reread = img("front", []);
  reread.authenticity = {
    manipulation_suspected: true,
    manipulation_confidence: 0.9,
    tells: ["cloned texture"],
    screenshot_or_watermark: true,
    screenshot_watermark_reason: "app UI chrome",
  };
  const merged = mergeAuthenticityReread(original, reread);
  assertEquals(merged.authenticity?.manipulation_confidence, 0.9);
  assertEquals(merged.authenticity?.screenshot_or_watermark, true);
  assertEquals(merged.authenticity?.tells.length, 1); // deduped
});
