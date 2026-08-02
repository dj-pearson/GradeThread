// US-538: server-side defect-callout compositing for AutoLister.
//
// The Deno/edge counterpart of the browser canvas in
// src/components/disclosure/annotated-photo.tsx: the garment photo with a
// numbered callout box over each localized defect and a numbered legend strip
// underneath. The client version needs a human to open the disclosure panel
// and click "Attach to item"; this one runs inside the AutoLister worker so an
// opted-in, graded item gets its disclosure imagery with zero extra clicks.
//
// The drawing itself (compositeAnnotatedPhoto / selectAnnotatableImages) is
// pure and unit-tested; applyAutoDefectAnnotations is the DB/storage
// orchestration the worker calls. Annotations always come from the item's
// CURRENT grade report via buildDisclosure — the same deterministic source the
// disclosure panel renders — so the callouts reflect the verified grade.
//
// Text is rasterized with the bundled Roboto-Bold (Apache-2.0, see
// assets/Roboto-LICENSE.txt).

import { Image } from "imagescript";
import { supabaseAdmin } from "./supabase.ts";
import {
  buildDisclosure,
  type DisclosureInput,
  type ImageAnnotations,
  type PerImageAnalysisLike,
  type PhotoAnnotation,
} from "./disclosure.ts";
import { readImageDimensions } from "./upload-validation.ts";

// Severity tones mirror the client compositor (vault/20-domain/brand-design-system.md §3B).
const SEVERITY_COLOR: Record<string, number> = {
  major: 0xf03d5fff,
  moderate: 0xf59e0bff,
  minor: 0xeab308ff,
};

// Layout constants mirror annotated-photo.tsx so web preview ≈ shipped image.
const MAX_W = 900;
const LEGEND_LINE_H = 26;
const LEGEND_PAD = 14;
const LEGEND_HEADER_H = 24;

const NAVY = 0x0c1e36ff;
const INK = 0x0e0e1aff;
const WHITE = 0xffffffff;

let fontCache: Uint8Array | null = null;
async function loadFont(): Promise<Uint8Array> {
  if (!fontCache) {
    fontCache = await Deno.readFile(
      new URL("../../assets/Roboto-Bold.ttf", import.meta.url),
    );
  }
  return fontCache;
}

function severityColor(severity: string): number {
  return SEVERITY_COLOR[severity] ?? SEVERITY_COLOR.major;
}

/**
 * Annotation groups that are safe + useful to auto-attach: drop empty groups,
 * and drop the private grading `label` shot — US-276 forbids label imagery in
 * the public item-photos bucket.
 */
export function selectAnnotatableImages(
  groups: ImageAnnotations[],
): ImageAnnotations[] {
  return groups.filter(
    (g) => g.image_type !== "label" && g.annotations.length > 0,
  );
}

/** Outline rectangle drawn as four filled bars (ImageScript drawBox fills). */
function strokeRect(
  img: Image,
  x: number,
  y: number,
  w: number,
  h: number,
  t: number,
  color: number,
): void {
  // ImageScript pixel ops are 1-indexed; clamp the (possibly model-overflowed)
  // normalized bbox fully inside the canvas.
  const x1 = Math.min(Math.max(1, Math.round(x)), img.width);
  const y1 = Math.min(Math.max(1, Math.round(y)), img.height);
  const x2 = Math.min(Math.max(1, Math.round(x + w)), img.width);
  const y2 = Math.min(Math.max(1, Math.round(y + h)), img.height);
  const bw = x2 - x1;
  const bh = y2 - y1;
  if (bw <= 0 || bh <= 0) return;
  const tt = Math.min(t, bw, bh);
  img.drawBox(x1, y1, bw, tt, color); // top
  img.drawBox(x1, Math.max(1, y2 - tt), bw, tt, color); // bottom
  img.drawBox(x1, y1, tt, bh, color); // left
  img.drawBox(Math.max(1, x2 - tt), y1, tt, bh, color); // right
}

/** Render a single line of text, cropped to maxW so it can't overflow. */
async function fitText(
  font: Uint8Array,
  size: number,
  text: string,
  color: number,
  maxW: number,
): Promise<Image> {
  const img = await Image.renderText(font, size, text, color);
  if (img.width > maxW && maxW > 0) return img.crop(0, 0, maxW, img.height);
  return img;
}

/**
 * Composites numbered defect callouts + a legend strip onto a garment photo
 * and returns JPEG bytes. The photo is downscaled to ≤900px wide (legend text
 * stays proportionate; eBay re-compresses anyway); the legend extends the
 * canvas below the photo. Throws on decode/encode failure so the caller can
 * skip that photo — annotation must never block listing generation.
 */
export async function compositeAnnotatedPhoto(
  imageBytes: Uint8Array,
  annotations: PhotoAnnotation[],
): Promise<Uint8Array> {
  const font = await loadFont();
  const photo = await Image.decode(imageBytes);
  if (photo.width > MAX_W) photo.resize(MAX_W, Image.RESIZE_AUTO);

  const w = photo.width;
  const h = photo.height;
  const legendH = LEGEND_PAD * 2 + LEGEND_HEADER_H +
    annotations.length * LEGEND_LINE_H;

  const canvas = new Image(w, h + legendH);
  canvas.fill(WHITE);
  canvas.composite(photo, 0, 0);

  // ── Callout boxes for localized defects ─────────────────────────
  const stroke = Math.max(2, Math.round(w / 250));
  const markerR = Math.max(11, Math.round(w / 36));
  const numSize = Math.max(12, Math.round(w / 56));
  for (const a of annotations) {
    if (!a.bbox) continue; // unlocalized defects appear in the legend only
    const color = severityColor(a.severity);
    const [bx, by, bw, bh] = a.bbox;
    strokeRect(canvas, bx * w + 1, by * h + 1, bw * w, bh * h, stroke, color);
    // Numbered marker at the box's top-left, clamped fully on-canvas.
    const cx = Math.min(Math.max(markerR + 1, Math.round(bx * w)), w - markerR - 1);
    const cy = Math.min(Math.max(markerR + 1, Math.round(by * h)), h - markerR - 1);
    canvas.drawCircle(cx, cy, markerR, color);
    const num = await Image.renderText(font, numSize, String(a.n), WHITE);
    canvas.composite(
      num,
      Math.round(cx - num.width / 2),
      Math.round(cy - num.height / 2),
    );
  }

  // ── Legend strip ────────────────────────────────────────────────
  const headerSize = Math.max(13, Math.round(w / 55));
  const lineSize = Math.max(13, Math.round(w / 60));
  const chipR = 9;
  const header = await fitText(
    font,
    headerSize,
    "Documented condition — AI-verified by GradeThread",
    NAVY,
    w - LEGEND_PAD * 2,
  );
  canvas.composite(header, LEGEND_PAD, h + LEGEND_PAD);

  for (let i = 0; i < annotations.length; i++) {
    const a = annotations[i];
    const lineTop = h + LEGEND_PAD + LEGEND_HEADER_H + i * LEGEND_LINE_H;
    const cy = lineTop + Math.round(LEGEND_LINE_H / 2);
    const cx = LEGEND_PAD + chipR;
    canvas.drawCircle(cx, cy, chipR, severityColor(a.severity));
    const num = await Image.renderText(font, 12, String(a.n), WHITE);
    canvas.composite(
      num,
      Math.round(cx - num.width / 2),
      Math.round(cy - num.height / 2),
    );
    const loc = a.location ? ` (${a.location})` : "";
    const line = await fitText(
      font,
      lineSize,
      `${a.issue}${loc} — ${a.severity}`,
      INK,
      w - (LEGEND_PAD + 26) - LEGEND_PAD,
    );
    canvas.composite(line, LEGEND_PAD + 26, Math.round(cy - line.height / 2));
  }

  return await canvas.encodeJPEG(90);
}

// ── AutoLister orchestration ──────────────────────────────────────

export interface AutoAnnotateResult {
  attached: number;
  skipped:
    | "not-opted-in"
    | "not-graded"
    | "no-annotations"
    | null;
}

interface GradeReportLike {
  id: string;
  submission_id: string;
  overall_score: number;
  grade_tier: string;
  defects_found: unknown;
  detected_style_attributes: unknown;
  per_image_analysis: unknown;
  detailed_notes: Record<string, string> | null;
  certificate_id: string | null;
}

function toDisclosureInput(report: GradeReportLike): DisclosureInput {
  return {
    overall_score: report.overall_score,
    grade_tier: report.grade_tier,
    defects_found: Array.isArray(report.defects_found)
      ? (report.defects_found as DisclosureInput["defects_found"])
      : [],
    detected_style_attributes: Array.isArray(report.detected_style_attributes)
      ? (report.detected_style_attributes as DisclosureInput["detected_style_attributes"])
      : [],
    per_image_analysis: Array.isArray(report.per_image_analysis)
      ? (report.per_image_analysis as PerImageAnalysisLike[])
      : [],
    certificate_id: report.certificate_id,
    legacy_defects_summary: report.detailed_notes?.defects_summary ?? null,
  };
}

const AUTO_MARKER = "disclosure_auto_";

/**
 * For an OPTED-IN, GRADED item: composite the current grade report's defect
 * annotations onto the grading photos and append them to item_photos so every
 * publish path ships them. Idempotent — the destination storage path encodes
 * the grade-report id, so re-running a batch (retry/resume/reclaim) attaches
 * nothing twice, and auto photos from a SUPERSEDED report are pruned so the
 * imagery always reflects the verified grade.
 *
 * Tenant safety (CLAUDE.md US-268): the item is loaded scoped to ownerId; the
 * grade report only via that owned item's grade_report_id.
 */
export async function applyAutoDefectAnnotations(
  ownerId: string,
  itemId: string,
): Promise<AutoAnnotateResult> {
  const { data: itemRow } = await supabaseAdmin
    .from("inventory_items")
    .select("id, grade_report_id, annotate_defect_photos")
    .eq("id", itemId)
    .eq("user_id", ownerId)
    .maybeSingle();
  const item = itemRow as
    | { id: string; grade_report_id: string | null; annotate_defect_photos: boolean }
    | null;
  if (!item || item.annotate_defect_photos !== true) {
    return { attached: 0, skipped: "not-opted-in" };
  }
  if (!item.grade_report_id) return { attached: 0, skipped: "not-graded" };

  const { data: reportRow } = await supabaseAdmin
    .from("grade_reports")
    .select(
      "id, submission_id, overall_score, grade_tier, defects_found, detected_style_attributes, per_image_analysis, detailed_notes, certificate_id",
    )
    .eq("id", item.grade_report_id)
    .maybeSingle();
  if (!reportRow) return { attached: 0, skipped: "not-graded" };
  const report = reportRow as GradeReportLike;
  const reportTag = report.id.slice(0, 8);

  const disclosure = buildDisclosure(toDisclosureInput(report));
  const groups = selectAnnotatableImages(disclosure.image_annotations);

  // Existing photos: idempotency keys, next sort slot, and stale auto rows.
  const { data: photoRows } = await supabaseAdmin
    .from("item_photos")
    .select("id, storage_path, sort_order")
    .eq("inventory_item_id", item.id);
  const existing = (photoRows ?? []) as Array<
    { id: string; storage_path: string | null; sort_order: number | null }
  >;
  const existingPaths = new Set(
    existing.map((p) => p.storage_path).filter(Boolean) as string[],
  );
  let nextSort = existing.reduce(
    (max, p) => (typeof p.sort_order === "number" ? Math.max(max, p.sort_order + 1) : max),
    0,
  );

  // Prune auto-annotated photos from a superseded grade report (regrade) so
  // the attached imagery never contradicts the current verified grade.
  const stale = existing.filter(
    (p) =>
      p.storage_path?.includes(`/${AUTO_MARKER}`) &&
      !p.storage_path.includes(`_${reportTag}.jpg`),
  );
  if (stale.length > 0) {
    await supabaseAdmin
      .from("item_photos")
      .delete()
      .in("id", stale.map((p) => p.id));
    await supabaseAdmin.storage
      .from("item-photos")
      .remove(stale.map((p) => p.storage_path as string));
  }

  if (groups.length === 0) return { attached: 0, skipped: "no-annotations" };

  // Source images: the grading submission's photos (private bucket; the
  // service-role client downloads them directly — no signed URL needed).
  const { data: images } = await supabaseAdmin
    .from("submission_images")
    .select("image_type, storage_path, display_order")
    .eq("submission_id", report.submission_id)
    .order("display_order", { ascending: true });
  const pathByType = new Map<string, string>();
  for (const img of (images ?? []) as Array<{ image_type: string; storage_path: string | null }>) {
    if (img.storage_path && !pathByType.has(img.image_type)) {
      pathByType.set(img.image_type, img.storage_path);
    }
  }

  let attached = 0;
  for (const group of groups) {
    const srcPath = pathByType.get(group.image_type);
    if (!srcPath) continue;
    const safeType = group.image_type.replace(/[^a-z0-9_-]/gi, "");
    const destPath =
      `${ownerId}/${item.id}/${AUTO_MARKER}${safeType}_${reportTag}.jpg`;
    if (existingPaths.has(destPath)) continue; // already attached for this grade
    try {
      const { data: blob, error: dlErr } = await supabaseAdmin.storage
        .from("submission-images")
        .download(srcPath);
      if (dlErr || !blob) continue;
      const srcBytes = new Uint8Array(await blob.arrayBuffer());
      const out = await compositeAnnotatedPhoto(srcBytes, group.annotations);
      const { error: upErr } = await supabaseAdmin.storage
        .from("item-photos")
        .upload(destPath, out, { contentType: "image/jpeg", upsert: true });
      if (upErr) continue;
      // item-photo-url-ok: a staging/just-uploaded object in the public bucket,
      // not an item_photos row — there is no private variant to resolve.
      const url = supabaseAdmin.storage.from("item-photos").getPublicUrl(destPath)
        .data.publicUrl;
      // US-1896: record dimensions for the picture-standards preflight.
      const outDims = readImageDimensions(out);
      const { error: insErr } = await supabaseAdmin.from("item_photos").insert({
        inventory_item_id: item.id,
        photo_url: url,
        storage_path: destPath,
        photo_type: "defect",
        sort_order: nextSort,
        bytes: out.byteLength,
        width: outDims?.width ?? null,
        height: outDims?.height ?? null,
      });
      if (insErr) continue;
      nextSort += 1;
      attached += 1;
    } catch (err) {
      // Per-photo best-effort: a bad decode (e.g. webp source) skips that shot.
      console.error(
        `[defect-annotations] ${group.image_type} failed for ${item.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { attached, skipped: null };
}
