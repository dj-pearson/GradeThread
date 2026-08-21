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
import { ensureCertificateNumber } from "./cert-number.ts";
import {
  certificateCardCopy,
  type CertificateCardCopy,
  type DefectCropTarget,
  type EvidenceStamp,
  evidenceStampLine,
  maxDefectCrops,
  returnEvidenceCardCopy,
  selectDefectCrops,
} from "./evidence-pack.ts";
import {
  AUTO_MARKER,
  type DerivedIdentity,
  type DerivedPhotoRow,
  findAttachedDerivative,
  nextSortOrder,
  selectStaleDerivedPhotos,
} from "./derived-photo-provenance.ts";

// Re-exported so existing importers of this module keep working, and so the
// provenance rules read as part of the annotation surface rather than as a
// separate concept.
export {
  findAttachedDerivative,
  isLegacyDerivedPath,
  nextSortOrder,
  selectStaleDerivedPhotos,
} from "./derived-photo-provenance.ts";
export type { DerivedIdentity, DerivedPhotoRow } from "./derived-photo-provenance.ts";

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
// US-2567: the provenance stamp's own line under the legend.
const STAMP_LINE_H = 24;
// A crop is upscaled to at least this wide so a pinhole is actually visible.
const CROP_TARGET_W = 720;
// The certificate card. Portrait, so it reads as a document beside the photos.
const CARD_W = 720;
const CARD_H = 900;
const CARD_PAD = 48;
const CARD_BAND_H = 132;

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
  // US-2567: burned into the legend so the artifact names its own certificate.
  // Optional so the existing unit tests and any caller without a certified
  // report keep working; a null stamp simply prints no line.
  stamp?: EvidenceStamp | null,
): Promise<Uint8Array> {
  const font = await loadFont();
  const photo = await Image.decode(imageBytes);
  if (photo.width > MAX_W) photo.resize(MAX_W, Image.RESIZE_AUTO);

  const w = photo.width;
  const h = photo.height;
  const stampLine = stamp ? evidenceStampLine(stamp) : null;
  const legendH = LEGEND_PAD * 2 + LEGEND_HEADER_H +
    annotations.length * LEGEND_LINE_H +
    (stampLine ? STAMP_LINE_H : 0);

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

  if (stampLine) {
    await drawStamp(canvas, font, stampLine, w, h + LEGEND_PAD + LEGEND_HEADER_H +
      annotations.length * LEGEND_LINE_H);
  }

  return await canvas.encodeJPEG(90);
}

/**
 * The provenance stamp: certificate number, score, tier and the verify host, on
 * its own line under the legend.
 *
 * Rendered in NAVY at legend weight rather than as a watermark over the photo.
 * A stamp across the garment would obscure the flaw the image exists to show,
 * which is the one thing it must not do.
 */
async function drawStamp(
  canvas: Image,
  font: Uint8Array,
  text: string,
  width: number,
  top: number,
): Promise<void> {
  const size = Math.max(12, Math.round(width / 62));
  const rendered = await fitText(font, size, text, NAVY, width - LEGEND_PAD * 2);
  canvas.composite(
    rendered,
    LEGEND_PAD,
    Math.round(top + (STAMP_LINE_H - rendered.height) / 2),
  );
}

/**
 * One defect, zoomed: the source region around its box, upscaled to a legible
 * width, with the callout box and number drawn on it and the stamp underneath.
 *
 * WHY A SEPARATE IMAGE AND NOT JUST A BIGGER BOX on the full shot. A pinhole on
 * a 900px-wide garment photo is a handful of pixels; a marketplace reviewer
 * looking at the full shot cannot see the thing the callout points at, and
 * "documented" becomes a claim about a box rather than about a flaw. The crop is
 * what makes the disclosure checkable.
 */
export async function compositeDefectCrop(
  imageBytes: Uint8Array,
  target: DefectCropTarget,
  stamp?: EvidenceStamp | null,
): Promise<Uint8Array> {
  const font = await loadFont();
  const photo = await Image.decode(imageBytes);

  const [nx, ny, nw, nh] = target.cropBox;
  // Round INWARD-safe: clamp every edge to the frame so a rounding step at the
  // boundary cannot ask ImageScript for a pixel that does not exist.
  const cx = Math.min(Math.max(0, Math.round(nx * photo.width)), photo.width - 1);
  const cy = Math.min(Math.max(0, Math.round(ny * photo.height)), photo.height - 1);
  const cw = Math.max(1, Math.min(Math.round(nw * photo.width), photo.width - cx));
  const ch = Math.max(1, Math.min(Math.round(nh * photo.height), photo.height - cy));

  const crop = photo.crop(cx, cy, cw, ch);
  // Upscale a small crop so the flaw is legible; never downscale below it.
  if (crop.width < CROP_TARGET_W) crop.resize(CROP_TARGET_W, Image.RESIZE_AUTO);
  else if (crop.width > MAX_W) crop.resize(MAX_W, Image.RESIZE_AUTO);

  const w = crop.width;
  const h = crop.height;
  const stampLine = stamp ? evidenceStampLine(stamp) : null;
  const legendH = LEGEND_PAD * 2 + LEGEND_HEADER_H + LEGEND_LINE_H +
    (stampLine ? STAMP_LINE_H : 0);

  const canvas = new Image(w, h + legendH);
  canvas.fill(WHITE);
  canvas.composite(crop, 0, 0);

  // The defect's own box, re-projected from the SOURCE frame into the crop.
  const a = target.annotation;
  if (a.bbox) {
    const [bx, by, bw, bh] = a.bbox;
    const rx = ((bx - nx) / nw) * w;
    const ry = ((by - ny) / nh) * h;
    const rw = (bw / nw) * w;
    const rh = (bh / nh) * h;
    const color = severityColor(a.severity);
    const stroke = Math.max(2, Math.round(w / 250));
    strokeRect(canvas, rx + 1, ry + 1, rw, rh, stroke, color);
    const markerR = Math.max(11, Math.round(w / 36));
    const mx = Math.min(Math.max(markerR + 1, Math.round(rx)), w - markerR - 1);
    const my = Math.min(Math.max(markerR + 1, Math.round(ry)), h - markerR - 1);
    canvas.drawCircle(mx, my, markerR, color);
    const num = await Image.renderText(font, Math.max(12, Math.round(w / 56)), String(a.n), WHITE);
    canvas.composite(num, Math.round(mx - num.width / 2), Math.round(my - num.height / 2));
  }

  const header = await fitText(
    font,
    Math.max(13, Math.round(w / 55)),
    `Flaw ${a.n} — close-up`,
    NAVY,
    w - LEGEND_PAD * 2,
  );
  canvas.composite(header, LEGEND_PAD, h + LEGEND_PAD);

  const loc = a.location ? ` (${a.location})` : "";
  const line = await fitText(
    font,
    Math.max(13, Math.round(w / 60)),
    `${a.issue}${loc} — ${a.severity}`,
    INK,
    w - LEGEND_PAD * 2,
  );
  canvas.composite(line, LEGEND_PAD, h + LEGEND_PAD + LEGEND_HEADER_H);

  if (stampLine) {
    await drawStamp(canvas, font, stampLine, w, h + LEGEND_PAD + LEGEND_HEADER_H + LEGEND_LINE_H);
  }

  return await canvas.encodeJPEG(90);
}

/**
 * The certificate card: the pack's only image with no photograph on it.
 *
 * It exists because the other assets are viewed out of order. A marketplace
 * claim form shows a reviewer three thumbnails with no context, and this is the
 * one that says what grade the garment carried, how many flaws were documented,
 * and where to check the number.
 */
export async function compositeCertificateCard(
  stamp: EvidenceStamp,
  defectCount: number,
): Promise<Uint8Array> {
  return await drawCertificateCard(certificateCardCopy(stamp, defectCount));
}

/** The drawing, shared by the listing card and the return-evidence sheet. */
async function drawCertificateCard(
  copy: CertificateCardCopy,
): Promise<Uint8Array> {
  const font = await loadFont();

  const w = CARD_W;
  const h = CARD_H;
  const canvas = new Image(w, h);
  canvas.fill(WHITE);
  // A single navy band across the top. One flat block of brand colour, no
  // gradient — emphasis here comes from size and weight, per the design system.
  canvas.drawBox(0, 0, w, CARD_BAND_H, NAVY);

  const heading = await fitText(font, 34, copy.heading, WHITE, w - CARD_PAD * 2);
  canvas.composite(heading, CARD_PAD, Math.round((CARD_BAND_H - heading.height) / 2));

  let y = CARD_BAND_H + CARD_PAD;
  const score = await fitText(font, 76, copy.score, INK, w - CARD_PAD * 2);
  canvas.composite(score, CARD_PAD, y);
  y += score.height + 10;

  const tier = await fitText(font, 30, copy.tier, NAVY, w - CARD_PAD * 2);
  canvas.composite(tier, CARD_PAD, y);
  y += tier.height + 22;

  const defects = await fitText(font, 24, copy.defects, INK, w - CARD_PAD * 2);
  canvas.composite(defects, CARD_PAD, y);
  y += defects.height + 30;

  const cert = await fitText(font, 30, copy.certificate, INK, w - CARD_PAD * 2);
  canvas.composite(cert, CARD_PAD, y);
  y += cert.height + 8;

  const verify = await fitText(font, 22, copy.verify, NAVY, w - CARD_PAD * 2);
  canvas.composite(verify, CARD_PAD, y);

  return await canvas.encodeJPEG(92);
}

/**
 * US-2706: the evidence sheet an eBay return case receives.
 *
 * Same compositor, same geometry, same brand band - only the copy differs, so
 * a seller looking at the sheet and at their certificate sees one document.
 * Reusing compositeCertificateCard's drawing rather than writing a second one
 * is the point: two renderers would drift, and the one that drifted would be
 * the one nobody looks at until a case is open.
 */
export async function compositeReturnEvidenceSheet(
  stamp: EvidenceStamp,
  defectCount: number,
  gradedAtIso: string | null,
): Promise<Uint8Array> {
  return await drawCertificateCard(
    returnEvidenceCardCopy(stamp, defectCount, gradedAtIso),
  );
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

/**
 * For an OPTED-IN, GRADED item: composite the current grade report's defect
 * annotations onto the grading photos and append them to item_photos so every
 * publish path ships them.
 *
 * Idempotent through the provenance columns (US-2566) rather than through the
 * destination filename: re-running a batch (retry / resume / reclaim) attaches
 * nothing twice, and assets from a SUPERSEDED report are pruned so the imagery
 * always reflects the verified grade.
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

  // US-2566: the human-readable certificate number, denormalized onto every
  // asset so the artifact stands alone — a returns-defense image that cannot
  // name its own certificate is just a picture. ensureCertificateNumber
  // BACKFILLS a certified report that predates the column (migration 00307)
  // rather than skipping it, so older graded items still produce citable
  // imagery. Null for an uncertified report, which is a correct null.
  const certificateNumber = report.certificate_id
    ? await ensureCertificateNumber(report.certificate_id)
    : null;

  const stamp: EvidenceStamp = {
    certificateNumber,
    overallScore: report.overall_score,
    gradeTier: report.grade_tier,
  };

  const disclosure = buildDisclosure(toDisclosureInput(report));
  const groups = selectAnnotatableImages(disclosure.image_annotations);

  const { data: photoRows } = await supabaseAdmin
    .from("item_photos")
    .select(
      "id, storage_path, sort_order, derived_from_grade_report_id, derived_transform, derived_from_storage_path, derived_defect_index",
    )
    .eq("inventory_item_id", item.id);
  const existing = (photoRows ?? []) as DerivedPhotoRow[];

  // Prune assets from a superseded grade report (regrade) so the attached
  // imagery never contradicts the current verified grade.
  const staleIds = selectStaleDerivedPhotos(existing, report.id);
  if (staleIds.length > 0) {
    const staleSet = new Set(staleIds);
    const stalePaths = existing
      .filter((p) => staleSet.has(p.id))
      .map((p) => p.storage_path)
      .filter((p): p is string => typeof p === "string");
    await supabaseAdmin.from("item_photos").delete().in("id", staleIds);
    if (stalePaths.length > 0) {
      await supabaseAdmin.storage.from("item-photos").remove(stalePaths);
    }
  }
  const staleSet = new Set(staleIds);
  const live = existing.filter((p) => !staleSet.has(p.id));
  let nextSort = nextSortOrder(existing, staleIds);

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

    const identity: DerivedIdentity = {
      gradeReportId: report.id,
      transform: "annotated_full",
      sourceStoragePath: srcPath,
      // NULL because this asset marks up EVERY defect on its source image rather
      // than one of them. US-2567's crops set a real index.
      defectIndex: null,
    };
    if (findAttachedDerivative(live, identity)) continue;

    const safeType = group.image_type.replace(/[^a-z0-9_-]/gi, "");
    const destPath = `${ownerId}/${item.id}/${AUTO_MARKER}${safeType}_${reportTag}.jpg`;
    try {
      const { data: blob, error: dlErr } = await supabaseAdmin.storage
        .from("submission-images")
        .download(srcPath);
      if (dlErr || !blob) continue;
      const srcBytes = new Uint8Array(await blob.arrayBuffer());
      const out = await compositeAnnotatedPhoto(srcBytes, group.annotations, stamp);
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
      const { data: insertedRow, error: insErr } = await supabaseAdmin
        .from("item_photos")
        .insert({
          inventory_item_id: item.id,
          photo_url: url,
          storage_path: destPath,
          photo_type: "defect",
          sort_order: nextSort,
          bytes: out.byteLength,
          width: outDims?.width ?? null,
          height: outDims?.height ?? null,
          // ── US-2566 provenance ──
          derived_from_grade_report_id: identity.gradeReportId,
          derived_from_storage_path: identity.sourceStoragePath,
          derived_transform: identity.transform,
          derived_defect_index: identity.defectIndex,
          // NULL, and deliberately not [0,0,1,1]. The column records the region
          // an asset was CROPPED to; this one was not cropped, so there is no
          // honest box to record. US-2567's crops fill it.
          derived_bbox: null,
          certificate_number: certificateNumber,
        })
        .select("id")
        .maybeSingle();
      if (insErr) continue;
      // Keep the in-memory view in step, so a later group in this same pass sees
      // what was just attached instead of re-deriving it.
      live.push({
        id: (insertedRow as { id: string } | null)?.id ?? destPath,
        storage_path: destPath,
        sort_order: nextSort,
        derived_from_grade_report_id: identity.gradeReportId,
        derived_transform: identity.transform,
        derived_from_storage_path: identity.sourceStoragePath,
        derived_defect_index: identity.defectIndex,
      });
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

  // ── US-2567: per-defect crops ──────────────────────────────────────────
  //
  // Rendered AFTER the full shots so the pack reads front-to-back in sort order:
  // the whole garment first, then the close-ups, then the card.
  const selection = selectDefectCrops(groups, maxDefectCrops());
  if (selection.truncated > 0) {
    // NEVER let the cap be silent. A pack that quietly documents 6 of 14 flaws
    // still LOOKS complete, and "we documented everything" is exactly the claim
    // a dispute turns on — so the number that was dropped has to be somewhere an
    // operator can find it.
    console.warn(
      `[defect-annotations] item ${item.id}: capped defect crops at ` +
        `${selection.crops.length}; ${selection.truncated} localized flaw(s) not ` +
        `cropped (they remain in the annotated full shot's legend).`,
    );
  }

  for (const target of selection.crops) {
    const srcPath = pathByType.get(target.imageType);
    if (!srcPath) continue;

    const identity: DerivedIdentity = {
      gradeReportId: report.id,
      transform: "defect_crop",
      sourceStoragePath: srcPath,
      // The callout NUMBER, which is what is printed on the image and what a
      // buyer or a claim form would cite. Stable for a given report.
      defectIndex: target.annotation.n,
    };
    if (findAttachedDerivative(live, identity)) continue;

    const destPath =
      `${ownerId}/${item.id}/${AUTO_MARKER}crop${target.annotation.n}_${reportTag}.jpg`;
    try {
      const { data: blob, error: dlErr } = await supabaseAdmin.storage
        .from("submission-images")
        .download(srcPath);
      if (dlErr || !blob) continue;
      const out = await compositeDefectCrop(
        new Uint8Array(await blob.arrayBuffer()),
        target,
        stamp,
      );
      const { error: upErr } = await supabaseAdmin.storage
        .from("item-photos")
        .upload(destPath, out, { contentType: "image/jpeg", upsert: true });
      if (upErr) continue;
      // item-photo-url-ok: a just-uploaded object in the public bucket.
      const url = supabaseAdmin.storage.from("item-photos").getPublicUrl(destPath)
        .data.publicUrl;
      const dims = readImageDimensions(out);
      const { data: row, error: insErr } = await supabaseAdmin
        .from("item_photos")
        .insert({
          inventory_item_id: item.id,
          photo_url: url,
          storage_path: destPath,
          photo_type: "defect",
          sort_order: nextSort,
          bytes: out.byteLength,
          width: dims?.width ?? null,
          height: dims?.height ?? null,
          derived_from_grade_report_id: identity.gradeReportId,
          derived_from_storage_path: identity.sourceStoragePath,
          derived_transform: identity.transform,
          derived_defect_index: identity.defectIndex,
          // The region actually cropped — expanded and clamped, NOT the raw
          // defect box. Recording the raw box would describe an image we did
          // not produce, and this column exists so a crop can be re-derived or
          // disputed against its source.
          derived_bbox: target.cropBox,
          certificate_number: certificateNumber,
        })
        .select("id")
        .maybeSingle();
      if (insErr) continue;
      live.push({
        id: (row as { id: string } | null)?.id ?? destPath,
        storage_path: destPath,
        sort_order: nextSort,
        derived_from_grade_report_id: identity.gradeReportId,
        derived_transform: identity.transform,
        derived_from_storage_path: identity.sourceStoragePath,
        derived_defect_index: identity.defectIndex,
      });
      nextSort += 1;
      attached += 1;
    } catch (err) {
      console.error(
        `[defect-annotations] crop ${target.annotation.n} failed for ${item.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── US-2567: the certificate card ──────────────────────────────────────
  //
  // Only for a CERTIFIED grade. A card printing "Not certified" would be an
  // artifact whose whole purpose is citation, citing nothing.
  if (certificateNumber) {
    const cardIdentity: DerivedIdentity = {
      gradeReportId: report.id,
      transform: "certificate_card",
      // The card is rendered from the report, not from a photograph. Its source
      // is the certificate itself, recorded so the identity stays unique without
      // pretending a source image was involved.
      sourceStoragePath: `certificate:${certificateNumber}`,
      defectIndex: null,
    };
    if (!findAttachedDerivative(live, cardIdentity)) {
      const destPath = `${ownerId}/${item.id}/${AUTO_MARKER}card_${reportTag}.jpg`;
      try {
        const defectCount = groups.reduce((n, g) => n + g.annotations.length, 0);
        const out = await compositeCertificateCard(stamp, defectCount);
        const { error: upErr } = await supabaseAdmin.storage
          .from("item-photos")
          .upload(destPath, out, { contentType: "image/jpeg", upsert: true });
        if (!upErr) {
          // item-photo-url-ok: a just-uploaded object in the public bucket.
          const url = supabaseAdmin.storage.from("item-photos").getPublicUrl(destPath)
            .data.publicUrl;
          const dims = readImageDimensions(out);
          const { error: insErr } = await supabaseAdmin.from("item_photos").insert({
            inventory_item_id: item.id,
            photo_url: url,
            storage_path: destPath,
            photo_type: "defect",
            sort_order: nextSort,
            bytes: out.byteLength,
            width: dims?.width ?? null,
            height: dims?.height ?? null,
            derived_from_grade_report_id: cardIdentity.gradeReportId,
            derived_from_storage_path: cardIdentity.sourceStoragePath,
            derived_transform: cardIdentity.transform,
            derived_defect_index: null,
            // No photograph, so no region.
            derived_bbox: null,
            certificate_number: certificateNumber,
          });
          if (!insErr) {
            nextSort += 1;
            attached += 1;
          }
        }
      } catch (err) {
        console.error(
          `[defect-annotations] certificate card failed for ${item.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return { attached, skipped: null };
}
