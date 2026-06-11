// Server-side forensic / manipulation pass on retained originals (US-341).
//
// A SECOND, byte/structure-level line of manipulation evidence that complements
// the US-336 vision authenticity signal. The vision model reasons about visual
// tells (cloned texture, inpainting, impossible lighting); this pass reasons
// about the FILE — recompression generation, editor fingerprints, missing
// provenance — signals the model cannot see in the pixels alone. Fusing the two
// gives a single tamper assessment that is harder to fool than either alone.
//
// WHY ORIGINALS ONLY. The grading upload path recompresses every photo
// client-side (strips EXIF, re-quantizes the JPEG). On that copy every forensic
// signal here is destroyed or made meaningless, so running it would be pure
// false positives. The pass therefore consumes the retained UNCOMPRESSED
// original (US-339, submission_images.original_storage_path) and skips cleanly
// when none was retained — a compressed-only submission grades exactly as before.
//
// SCOPE / HONESTY. A Deno edge container has no native image decoder, so true
// pixel-domain forensics (ELA re-encode residuals, PRNU/noise consistency,
// copy-move block matching, learned inpainting detectors) are not run HERE —
// they belong in a GPU/worker tier and would populate the same ForensicFeatures
// vector and flow through the SAME scoring/fusion core below. What runs now is
// the decoder-free structural layer (JPEG marker / quantization-table / EXIF
// provenance analysis), which is genuine recompression-and-editor evidence
// available from the bytes. The scoring + fusion logic (the testable core,
// AC #5) is pure and deterministic so the pixel tier can be added without
// touching it.

// ── Tunable thresholds / weights ─────────────────────────────────────
//
// Conservative by design: see the false-positive guardrail note on
// scoreImageForensics(). A SINGLE benign global signal (a plain re-save through
// an editor, a progressive re-encode) must stay BELOW the suspect threshold so
// a legitimately edited-but-untampered photo is not flagged. Manipulation
// requires corroborating signals.

// Per-image structural score at/above which a single image is "suspected".
export const FORENSIC_SUSPECT_THRESHOLD = 0.6;
// Fused (forensic ⊕ vision) likelihood at/above which the garment is suspected.
export const FUSE_SUSPECT_THRESHOLD = 0.6;
// A JPEG whose estimated quality is below this on a CLAIMED original is a
// recompression tell (camera originals are typically ≥ 85).
const LOW_QUALITY_TELL = 70;
// Max confidence the fused tamper signal may subtract from a grade.
const MAX_CONFIDENCE_PENALTY = 0.3;

// Structural-feature weights. Tuned so no single benign edit reaches
// FORENSIC_SUSPECT_THRESHOLD; corroboration is required to flag.
const W = {
  editorSoftware: 0.35, // EXIF software names a pixel editor
  adobeMarker: 0.25, // Adobe APP14 segment (Photoshop/Illustrator export)
  exifAbsent: 0.15, // claimed original carries no provenance (weak alone)
  progressive: 0.1, // progressive scan — uncommon in camera originals
  lowQuality: 0.2, // heavy recompression
  standardQuantTables: 0.2, // libjpeg/Photoshop tables, not a camera's
} as const;

// EXIF `software` substrings that indicate a pixel EDITOR touched the file.
// Stock-camera software fields (OS/firmware/HDR pipeline names) are NOT here —
// those are benign and must not contribute a tell. Mirrors the spirit of the
// verified-capture editor list but scored, not gating.
const EDITOR_SOFTWARE_TELLS = [
  "photoshop",
  "lightroom",
  "gimp",
  "affinity",
  "pixelmator",
  "snapseed",
  "facetune",
  "picsart",
  "canva",
  "paint.net",
  "photoscape",
  "fotor",
  "befunky",
  "inshot",
];

// Standard JPEG Annex-K luminance quantization table. Camera firmware ships
// bespoke tables; libjpeg / Photoshop "Save for Web" derive theirs by scaling
// THIS table. A close match to a scaled standard table is therefore a
// re-encoded-by-software tell, and also yields the quality estimate.
const STD_LUM_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];

// ── Types ────────────────────────────────────────────────────────────

export type ImgFormat = "jpeg" | "png" | "webp" | "unknown";

// Decoder-free forensic features extracted from a single original file. Pixel
// tier (ELA/PRNU/copy-move scores) would extend this object; the scorer below
// already treats missing pixel fields as "no signal".
export interface ForensicFeatures {
  format: ImgFormat;
  bytes: number;
  // EXIF software field naming a known pixel editor, else null.
  editorSoftware: string | null;
  // Adobe APP14 marker present (Photoshop/Illustrator export).
  adobeMarker: boolean;
  // Estimated JPEG quality (0–100) from the luminance quant table, or null.
  jpegQualityEst: number | null;
  // Progressive JPEG scan (SOF2) — rare in camera originals.
  progressive: boolean;
  // Number of DQT (define-quantization-table) segments.
  dqtCount: number;
  // Claimed original carries NO usable provenance EXIF.
  exifAbsent: boolean;
  // Luminance quant table matches a SCALED standard (non-camera) table.
  standardQuantTables: boolean;
}

export interface ForensicImageScore {
  image_type: string;
  // 0–1 structural manipulation likelihood for THIS image.
  score: number;
  suspected: boolean;
  tells: string[];
  features: ForensicFeatures;
}

export interface ForensicAssessment {
  // Did the pass actually run (≥1 original available)?
  ran: boolean;
  analyzed_count: number;
  // 0–1 overall structural tamper likelihood (max over images).
  tamper_likelihood: number;
  suspected: boolean;
  per_image: ForensicImageScore[];
  tells: string[];
  flagged_image_types: string[];
  summary: string;
}

// Minimal shape of the US-336 vision signal we fuse with. Structurally
// satisfied by ai-grading.ts's ImageAuthenticity (no import → no cycle).
export interface VisionTamperSignal {
  manipulation_suspected: boolean;
  manipulation_confidence: number; // 0–1
  tells: string[];
}

export interface FusedTamperAssessment {
  // 0–1 combined likelihood from forensic ⊕ vision (noisy-OR).
  tamper_likelihood: number;
  manipulation_suspected: boolean;
  needs_review: boolean;
  // Subtract from the grade's confidence_score (0–MAX_CONFIDENCE_PENALTY).
  confidence_penalty: number;
  forensic_ran: boolean;
  forensic_suspected: boolean;
  vision_suspected: boolean;
  tells: string[];
  summary: string;
}

// ── Byte-level feature extraction (JPEG markers + DQT + provenance) ───

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function ascii(b: Uint8Array, start: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[start + i] ?? 0);
  return s;
}

function detectFormat(b: Uint8Array): ImgFormat {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "jpeg";
  }
  if (
    b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e &&
    b[3] === 0x47
  ) {
    return "png";
  }
  if (
    b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP"
  ) {
    return "webp";
  }
  return "unknown";
}

// Estimate JPEG quality (1–100) from a 64-entry luminance quant table by
// finding the standard-table scaling whose quantization best matches it. Also
// reports whether that best match is CLOSE (a software-scaled-standard table)
// vs. far (a bespoke camera table). Pure.
export function estimateJpegQuality(
  lumTable: number[],
): { quality: number; standard: boolean } | null {
  if (lumTable.length < 64) return null;
  let bestQ = 1;
  let bestDiff = Infinity;
  for (let q = 1; q <= 100; q++) {
    const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
    let diff = 0;
    for (let i = 0; i < 64; i++) {
      let v = Math.floor((STD_LUM_QUANT[i]! * scale + 50) / 100);
      if (v <= 0) v = 1;
      if (v > 255) v = 255;
      diff += Math.abs(v - lumTable[i]!);
    }
    if (diff < bestDiff) {
      bestDiff = diff;
      bestQ = q;
    }
  }
  // Average absolute per-coefficient deviation from the best scaled standard.
  // < ~2 means the table essentially IS a scaled standard table (libjpeg/PS).
  const avgDiff = bestDiff / 64;
  return { quality: bestQ, standard: avgDiff < 2 };
}

interface JpegMarkers {
  adobeMarker: boolean;
  exifSegment: boolean;
  progressive: boolean;
  dqtCount: number;
  lumQuantTable: number[] | null;
}

// Walk JPEG segment markers (no entropy decode). Same marker-walking shape as
// image-metadata.ts's stripJpeg, but READING forensic structure instead of
// rewriting. Bails safely on any malformed offset.
function parseJpegMarkers(b: Uint8Array): JpegMarkers {
  const out: JpegMarkers = {
    adobeMarker: false,
    exifSegment: false,
    progressive: false,
    dqtCount: 0,
    lumQuantTable: null,
  };
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return out;
  let off = 2;
  while (off + 4 <= b.length) {
    if (b[off] !== 0xff) break;
    const marker = b[off + 1]!;
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI → stop
    const len = (b[off + 2]! << 8) | b[off + 3]!;
    const segEnd = off + 2 + len;
    if (len < 2 || segEnd > b.length) break;
    if (marker === 0xee && ascii(b, off + 4, 5) === "Adobe") {
      out.adobeMarker = true;
    } else if (marker === 0xe1 && ascii(b, off + 4, 4) === "Exif") {
      out.exifSegment = true;
    } else if (marker === 0xc2) {
      out.progressive = true; // SOF2
    } else if (marker === 0xdb) {
      // DQT: one segment may hold multiple tables; each is [pq|tq][64 or 128].
      out.dqtCount++;
      let p = off + 4;
      while (p < segEnd) {
        const pqTq = b[p]!;
        const precision = pqTq >> 4; // 0 → 8-bit, 1 → 16-bit
        const tableId = pqTq & 0x0f;
        p++;
        const count = 64;
        const table: number[] = [];
        for (let i = 0; i < count && p < segEnd; i++) {
          if (precision === 1) {
            table.push((b[p]! << 8) | b[p + 1]!);
            p += 2;
          } else {
            table.push(b[p]!);
            p += 1;
          }
        }
        // Table 0 is luminance — the one we fingerprint for quality.
        if (tableId === 0 && out.lumQuantTable === null && table.length === 64) {
          out.lumQuantTable = table;
        }
      }
    }
    off = segEnd;
  }
  return out;
}

/**
 * Extract decoder-free forensic features from one original file. `bytes` is the
 * retained uncompressed original; `exif` is the sanitized provenance already
 * read client-side (US-339) — passed in rather than re-parsed from the TIFF.
 * Pure (no I/O).
 */
export function extractForensicFeatures(
  bytes: Uint8Array,
  exif: Record<string, unknown> | null,
): ForensicFeatures {
  const format = detectFormat(bytes);
  const features: ForensicFeatures = {
    format,
    bytes: bytes.length,
    editorSoftware: null,
    adobeMarker: false,
    jpegQualityEst: null,
    progressive: false,
    dqtCount: 0,
    exifAbsent: true,
    standardQuantTables: false,
  };

  // Provenance signals (any format): editor software + presence of EXIF.
  if (exif && typeof exif === "object") {
    const sw = str(exif.software);
    if (sw) {
      const low = sw.toLowerCase();
      if (EDITOR_SOFTWARE_TELLS.some((t) => low.includes(t))) {
        features.editorSoftware = sw;
      }
    }
    // "Has provenance" = at least one identifying field present.
    features.exifAbsent = !(
      str(exif.make) || str(exif.model) || str(exif.software) ||
      str(exif.dateTimeOriginal) || str(exif.dateTime)
    );
  }

  if (format === "jpeg") {
    const m = parseJpegMarkers(bytes);
    features.adobeMarker = m.adobeMarker;
    features.progressive = m.progressive;
    features.dqtCount = m.dqtCount;
    if (m.lumQuantTable) {
      const est = estimateJpegQuality(m.lumQuantTable);
      if (est) {
        features.jpegQualityEst = est.quality;
        features.standardQuantTables = est.standard;
      }
    }
    // The byte-level Exif segment is a stronger "has provenance" signal than a
    // possibly-empty stored exif object.
    if (m.exifSegment) features.exifAbsent = false;
  }

  return features;
}

// ── Pure scoring ─────────────────────────────────────────────────────

/**
 * Score one image's structural features into a 0–1 manipulation likelihood.
 *
 * FALSE-POSITIVE GUARDRAIL (AC #4). Weights are calibrated so NO single benign
 * global edit crosses FORENSIC_SUSPECT_THRESHOLD (0.6): an editor re-save
 * (0.35), an Adobe export (0.25), a progressive re-encode (0.1), or absent EXIF
 * (0.15) each stay below the line on their own. Flagging requires CORROBORATION
 * — e.g. an editor fingerprint AND heavy recompression AND a software quant
 * table. Pure + deterministic.
 */
export function scoreImageForensics(
  image_type: string,
  features: ForensicFeatures,
): ForensicImageScore {
  let score = 0;
  const tells: string[] = [];

  if (features.editorSoftware) {
    score += W.editorSoftware;
    tells.push(`processed by ${features.editorSoftware}`);
  }
  if (features.adobeMarker) {
    score += W.adobeMarker;
    tells.push("Adobe (Photoshop) save marker present");
  }
  if (features.standardQuantTables) {
    score += W.standardQuantTables;
    tells.push("non-camera (software) JPEG quantization tables");
  }
  if (
    features.jpegQualityEst !== null &&
    features.jpegQualityEst < LOW_QUALITY_TELL
  ) {
    score += W.lowQuality;
    tells.push(`heavy recompression (≈Q${features.jpegQualityEst})`);
  }
  if (features.progressive) {
    score += W.progressive;
    tells.push("progressive JPEG re-encode");
  }
  // Absent provenance is only a (weak) tell when SOMETHING else already points
  // to editing — a clean original legitimately may carry no EXIF, so it must
  // never contribute on its own.
  if (features.exifAbsent && tells.length > 0) {
    score += W.exifAbsent;
    tells.push("no camera provenance metadata");
  }

  score = Math.min(1, score);
  return {
    image_type,
    score,
    suspected: score >= FORENSIC_SUSPECT_THRESHOLD,
    tells,
    features,
  };
}

/** Aggregate per-image structural scores into the garment-level assessment. */
export function aggregateForensics(
  scores: ForensicImageScore[],
): ForensicAssessment {
  if (scores.length === 0) {
    return {
      ran: false,
      analyzed_count: 0,
      tamper_likelihood: 0,
      suspected: false,
      per_image: [],
      tells: [],
      flagged_image_types: [],
      summary: "No original images available for forensic analysis.",
    };
  }
  const tamper = Math.max(...scores.map((s) => s.score));
  const flagged = scores.filter((s) => s.suspected);
  const suspected = flagged.length > 0;
  const tells = [...new Set(flagged.flatMap((s) => s.tells))];
  const flaggedTypes = flagged.map((s) => s.image_type);
  const summary = suspected
    ? `Forensic analysis found manipulation indicators on ${flaggedTypes.join(", ")}.`
    : `Forensic analysis of ${scores.length} original image(s) found no manipulation indicators.`;
  return {
    ran: true,
    analyzed_count: scores.length,
    tamper_likelihood: tamper,
    suspected,
    per_image: scores,
    tells,
    flagged_image_types: flaggedTypes,
    summary,
  };
}

// ── Pure fusion (forensic ⊕ vision) ──────────────────────────────────

/**
 * Fuse the forensic structural assessment with the US-336 vision signal into a
 * single tamper assessment that drives confidence + review routing (AC #2).
 *
 * - Likelihood combines via noisy-OR (1 − (1−f)(1−v)): independent lines of
 *   evidence reinforce, neither has to be certain alone.
 * - CORROBORATION (both lines suspect) is the strongest case → full penalty and
 *   review. Either side alone still routes to review but with a smaller penalty.
 * - When the forensic pass did NOT run (compressed-only, AC #3) the result is
 *   exactly the vision signal — behavior is unchanged for those submissions.
 *
 * Pure + deterministic (AC #5).
 */
export function fuseTamperSignals(
  forensic: ForensicAssessment,
  vision: VisionTamperSignal,
): FusedTamperAssessment {
  const f = forensic.ran ? clamp01(forensic.tamper_likelihood) : 0;
  const v = clamp01(vision.manipulation_confidence);
  const forensicSuspected = forensic.ran && forensic.suspected;
  const visionSuspected = vision.manipulation_suspected === true;

  // Noisy-OR combination of the two independent likelihoods.
  const combined = 1 - (1 - f) * (1 - v);

  const corroborated = forensicSuspected && visionSuspected;
  const suspected = corroborated ||
    combined >= FUSE_SUSPECT_THRESHOLD ||
    forensicSuspected ||
    visionSuspected;

  const tells = [
    ...new Set([
      ...(forensicSuspected ? forensic.tells : []),
      ...(visionSuspected ? vision.tells : []),
    ]),
  ];

  // Penalty scales with the combined likelihood; corroboration pushes to the
  // cap. Never penalizes when nothing is suspected.
  let penalty = 0;
  if (suspected) {
    const base = combined * MAX_CONFIDENCE_PENALTY;
    penalty = corroborated ? MAX_CONFIDENCE_PENALTY : base;
    penalty = Math.min(MAX_CONFIDENCE_PENALTY, Math.max(0.05, penalty));
  }

  let summary: string;
  if (corroborated) {
    summary =
      "Manipulation indicated by BOTH forensic file analysis and the vision check.";
  } else if (forensicSuspected) {
    summary =
      "Forensic file analysis indicates possible manipulation of the original image(s).";
  } else if (visionSuspected) {
    summary = "The vision check flagged possible image manipulation.";
  } else if (suspected) {
    summary = "Combined manipulation likelihood is elevated.";
  } else {
    summary = forensic.ran
      ? "Forensic and vision checks found no manipulation indicators."
      : "Vision check found no manipulation indicators (no original for forensic pass).";
  }

  return {
    tamper_likelihood: round3(combined),
    manipulation_suspected: suspected,
    needs_review: suspected,
    confidence_penalty: round3(penalty),
    forensic_ran: forensic.ran,
    forensic_suspected: forensicSuspected,
    vision_suspected: visionSuspected,
    tells,
    summary,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── Orchestration ────────────────────────────────────────────────────

// Cap on how many originals we download + analyze per submission (cost /
// throughput bound, AC #3). The required angles (front/back/label/detail) are
// the highest-value targets; more than this adds little and costs storage I/O.
export function forensicMaxImages(): number {
  const raw = Number(Deno.env.get("FORENSIC_MAX_IMAGES"));
  return Number.isFinite(raw) && raw >= 1 && raw <= 12 ? Math.floor(raw) : 6;
}

// Explicit kill-switch (default ON). The pass is ALREADY gated by originals
// existing, so this only matters when originals are retained but the operator
// wants the forensic pass off (e.g. cost spike, bad threshold).
export function forensicEnabled(): boolean {
  return Deno.env.get("FORENSIC_ANALYSIS") !== "false";
}

export interface ForensicInputImage {
  image_type: string;
  original_storage_path: string | null;
  exif: Record<string, unknown> | null;
}

// Download one original from the private bucket. Injected in tests.
export type OriginalDownloader = (
  storagePath: string,
) => Promise<Uint8Array | null>;

/**
 * Run the forensic pass over a submission's images. Considers ONLY images that
 * retained an uncompressed original (AC #3 — compressed-only inputs are skipped,
 * and if NONE has an original the pass returns ran:false). Bounded by
 * forensicMaxImages(). Never throws — a forensic hiccup must not fail a paid
 * grade; on any per-image error that image is simply skipped.
 */
export async function runForensicPass(
  images: ForensicInputImage[],
  download: OriginalDownloader,
): Promise<ForensicAssessment> {
  if (!forensicEnabled()) {
    return aggregateForensics([]);
  }
  const withOriginal = images.filter((i) => i.original_storage_path);
  if (withOriginal.length === 0) {
    // No originals → nothing forensic to do. Clean skip (AC #3).
    return aggregateForensics([]);
  }

  const budget = withOriginal.slice(0, forensicMaxImages());
  const scores: ForensicImageScore[] = [];
  for (const img of budget) {
    try {
      const bytes = await download(img.original_storage_path!);
      if (!bytes || bytes.length === 0) continue;
      const features = extractForensicFeatures(bytes, img.exif);
      scores.push(scoreImageForensics(img.image_type, features));
    } catch (err) {
      console.error(
        `[Forensics] analysis failed for ${img.image_type}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return aggregateForensics(scores);
}
