// US-1572: MeasureCard calibration endpoint.
//
// POST /api/flipdesk/measure/calibrate { photo_id, force? }
//   → detects the MeasureCard's four ArUco fiducials in a 'measurement'
//     photo, fits the image-px → card-inch homography, persists the result on
//     the item_photos row (measure_calibration, migration 00347), and returns
//     it. Re-opening the editor reads the CACHED calibration (pass force:true
//     after replacing the underlying image).
//
// Deterministic CV only — NO model call, so calibration is NOT a billed AI
// action (US-1573 bills the extract pass instead). Server-side so iOS, web,
// and Android share ONE implementation (lib/measure-detect.ts, validated
// against OpenCV outputs in CI).
//
// Tenant safety (CLAUDE.md US-268): the photo row is loaded through an
// inventory_items!inner join filtered on the workspace owner BEFORE any
// storage read — a foreign photo_id 404s without touching the blob.

import { Hono } from "hono";
import { Image } from "imagescript";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  bucketForItemPhoto,
  downloadItemPhoto,
} from "../lib/item-photo-storage.ts";
import { MEASURE_CARD_VERSIONS } from "../lib/measure-card.ts";
import {
  calibrateMeasurePhoto,
  matMul3,
  type CalibrateResult,
  type GrayImage,
} from "../lib/measure-detect.ts";
import {
  extractMeasurements,
  mergeMeasurementsFillOnly,
} from "../lib/measure-extract.ts";
import {
  MEASUREMENT_TEMPLATES,
  measurementGroupFor,
} from "../lib/measurement-templates.ts";
import {
  AiQuotaExhaustedError,
  QUOTA_EXHAUSTED_MESSAGE,
  withAiAction,
} from "../lib/ai-metering.ts";
import { checkQuota } from "./flipdesk-ai.ts";

export const flipdeskMeasureRoutes = new Hono<{
  Variables: {
    userId: string;
    workspaceOwnerId?: string;
    workspaceRole?: "viewer" | "editor" | "admin" | "owner";
  };
}>();

/** Stored shape of item_photos.measure_calibration (versioned). */
export interface StoredCalibration {
  v: 1;
  cardVersion: number;
  ppi: number;
  homography: number[];
  quality: {
    markersFound: number;
    minMarkerSidePx: number;
    blurScore: number;
    reprojResidualIn: number;
  };
  computedAt: string;
}

// Photos larger than this are downscaled before detection (speed) and the
// homography/ppi are mapped back to ORIGINAL pixel coordinates — stored
// calibrations are always in the stored image's own px space.
export const MAX_DETECT_DIM = 2000;

/**
 * Grayscale an ImageScript image, downscaling to MAX_DETECT_DIM. Returns the
 * gray buffer plus the scale factor (resized = original * scale).
 */
export function toGray(img: Image, maxDim = MAX_DETECT_DIM): {
  gray: GrayImage;
  scale: number;
} {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const work = scale < 1
    ? img.resize(
      Math.max(1, Math.round(img.width * scale)),
      Math.max(1, Math.round(img.height * scale)),
    )
    : img;
  const gray = new Uint8Array(work.width * work.height);
  for (let y = 1; y <= work.height; y++) {
    for (let x = 1; x <= work.width; x++) {
      const px = work.getPixelAt(x, y) >>> 0;
      const r = (px >>> 24) & 0xff,
        g = (px >>> 16) & 0xff,
        b = (px >>> 8) & 0xff;
      gray[(y - 1) * work.width + (x - 1)] = (r * 299 + g * 587 + b * 114) /
        1000;
    }
  }
  return {
    gray: { width: work.width, height: work.height, gray },
    scale,
  };
}

/**
 * Map a calibration computed on a DOWNSCALED image back into original pixel
 * coordinates: H_orig = H_small · diag(scale, scale, 1); ppi scales inversely.
 */
export function rescaleCalibration(
  res: Extract<CalibrateResult, { ok: true }>,
  scale: number,
): Extract<CalibrateResult, { ok: true }> {
  if (scale === 1) return res;
  const S = [scale, 0, 0, 0, scale, 0, 0, 0, 1];
  return {
    ...res,
    homography: matMul3(res.homography, S),
    ppi: res.ppi / scale,
    markers: res.markers.map((m) => ({
      ...m,
      sidePx: m.sidePx / scale,
      center: [m.center[0] / scale, m.center[1] / scale],
      corners: m.corners.map(([x, y]) =>
        [x / scale, y / scale] as [number, number]
      ),
    })),
  };
}

flipdeskMeasureRoutes.post("/calibrate", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { photo_id?: unknown; force?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const photoId = typeof body.photo_id === "string" ? body.photo_id : "";
  if (!photoId) return c.json({ error: "photo_id is required" }, 400);
  const force = body.force === true;

  // Tenant-scoped load: the photo must belong to an item this workspace owns.
  const { data: row, error: rowErr } = await supabaseAdmin
    .from("item_photos")
    .select(
      "id, inventory_item_id, storage_path, photo_type, measure_calibration, inventory_items!inner(user_id)",
    )
    .eq("id", photoId)
    .eq("inventory_items.user_id", ownerId)
    .maybeSingle();
  if (rowErr) return c.json({ error: "Could not load the photo." }, 500);
  const photo = row as
    | {
      id: string;
      inventory_item_id: string;
      storage_path: string | null;
      photo_type: string | null;
      measure_calibration: StoredCalibration | null;
    }
    | null;
  if (!photo) return c.json({ error: "Photo not found" }, 404);

  if (photo.photo_type !== "measurement") {
    return c.json(
      {
        error:
          "This photo isn't tagged as the Measurement card shot. Retag it to 'Measurement card' first.",
      },
      422,
    );
  }
  if (!photo.storage_path) {
    return c.json({ error: "This photo has no stored image yet." }, 422);
  }

  // Cached calibration wins unless the caller forces a re-run.
  if (!force && photo.measure_calibration?.v === 1) {
    return c.json({ ok: true, cached: true, ...photo.measure_calibration });
  }

  const dl = await downloadItemPhoto(photo.storage_path, photo.photo_type);
  if ("error" in dl) {
    return c.json({ error: `Could not load the image: ${dl.error}` }, 502);
  }
  let decoded: Image;
  try {
    const bytes = new Uint8Array(await dl.blob.arrayBuffer());
    decoded = (await Image.decode(bytes)) as Image;
  } catch {
    return c.json({ error: "Could not decode the image." }, 422);
  }

  const { gray, scale } = toGray(decoded);
  let result = calibrateMeasurePhoto(gray, MEASURE_CARD_VERSIONS);
  if (!result.ok) {
    // Quality-gate failures are actionable 422s, not server errors.
    return c.json(
      {
        ok: false,
        reason: result.reason,
        message: result.message,
        quality: result.quality,
      },
      422,
    );
  }
  result = rescaleCalibration(result, scale);

  const stored: StoredCalibration = {
    v: 1,
    cardVersion: result.cardVersion,
    ppi: result.ppi,
    homography: result.homography,
    quality: result.quality,
    computedAt: new Date().toISOString(),
  };
  // Keyed on the owned row's id (verified above) — no attacker-controlled id
  // reaches this update unscoped.
  const { error: upErr } = await supabaseAdmin
    .from("item_photos")
    .update({ measure_calibration: stored } as never)
    .eq("id", photo.id);
  if (upErr) {
    console.error("[flipdesk-measure] persist failed:", upErr.message);
    // The calibration itself is still valid — return it; the next open recomputes.
  }

  return c.json({ ok: true, cached: false, ...stored });
});

// US-1573: POST /extract { photo_id } — one billed AI action that proposes
// every applicable measurement's endpoints (Claude Vision), snaps them to the
// garment edge deterministically, converts to inches on the calibrated card
// plane, plausibility-checks against the size tag, and fill-only merges into
// inventory_items.measurements + ai_field_sources ("measurements.<key>" keys,
// the same provenance the MeasurementForm already badges). Requires a prior
// successful /calibrate (the homography is the ruler).
flipdeskMeasureRoutes.post("/extract", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { photo_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const photoId = typeof body.photo_id === "string" ? body.photo_id : "";
  if (!photoId) return c.json({ error: "photo_id is required" }, 400);

  // Tenant-scoped photo load (same owner-verified join as /calibrate).
  const { data: row, error: rowErr } = await supabaseAdmin
    .from("item_photos")
    .select(
      "id, inventory_item_id, storage_path, photo_type, measure_calibration, inventory_items!inner(user_id)",
    )
    .eq("id", photoId)
    .eq("inventory_items.user_id", ownerId)
    .maybeSingle();
  if (rowErr) return c.json({ error: "Could not load the photo." }, 500);
  const photo = row as
    | {
      id: string;
      inventory_item_id: string;
      storage_path: string | null;
      photo_type: string | null;
      measure_calibration: StoredCalibration | null;
    }
    | null;
  if (!photo) return c.json({ error: "Photo not found" }, 404);
  if (photo.photo_type !== "measurement" || !photo.storage_path) {
    return c.json(
      { error: "Tag a MeasureCard photo as 'Measurement card' first." },
      422,
    );
  }
  if (photo.measure_calibration?.v !== 1) {
    return c.json(
      {
        error:
          "Calibrate this photo first (POST /measure/calibrate) — the card homography is required to measure.",
      },
      422,
    );
  }

  // Item facts drive the schema + plausibility priors. Tenant-scoped.
  const { data: itemRow } = await supabaseAdmin
    .from("inventory_items")
    .select("id, category, size, measurements, ai_field_sources")
    .eq("id", photo.inventory_item_id)
    .eq("user_id", ownerId)
    .maybeSingle();
  const item = itemRow as
    | {
      id: string;
      category: string | null;
      size: string | null;
      measurements: Record<string, unknown> | null;
      ai_field_sources: Record<string, unknown> | null;
    }
    | null;
  if (!item) return c.json({ error: "Item not found" }, 404);

  const group = measurementGroupFor(item.category);
  const fields = MEASUREMENT_TEMPLATES[group].filter((f) => f.unit === "length");
  if (fields.length === 0) {
    return c.json(
      { error: `No photo-measurable fields for the '${group}' category.` },
      422,
    );
  }

  // Enablement + cap gate, then ONE atomically reserved AI action (US-1581
  // contract — refunded automatically if the vision call throws).
  const quota = await checkQuota(ownerId);
  if (!quota.ok) return c.json(quota.body, quota.status);

  // The vision call reads the photo by URL; detection/snapping read pixels.
  const publicUrl = supabaseAdmin.storage
    .from(bucketForItemPhoto(photo.photo_type))
    .getPublicUrl(photo.storage_path).data.publicUrl;
  const dl = await downloadItemPhoto(photo.storage_path, photo.photo_type);
  if ("error" in dl) {
    return c.json({ error: `Could not load the image: ${dl.error}` }, 502);
  }
  let decoded: Image;
  try {
    decoded = (await Image.decode(
      new Uint8Array(await dl.blob.arrayBuffer()),
    )) as Image;
  } catch {
    return c.json({ error: "Could not decode the image." }, 422);
  }
  const { gray, scale } = toGray(decoded);

  try {
    const result = await withAiAction(ownerId, quota.limit, () =>
      extractMeasurements({
        photoUrl: publicUrl,
        gray,
        grayScale: scale,
        homography: photo.measure_calibration!.homography,
        imageWidth: decoded.width,
        imageHeight: decoded.height,
        group,
        fields,
        sizeLabel: item.size,
      }));

    // Fill-only merge: seller-typed values are never overwritten.
    const merged = mergeMeasurementsFillOnly(
      item.measurements,
      item.ai_field_sources,
      result.measurements,
    );
    if (merged.written.length > 0) {
      const { error: upErr } = await supabaseAdmin
        .from("inventory_items")
        .update({
          measurements: merged.measurements,
          ai_field_sources: merged.aiFieldSources,
        } as never)
        .eq("id", item.id)
        .eq("user_id", ownerId);
      if (upErr) {
        console.error("[flipdesk-measure] extract persist failed:", upErr.message);
      }
    }

    // Spend log (usage parity with the other vision passes).
    try {
      await supabaseAdmin.from("ai_enrichment_log").insert({
        user_id: ownerId,
        inventory_item_id: item.id,
        model: result.model,
        input_kind: "photo",
        tokens_in: result.tokensIn,
        tokens_out: result.tokensOut,
        cost_usd: 0,
        suggested_fields: Object.fromEntries(
          result.measurements.map((m) => [m.key, m.inches]),
        ),
      } as never);
    } catch {
      /* best-effort logging */
    }

    return c.json({
      ok: true,
      group,
      written: merged.written,
      measurements: result.measurements,
      model: result.model,
    });
  } catch (err) {
    if (err instanceof AiQuotaExhaustedError) {
      return c.json({ error: QUOTA_EXHAUSTED_MESSAGE }, 429);
    }
    console.error("[flipdesk-measure] extract failed:", err);
    return c.json(
      { error: err instanceof Error ? err.message : "Measurement extraction failed." },
      502,
    );
  }
});
