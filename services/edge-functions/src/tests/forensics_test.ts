// Unit tests for the server-side forensic / manipulation pass (US-341).
//
// The scoring + fusion core is pure and deterministic (AC #5). forensics.ts
// imports no service client, so it loads directly with no env setup.
//
//   deno test --allow-env src/tests/forensics_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  aggregateForensics,
  estimateJpegQuality,
  extractForensicFeatures,
  type ForensicAssessment,
  type ForensicFeatures,
  fuseTamperSignals,
  FUSE_SUSPECT_THRESHOLD,
  runForensicPass,
  scoreImageForensics,
  type VisionTamperSignal,
} from "../lib/forensics.ts";

// ── Synthetic JPEG builder ───────────────────────────────────────────

// Standard Annex-K luminance table (a camera would NOT match a scaled version
// of this exactly; we use it here to produce a recognizable "software" table).
const STD_LUM = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];

function scaledStdTable(quality: number): number[] {
  const scale = quality < 50 ? Math.floor(5000 / quality) : 200 - quality * 2;
  return STD_LUM.map((v) => {
    let q = Math.floor((v * scale + 50) / 100);
    if (q <= 0) q = 1;
    if (q > 255) q = 255;
    return q;
  });
}

function buildJpeg(opts: {
  adobe?: boolean;
  exif?: boolean;
  progressive?: boolean;
  lumTable?: number[];
}): Uint8Array {
  const out: number[] = [0xff, 0xd8]; // SOI
  if (opts.exif) {
    // APP1 "Exif\0\0" minimal segment.
    const id = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
    const len = id.length + 2;
    out.push(0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...id);
  }
  if (opts.adobe) {
    // APP14 "Adobe" segment.
    const id = [0x41, 0x64, 0x6f, 0x62, 0x65, 0, 0, 0, 0, 0, 0]; // "Adobe"+data
    const len = id.length + 2;
    out.push(0xff, 0xee, (len >> 8) & 0xff, len & 0xff, ...id);
  }
  if (opts.lumTable) {
    // DQT: pq|tq byte (0 = 8-bit precision, table 0) + 64 table entries.
    const body = [0x00, ...opts.lumTable];
    const len = body.length + 2;
    out.push(0xff, 0xdb, (len >> 8) & 0xff, len & 0xff, ...body);
  }
  // SOF0 (baseline) or SOF2 (progressive).
  out.push(0xff, opts.progressive ? 0xc2 : 0xc0, 0x00, 0x02);
  // SOS — extractor stops here.
  out.push(0xff, 0xda, 0x00, 0x02);
  return new Uint8Array(out);
}

// ── estimateJpegQuality ──────────────────────────────────────────────

Deno.test("estimateJpegQuality recovers the quality of a scaled standard table", () => {
  const est = estimateJpegQuality(scaledStdTable(90));
  assert(est);
  // Inversion is exact-ish for standard tables.
  assert(Math.abs(est.quality - 90) <= 2, `got Q${est.quality}`);
  assertEquals(est.standard, true);
});

Deno.test("estimateJpegQuality flags a bespoke (camera) table as non-standard", () => {
  // A table whose SHAPE is uncorrelated with the standard table (reversed), so
  // no single quality scaling fits it — the bespoke-camera-table case.
  const bespoke = [...STD_LUM].reverse();
  const est = estimateJpegQuality(bespoke);
  assert(est);
  assertEquals(est.standard, false);
});

Deno.test("estimateJpegQuality returns null for a short table", () => {
  assertEquals(estimateJpegQuality([1, 2, 3]), null);
});

// ── extractForensicFeatures (byte structure) ─────────────────────────

Deno.test("extractForensicFeatures reads Adobe marker, progressive scan and quality", () => {
  const bytes = buildJpeg({
    adobe: true,
    progressive: true,
    lumTable: scaledStdTable(55),
  });
  const f = extractForensicFeatures(bytes, null);
  assertEquals(f.format, "jpeg");
  assertEquals(f.adobeMarker, true);
  assertEquals(f.progressive, true);
  assertEquals(f.standardQuantTables, true);
  assert(f.jpegQualityEst !== null && f.jpegQualityEst < 70);
  assertEquals(f.dqtCount, 1);
});

Deno.test("extractForensicFeatures detects an editor-software EXIF tell", () => {
  const bytes = buildJpeg({ lumTable: scaledStdTable(95) });
  const f = extractForensicFeatures(bytes, { software: "Adobe Photoshop 25.0" });
  assertEquals(f.editorSoftware, "Adobe Photoshop 25.0");
  assertEquals(f.exifAbsent, false);
});

Deno.test("extractForensicFeatures: benign stock-camera software is not an editor tell", () => {
  const bytes = buildJpeg({ lumTable: scaledStdTable(95) });
  const f = extractForensicFeatures(bytes, { make: "Apple", model: "iPhone 14", software: "17.1" });
  assertEquals(f.editorSoftware, null);
  assertEquals(f.exifAbsent, false);
});

Deno.test("extractForensicFeatures marks provenance absent when no EXIF and no Exif segment", () => {
  const bytes = buildJpeg({ lumTable: scaledStdTable(95) });
  const f = extractForensicFeatures(bytes, null);
  assertEquals(f.exifAbsent, true);
});

// ── scoreImageForensics — false-positive guardrails (AC #4) ──────────

function feat(partial: Partial<ForensicFeatures>): ForensicFeatures {
  return {
    format: "jpeg",
    bytes: 1000,
    editorSoftware: null,
    adobeMarker: false,
    jpegQualityEst: null,
    progressive: false,
    dqtCount: 1,
    exifAbsent: false,
    standardQuantTables: false,
    ...partial,
  };
}

Deno.test("a single benign edit stays BELOW the suspect threshold (no false positive)", () => {
  // Editor re-save only.
  const a = scoreImageForensics("front", feat({ editorSoftware: "GIMP 2.10" }));
  assert(!a.suspected, `editor-only should not flag, got ${a.score}`);
  // Adobe export only.
  const b = scoreImageForensics("front", feat({ adobeMarker: true }));
  assert(!b.suspected, `adobe-only should not flag, got ${b.score}`);
  // Progressive re-encode only.
  const c = scoreImageForensics("front", feat({ progressive: true }));
  assert(!c.suspected);
});

Deno.test("absent EXIF alone never contributes a tell", () => {
  const s = scoreImageForensics("front", feat({ exifAbsent: true }));
  assertEquals(s.score, 0);
  assertEquals(s.tells.length, 0);
});

Deno.test("corroborating signals flag manipulation", () => {
  const s = scoreImageForensics(
    "front",
    feat({
      editorSoftware: "Adobe Photoshop",
      adobeMarker: true,
      jpegQualityEst: 55,
      standardQuantTables: true,
    }),
  );
  assert(s.suspected, `corroborated signals should flag, got ${s.score}`);
  assert(s.tells.length >= 3);
});

// ── aggregateForensics ───────────────────────────────────────────────

Deno.test("aggregateForensics with no scores reports ran:false", () => {
  const a = aggregateForensics([]);
  assertEquals(a.ran, false);
  assertEquals(a.suspected, false);
  assertEquals(a.analyzed_count, 0);
});

Deno.test("aggregateForensics takes the max likelihood and lists flagged types", () => {
  const clean = scoreImageForensics("back", feat({}));
  const dirty = scoreImageForensics(
    "front",
    feat({ editorSoftware: "Photoshop", adobeMarker: true, jpegQualityEst: 50, standardQuantTables: true }),
  );
  const a = aggregateForensics([clean, dirty]);
  assertEquals(a.ran, true);
  assertEquals(a.analyzed_count, 2);
  assertEquals(a.suspected, true);
  assertEquals(a.tamper_likelihood, dirty.score);
  assertEquals(a.flagged_image_types, ["front"]);
});

// ── fuseTamperSignals (AC #2, #3, #5) ────────────────────────────────

function ran(likelihood: number, suspected: boolean, tells: string[] = []): ForensicAssessment {
  return {
    ran: true,
    analyzed_count: 1,
    tamper_likelihood: likelihood,
    suspected,
    per_image: [],
    tells,
    flagged_image_types: suspected ? ["front"] : [],
    summary: "",
  };
}

const cleanVision: VisionTamperSignal = {
  manipulation_suspected: false,
  manipulation_confidence: 0,
  tells: [],
};

Deno.test("fusion: compressed-only (forensic did not run) passes vision through unchanged", () => {
  const notRun = aggregateForensics([]);
  const visionFlag: VisionTamperSignal = {
    manipulation_suspected: true,
    manipulation_confidence: 0.8,
    tells: ["cloned texture"],
  };
  const fused = fuseTamperSignals(notRun, visionFlag);
  assertEquals(fused.forensic_ran, false);
  assertEquals(fused.manipulation_suspected, true);
  assertEquals(fused.tamper_likelihood, 0.8);
  assert(fused.tells.includes("cloned texture"));
});

Deno.test("fusion: clean forensic + clean vision => not suspected, no penalty", () => {
  const fused = fuseTamperSignals(ran(0.1, false), cleanVision);
  assertEquals(fused.manipulation_suspected, false);
  assertEquals(fused.needs_review, false);
  assertEquals(fused.confidence_penalty, 0);
});

Deno.test("fusion: noisy-OR combines independent likelihoods", () => {
  const fused = fuseTamperSignals(ran(0.5, false), {
    manipulation_suspected: false,
    manipulation_confidence: 0.5,
    tells: [],
  });
  // 1 - (1-0.5)(1-0.5) = 0.75
  assertEquals(fused.tamper_likelihood, 0.75);
  assert(fused.tamper_likelihood >= FUSE_SUSPECT_THRESHOLD);
  assertEquals(fused.manipulation_suspected, true);
});

Deno.test("fusion: corroboration (both suspect) yields the maximum penalty", () => {
  const fused = fuseTamperSignals(ran(0.7, true, ["software quant tables"]), {
    manipulation_suspected: true,
    manipulation_confidence: 0.7,
    tells: ["inpainting"],
  });
  assert(fused.forensic_suspected && fused.vision_suspected);
  assertEquals(fused.confidence_penalty, 0.3); // MAX
  assert(fused.tells.includes("software quant tables"));
  assert(fused.tells.includes("inpainting"));
  assert(fused.summary.includes("BOTH"));
});

Deno.test("fusion: forensic-only suspicion still routes to review with a bounded penalty", () => {
  const fused = fuseTamperSignals(ran(0.65, true, ["Adobe marker"]), cleanVision);
  assertEquals(fused.needs_review, true);
  assertEquals(fused.forensic_suspected, true);
  assertEquals(fused.vision_suspected, false);
  assert(fused.confidence_penalty > 0 && fused.confidence_penalty <= 0.3);
});

// ── runForensicPass (orchestration / bounds, AC #3) ──────────────────

Deno.test("runForensicPass skips cleanly when no originals were retained", async () => {
  const a = await runForensicPass(
    [
      { image_type: "front", original_storage_path: null, exif: null },
      { image_type: "back", original_storage_path: null, exif: null },
    ],
    () => Promise.reject(new Error("should not download")),
  );
  assertEquals(a.ran, false);
});

Deno.test("runForensicPass analyzes only images with an original and is bounded", async () => {
  Deno.env.set("FORENSIC_MAX_IMAGES", "2");
  let downloads = 0;
  const inputs = ["a", "b", "c", "d"].map((t) => ({
    image_type: t,
    original_storage_path: `path/${t}`,
    exif: null,
  }));
  const a = await runForensicPass(inputs, (_p) => {
    downloads++;
    return Promise.resolve(buildJpeg({ lumTable: scaledStdTable(95) }));
  });
  Deno.env.delete("FORENSIC_MAX_IMAGES");
  assertEquals(a.ran, true);
  assertEquals(downloads, 2); // capped
  assertEquals(a.analyzed_count, 2);
});

Deno.test("runForensicPass never throws on a download error; skips that image", async () => {
  const inputs = [
    { image_type: "front", original_storage_path: "p/front", exif: null },
    { image_type: "back", original_storage_path: "p/back", exif: null },
  ];
  const a = await runForensicPass(inputs, (p) => {
    if (p.endsWith("front")) return Promise.reject(new Error("boom"));
    return Promise.resolve(buildJpeg({ lumTable: scaledStdTable(95) }));
  });
  assertEquals(a.ran, true);
  assertEquals(a.analyzed_count, 1); // front skipped, back analyzed
});

Deno.test("runForensicPass honors the FORENSIC_ANALYSIS kill-switch", async () => {
  Deno.env.set("FORENSIC_ANALYSIS", "false");
  const a = await runForensicPass(
    [{ image_type: "front", original_storage_path: "p/front", exif: null }],
    () => Promise.reject(new Error("should not download")),
  );
  Deno.env.delete("FORENSIC_ANALYSIS");
  assertEquals(a.ran, false);
});
