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
import type { Image } from "imagescript";
import { supabaseAdmin } from "../lib/supabase.ts";
import { decodeToImage } from "../lib/image-decode.ts";
import { failSafe } from "../lib/http-errors.ts";
import { encryptMeasureCardAddress } from "../lib/measure-card-pii.ts";
import { downloadItemPhoto, itemPhotoAiUrl } from "../lib/item-photo-storage.ts";
import { MEASURE_CARD_VERSIONS } from "../lib/measure-card.ts";
import {
  extractMeasurements,
  mergeMeasurementsFillOnly,
} from "../lib/measure-extract.ts";
import {
  MEASUREMENT_TEMPLATES,
  measurementGroupForItem,
} from "../lib/measurement-templates.ts";
import {
  autofillMeasurementsFromCard,
  MEASURE_ITEM_COLUMNS,
  type MeasureItemRow,
} from "../lib/measure-autofill.ts";
import { ingestMeasureCardObservations } from "../lib/measurement-ingest.ts";
import {
  cardBBoxPx,
  chooseCropRect,
  renderMeasureOverlay,
  type OverlayLine,
} from "../lib/measure-overlay.ts";
import {
  AiQuotaExhaustedError,
  QUOTA_EXHAUSTED_MESSAGE,
  refundAiAction,
  withAiAction,
} from "../lib/ai-metering.ts";
import { checkQuota } from "./flipdesk-ai.ts";
import {
  readImageDimensions,
  validateImageUpload,
} from "../lib/upload-validation.ts";
import {
  CALIBRATE_REMEDIATION,
  CARD_TEST_LAYOUT_TOLERANCE,
  type CardCorner,
  cardLayoutErrorFraction,
  detectMarkers,
  estimateTiltDeg,
  missingMarkerCorners,
} from "../lib/measure-detect.ts";

export const flipdeskMeasureRoutes = new Hono<{
  Variables: {
    userId: string;
    workspaceOwnerId?: string;
    workspaceRole?: "viewer" | "editor" | "admin" | "owner";
  };
}>();

// The calibration plumbing now lives in lib/measure-calibrate.ts so the
// automatic pass (lib/measure-autofill.ts) can share it without a lib importing
// a route. Re-exported here because this is where callers and tests know to
// look for it.
export {
  MAX_DETECT_DIM,
  rescaleCalibration,
  type StoredCalibration,
  toGray,
} from "../lib/measure-calibrate.ts";
import {
  calibrateAdaptive,
  rescaleCalibration,
  toGray,
  withPreservedLines,
  type StoredCalibration,
} from "../lib/measure-calibrate.ts";

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
      "id, inventory_item_id, storage_path, photo_type, photo_url, measure_calibration, inventory_items!inner(user_id)",
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
    decoded = await decodeToImage(bytes);
  } catch {
    return c.json({ error: "Could not decode the image." }, 422);
  }

  // US-2627: the caller named this photo, so it gets the full resolution climb
  // (evidenceOnly: false) — "no markers at 2000px" on a pair of pants is a
  // resolution problem, not an answer.
  const adaptive = calibrateAdaptive(decoded, MEASURE_CARD_VERSIONS, {
    evidenceOnly: false,
  });
  const scale = adaptive.scale;
  let result = adaptive.result;
  if (!result.ok) {
    if (adaptive.attempted.length > 1) {
      console.warn(
        `[flipdesk-measure] ${photo.id}: card unreadable at ${adaptive.attempted.join("/")}px — ${result.reason}`,
      );
    }
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

  // US-2888: withPreservedLines carries the seller's dragged line placements
  // across a forced re-detect. See its own note for why they stay valid.
  const stored: StoredCalibration = withPreservedLines({
    v: 1,
    cardVersion: result.cardVersion,
    ppi: result.ppi,
    homography: result.homography,
    quality: result.quality,
    computedAt: new Date().toISOString(),
  }, photo.measure_calibration);
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
      "id, inventory_item_id, storage_path, photo_type, photo_url, measure_calibration, inventory_items!inner(user_id)",
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
  //
  // US-2595: this used to select `category`, which does not exist on
  // inventory_items — it is a COALESCE alias on the items_full VIEW. PostgREST
  // answered 42703, `data` came back null, and the next line returned "Item not
  // found" for every item on every client. Auto-measure had never once run in
  // production. Selecting the real columns (and resolving the group from the
  // garment word rather than the coarse vertical) is the whole fix.
  const { data: itemRow, error: itemErr } = await supabaseAdmin
    .from("inventory_items")
    .select(MEASURE_ITEM_COLUMNS)
    .eq("id", photo.inventory_item_id)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (itemErr) {
    console.error("[flipdesk-measure] item load failed:", itemErr.message);
    return c.json({ error: "Could not load the item." }, 500);
  }
  const item = itemRow as MeasureItemRow | null;
  if (!item) return c.json({ error: "Item not found" }, 404);

  const group = measurementGroupForItem(item);
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
  // US-3539: sign private-bucket photos instead of handing the model a dead
  // public link; refuse a path outside the owner's folder.
  const publicUrl = await itemPhotoAiUrl(photo, undefined, { ownerId });
  if (!publicUrl) return c.json({ error: "Could not load the image." }, 422);
  const dl = await downloadItemPhoto(photo.storage_path, photo.photo_type);
  if ("error" in dl) {
    return c.json({ error: `Could not load the image: ${dl.error}` }, 502);
  }
  let decoded: Image;
  try {
    decoded = await decodeToImage(new Uint8Array(await dl.blob.arrayBuffer()));
  } catch {
    return c.json({ error: "Could not decode the image." }, 422);
  }
  const { gray, scale } = toGray(decoded);

  try {
    const result = await withAiAction(ownerId, quota, () =>
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

    // Persist the LINE GEOMETRY on the photo's calibration (additive field)
    // so the US-1577 overlay render and the US-1574 editor know where each
    // measurement sits — inches alone can't draw a line.
    const lines: Record<
      string,
      { e1: [number, number]; e2: [number, number]; inches: number; label: string }
    > = {};
    for (const m of result.measurements) {
      lines[m.key] = {
        e1: m.endpoints[0],
        e2: m.endpoints[1],
        inches: m.inches,
        label: m.label,
      };
    }
    if (Object.keys(lines).length > 0) {
      const { error: lineErr } = await supabaseAdmin
        .from("item_photos")
        .update({
          measure_calibration: { ...photo.measure_calibration, lines },
        } as never)
        .eq("id", photo.id);
      if (lineErr) {
        console.error("[flipdesk-measure] line persist failed:", lineErr.message);
      }
    }

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

      // US-3034: contribute the values that actually landed on the item to the
      // Fit & Measurement Index. Best-effort by contract — it can never fail
      // the seller's own save, which is the primary action here.
      await ingestMeasureCardObservations({
        userId: ownerId,
        itemId: item.id,
        brand: item.brand,
        style: item.style,
        size: item.size,
        group,
        extracted: result.measurements,
        written: merged.written,
      });
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

// US-2595: POST /autofill { item_id } — find the MeasureCard in whatever the
// seller uploaded and measure the garment, in one call.
//
// /calibrate and /extract both take a photo_id the caller already knows is the
// card. Nobody knows that on a bulk-uploaded set: ai-photo-roles classifies to
// front|back|tag|detail|defect and cannot emit 'measurement', so the card sits
// inside a photo labelled something else and every measure surface skips it.
// This endpoint LOOKS for the card instead — it is a printed target with four
// ArUco fiducials, so finding it is deterministic — retags it, and measures.
//
// The action is refunded when no vision call happened (no card in the set, or
// nothing left to measure), so a wasted press never costs a seller anything.
flipdeskMeasureRoutes.post("/autofill", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { item_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemId = typeof body.item_id === "string" ? body.item_id : "";
  if (!itemId) return c.json({ error: "item_id is required" }, 400);

  const { data: itemRow, error: itemErr } = await supabaseAdmin
    .from("inventory_items")
    .select(MEASURE_ITEM_COLUMNS)
    .eq("id", itemId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (itemErr) {
    console.error("[flipdesk-measure] autofill item load failed:", itemErr.message);
    return c.json({ error: "Could not load the item." }, 500);
  }
  const item = itemRow as MeasureItemRow | null;
  if (!item) return c.json({ error: "Item not found" }, 404);

  const quota = await checkQuota(ownerId);
  if (!quota.ok) return c.json(quota.body, quota.status);

  try {
    const result = await withAiAction(ownerId, quota, () =>
      autofillMeasurementsFromCard(itemId, ownerId, item));
    if (!result.ran) await refundAiAction(ownerId);
    return c.json({
      ok: result.ran,
      group: result.group,
      written: result.written,
      measurements: result.measurements,
      reason: result.reason,
      message: result.message,
    });
  } catch (err) {
    if (err instanceof AiQuotaExhaustedError) {
      return c.json({ error: QUOTA_EXHAUSTED_MESSAGE }, 429);
    }
    console.error("[flipdesk-measure] autofill failed:", err);
    return c.json(
      { error: err instanceof Error ? err.message : "Measurement autofill failed." },
      502,
    );
  }
});

// US-1577: POST /overlay { item_id } — render the buyer-facing measurements
// photo: card cropped out (or masked), unbranded lines + inch labels burned
// in, stored as a 'measurement_overlay' item photo (listing-eligible, never
// primary). Regenerating replaces the previous render. Deterministic image
// work only — NOT a billed AI action.
flipdeskMeasureRoutes.post("/overlay", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { item_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemId = typeof body.item_id === "string" ? body.item_id : "";
  if (!itemId) return c.json({ error: "item_id is required" }, 400);

  // Tenant-scoped item (also carries the saved measurement values — the
  // editor-corrected number wins over the extract-time line value).
  const { data: itemRow } = await supabaseAdmin
    .from("inventory_items")
    .select("id, measurements")
    .eq("id", itemId)
    .eq("user_id", ownerId)
    .maybeSingle();
  const item = itemRow as
    | { id: string; measurements: Record<string, unknown> | null }
    | null;
  if (!item) return c.json({ error: "Item not found" }, 404);

  // The item's calibrated measurement photo (owned via the item above).
  const { data: photoRows } = await supabaseAdmin
    .from("item_photos")
    .select("id, storage_path, photo_type, measure_calibration")
    .eq("inventory_item_id", item.id)
    .eq("photo_type", "measurement")
    .not("measure_calibration", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  const photo = ((photoRows ?? []) as Array<{
    id: string;
    storage_path: string | null;
    photo_type: string | null;
    measure_calibration: StoredCalibration | null;
  }>)[0];
  if (!photo?.storage_path || photo.measure_calibration?.v !== 1) {
    return c.json(
      {
        error:
          "Calibrate and extract measurements first — no measured photo to render from.",
      },
      422,
    );
  }
  const calib = photo.measure_calibration;
  const lineMap = calib.lines ?? {};
  const lines: OverlayLine[] = [];
  for (const [key, l] of Object.entries(lineMap)) {
    // The saved item measurement (editor-corrected) wins over extract-time.
    const saved = Number((item.measurements ?? {})[key]);
    // US-2608: ONLY saved measurements are rendered. A line exists for every
    // landmark the model proposed, including the ones the plausibility bands
    // rejected — those are kept so the editor can draw them for the seller to
    // drag, but they are exactly the numbers that must never be burned into the
    // photo a buyer sees. Falling back to `l.inches` here published the
    // rejected value under a picture of a tape measure, which is the most
    // credible a wrong number can possibly look.
    if (!Number.isFinite(saved) || saved <= 0) continue;
    lines.push({ key, label: l.label, e1: l.e1, e2: l.e2, inches: saved });
  }
  if (lines.length === 0) {
    return c.json(
      {
        error: Object.keys(lineMap).length > 0
          // US-2608: lines exist but none is a saved measurement — every one was
          // rejected as implausible. Say that, rather than "run extract first",
          // which sends the seller to re-run the pass that just failed.
          ? "Every measurement on this photo was rejected as implausible — open the editor, drag each line onto the right landmark and save, then regenerate the photo."
          : "No measurement lines yet — run /measure/extract (or place lines in the editor) first.",
      },
      422,
    );
  }

  const dl = await downloadItemPhoto(photo.storage_path, photo.photo_type);
  if ("error" in dl) {
    return c.json({ error: `Could not load the image: ${dl.error}` }, 502);
  }
  let decoded: Image;
  try {
    decoded = await decodeToImage(new Uint8Array(await dl.blob.arrayBuffer()));
  } catch {
    return c.json({ error: "Could not decode the image." }, 422);
  }

  // Card removal geometry: bbox via the inverse homography, then the largest
  // card-free crop; mask fallback when the crop would clip the lines.
  const card = MEASURE_CARD_VERSIONS.find((v) => v.version === calib.cardVersion) ?? null;
  const cardBox = card ? cardBBoxPx(calib.homography, card) : null;
  let crop = cardBox
    ? chooseCropRect(decoded.width, decoded.height, cardBox)
    : null;
  if (crop) {
    const r = crop;
    const inside = (p: [number, number]) =>
      p[0] >= r.x && p[0] <= r.x + r.w && p[1] >= r.y && p[1] <= r.y + r.h;
    const survivors = lines.filter((l) => inside(l.e1) && inside(l.e2));
    if (survivors.length === 0) crop = null;
  }

  let jpeg: Uint8Array;
  try {
    const font = await Deno.readFile(
      new URL("../../assets/Roboto-Bold.ttf", import.meta.url),
    );
    jpeg = await renderMeasureOverlay({
      image: decoded,
      lines,
      crop,
      cardBox,
      font,
    });
  } catch (err) {
    console.error("[flipdesk-measure] overlay render failed:", err);
    return c.json(
      { error: "Could not render the measurements photo from this shot." },
      422,
    );
  }

  // Replace any previous overlay: remove old rows (+ objects, best-effort).
  //
  // US-2625: only rows THIS renderer wrote. The tag picker used to offer
  // "Measurements photo (generated)" as a manual choice, so sellers reasonably
  // applied it to their own MeasureCard shot — and this cleanup would then
  // delete that photo AND its blob on the next render. Matching the filename
  // this route mints (`measurement_overlay_<ts>.jpg`) is what separates "a
  // render I am replacing" from "a photo somebody took".
  const { data: oldRows } = await supabaseAdmin
    .from("item_photos")
    .select("id, storage_path")
    .eq("inventory_item_id", item.id)
    .eq("photo_type", "measurement_overlay")
    .like("storage_path", "%/measurement_overlay_%");
  for (
    const old of (oldRows ?? []) as Array<
      { id: string; storage_path: string | null }
    >
  ) {
    if (old.storage_path) {
      await supabaseAdmin.storage.from("item-photos").remove([old.storage_path])
        .then(() => {}, () => {});
    }
    await supabaseAdmin.from("item_photos").delete().eq("id", old.id);
  }

  const path = `${ownerId}/${item.id}/measurement_overlay_${Date.now()}.jpg`;
  const { error: upErr } = await supabaseAdmin.storage
    .from("item-photos")
    .upload(path, jpeg, { contentType: "image/jpeg", upsert: true });
  if (upErr) {
    return failSafe(
      c,
      502,
      "Could not save the measurements photo.",
      upErr,
      "measure.overlay.upload",
    );
  }
  // item-photo-url-ok: a staging/just-uploaded object in the public bucket,
  // not an item_photos row — there is no private variant to resolve.
  const publicUrl = supabaseAdmin.storage.from("item-photos").getPublicUrl(path)
    .data.publicUrl;

  // Trail the gallery: after every existing photo.
  const { data: maxRow } = await supabaseAdmin
    .from("item_photos")
    .select("sort_order")
    .eq("inventory_item_id", item.id)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sortOrder =
    ((maxRow as { sort_order: number | null } | null)?.sort_order ?? 0) + 1;

  // US-1896: record dimensions for the picture-standards preflight.
  const overlayDims = readImageDimensions(jpeg);
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("item_photos")
    .insert({
      inventory_item_id: item.id,
      photo_type: "measurement_overlay",
      storage_path: path,
      photo_url: publicUrl,
      sort_order: sortOrder,
      width: overlayDims?.width ?? null,
      height: overlayDims?.height ?? null,
    } as never)
    .select("id")
    .maybeSingle();
  if (insErr) {
    return failSafe(
      c,
      502,
      "The photo was saved but we could not attach it to the item.",
      insErr,
      "measure.overlay.attach",
    );
  }

  return c.json({
    ok: true,
    photo_id: (inserted as { id: string } | null)?.id ?? null,
    url: publicUrl,
    lines: lines.length,
    card_removed: crop ? "cropped" : "masked",
  });
});

// ── US-1579: MeasureCard distribution (seller side) ──────────────────
//
// The card itself is free to print (the letter-format PDF ships with the
// frontend); mailed cards are a paid-plan perk fulfilled manually by the
// operator from the /api/admin/measure-cards queue. Addresses are PII: they
// live ONLY in measure_card_requests (deny-all operator table) and are never
// echoed back through this API beyond what the seller themselves submitted.

const ACTIVE_REQUEST_STATUSES = ["requested", "exported"] as const;

/** Sanitized request shape returned to the seller (no address echo). */
function requestSummary(row: {
  id: string;
  status: string;
  card_version: number;
  requested_at: string;
  shipped_at: string | null;
  tracking_number: string | null;
  tracking_carrier: string | null;
}) {
  return {
    id: row.id,
    status: row.status,
    card_version: row.card_version,
    requested_at: row.requested_at,
    shipped_at: row.shipped_at,
    // US-2231: the seller's own parcel. NULL is the normal case (an
    // untracked letter) and the page renders nothing rather than an empty
    // link — see the migration comment for why a placeholder is worse.
    tracking_number: row.tracking_number,
    tracking_carrier: row.tracking_carrier,
  };
}

/** Why the tools page may or may not offer the mail form. */
export type CardRequestEligibilityReason =
  | "ok"
  | "free_plan"
  | "active_request"
  | "viewer";

/**
 * Who may request a mailed card, decided HERE so the page never has to guess.
 *
 * The page used to read the signed-in user's OWN profile.flipdesk_plan while
 * the POST checks the plan of `workspaceOwnerId ?? userId`. So a free member of
 * a paid workspace was told to upgrade, and a paid member of a free workspace
 * filled in an address and met a 403. The inputs are the OWNER's plan, the
 * caller's role in that workspace, and the latest request's status.
 *
 * Order matters: a viewer is refused whatever the plan (blockViewerWrites would
 * 403 the POST), and an active request wins over the plan so a seller who
 * downgraded after requesting still sees the status, not an upgrade pitch.
 */
export function cardRequestEligibility(input: {
  role: string | undefined;
  ownerPlan: string | null | undefined;
  latestStatus: string | null | undefined;
}): { can_request: boolean; reason: CardRequestEligibilityReason } {
  if (input.role === "viewer") return { can_request: false, reason: "viewer" };
  if (
    input.latestStatus &&
    (ACTIVE_REQUEST_STATUSES as readonly string[]).includes(input.latestStatus)
  ) {
    return { can_request: false, reason: "active_request" };
  }
  if ((input.ownerPlan ?? "free") === "free") {
    return { can_request: false, reason: "free_plan" };
  }
  return { can_request: true, reason: "ok" };
}

// The seller's latest mail request (any status) plus whether they may make
// one, both for the WORKSPACE OWNER's tenant — drives the tools page.
//
// MC-10: also the page's "what is waiting" facts, so one GET renders it:
//   waiting_count  the owner's inventory_items at status 'cataloged' (a head
//                  count, scoped .eq("user_id", ownerId)); null if the count
//                  failed, which the page shows as no number rather than zero.
//   card           users.measure_card_source / _version for the owner, so the
//                  page can say which card they have and fold the how-to.
flipdeskMeasureRoutes.get("/card-request", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const [reqRes, ownerRes, waitingRes] = await Promise.all([
    supabaseAdmin
      .from("measure_card_requests")
      .select("id, status, card_version, requested_at, shipped_at, tracking_number, tracking_carrier")
      .eq("owner_user_id", ownerId)
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from("users")
      .select("flipdesk_plan, measure_card_source, measure_card_version")
      .eq("id", ownerId)
      .maybeSingle(),
    supabaseAdmin
      .from("inventory_items")
      .select("id", { count: "exact", head: true })
      .eq("user_id", ownerId)
      .eq("status", "cataloged"),
  ]);
  if (reqRes.error || ownerRes.error) {
    return c.json({ error: "Could not load your request." }, 500);
  }
  if (waitingRes.error) {
    console.error("[measure-card] waiting count failed:", waitingRes.error.message);
  }
  const data = reqRes.data as Parameters<typeof requestSummary>[0] | null;
  const owner = ownerRes.data as {
    flipdesk_plan: string | null;
    measure_card_source: string | null;
    measure_card_version: number | null;
  } | null;
  return c.json({
    request: data ? requestSummary(data) : null,
    eligibility: cardRequestEligibility({
      role: c.get("workspaceRole"),
      ownerPlan: owner?.flipdesk_plan,
      latestStatus: data?.status ?? null,
    }),
    waiting_count: waitingRes.error ? null : (waitingRes.count ?? 0),
    card: {
      source: owner?.measure_card_source ?? null,
      version: owner?.measure_card_version ?? null,
    },
  });
});

// US-2540: the countries a card can actually be posted to.
//
// MIRRORED in src/pages/flipdesk/measure-card.tsx (MAIL_COUNTRIES), the way
// this repo shares a constant across the two builds; a guard test compares the
// two lists. The server needs its own copy because a request can reach this
// endpoint without the page — and a fulfilment run that receives an address in
// a country nobody posts to is the same defect the story is about, arriving
// from the other direction.
export const MAIL_COUNTRIES = ["US", "CA", "GB", "IE", "AU", "NZ"] as const;

// MC-02: the longest value each address field may hold. MIRRORED in
// src/pages/flipdesk/measure-card.tsx (maxLength on each input); a Vitest
// guard compares the two. Values over the limit are REFUSED, not shortened:
// a card mailed to a silently truncated address is a lost card.
export const MAIL_FIELD_LIMITS = {
  ship_name: 120,
  address_line1: 200,
  address_line2: 200,
  city: 120,
  state: 80,
  postal_code: 20,
} as const;

// MC-08: the countries whose addresses need a state / province / region line.
// Elsewhere (GB, IE, NZ) the field is optional and stored as ''. MIRRORED in
// src/pages/flipdesk/measure-card.tsx; a Vitest guard compares them.
export const STATE_REQUIRED_COUNTRIES = ["US", "CA", "AU"] as const;

// A cell starting with one of these is read as a formula by Excel and Sheets
// (OWASP CSV injection). The fulfilment CSV defends stored rows on export too
// (admin-measure-cards.ts csvCell); refusing them here keeps new ones out.
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const FORMULA_CHECKED_FIELDS = [
  "ship_name",
  "address_line1",
  "address_line2",
  "city",
] as const;

export type MailAddress = {
  -readonly [K in keyof typeof MAIL_FIELD_LIMITS]: string;
} & { country: string };

export type MailAddressCheck =
  | { ok: true; value: MailAddress }
  | { ok: false; error: string; fields?: Record<string, string> };

/** Validate a card-request body. Trims, never slices. */
export function validateMailAddress(
  body: Record<string, unknown>,
): MailAddressCheck {
  const raw = (key: string): string =>
    typeof body[key] === "string" ? (body[key] as string).trim() : "";
  const value = {} as MailAddress;
  const tooLong: Record<string, string> = {};
  for (const [key, max] of Object.entries(MAIL_FIELD_LIMITS)) {
    const v = raw(key);
    if (v.length > max) tooLong[key] = `max ${max} characters`;
    value[key as keyof typeof MAIL_FIELD_LIMITS] = v;
  }
  if (Object.keys(tooLong).length > 0) {
    return {
      ok: false,
      error: "Some address fields are too long. Shorten them and try again.",
      fields: tooLong,
    };
  }
  const country = raw("country").toUpperCase() || "US";
  const needsState = (STATE_REQUIRED_COUNTRIES as readonly string[]).includes(
    country,
  );
  if (
    !value.ship_name || !value.address_line1 || !value.city ||
    (needsState && !value.state) || !value.postal_code
  ) {
    return {
      ok: false,
      error: needsState
        ? "Name, address, city, state, and postal code are required."
        : "Name, address, city, and postal code are required.",
    };
  }
  if (!/^[A-Z]{2}$/.test(country)) {
    return {
      ok: false,
      error: "Country must be a two-letter code, like US or GB.",
      fields: { country: "two-letter code" },
    };
  }
  if (!(MAIL_COUNTRIES as readonly string[]).includes(country)) {
    return {
      ok: false,
      error: "We can't post a card to that country yet. The print-at-home PDF " +
        "works with the same pipeline.",
    };
  }
  const formula: Record<string, string> = {};
  for (const key of FORMULA_CHECKED_FIELDS) {
    if (FORMULA_LEAD.test(value[key])) {
      formula[key] = "cannot start with = + - or @";
    }
  }
  if (Object.keys(formula).length > 0) {
    return {
      ok: false,
      error: "Names and address lines can't start with =, +, - or @.",
      fields: formula,
    };
  }
  value.country = country;
  return { ok: true, value };
}

// Request a mailed card. Paid plans only; one active request per seller.
flipdeskMeasureRoutes.post("/card-request", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const checked = validateMailAddress(body);
  if (!checked.ok) {
    return c.json(
      checked.fields
        ? { error: checked.error, fields: checked.fields }
        : { error: checked.error },
      400,
    );
  }
  const {
    ship_name: shipName,
    address_line1: line1,
    address_line2: line2,
    city,
    state,
    postal_code: postal,
    country,
  } = checked.value;

  // Plan gate (server-side; the page also hides the form for free plans).
  const { data: userRow } = await supabaseAdmin
    .from("users")
    .select("flipdesk_plan")
    .eq("id", ownerId)
    .maybeSingle();
  const plan = (userRow as { flipdesk_plan: string | null } | null)
    ?.flipdesk_plan ?? "free";
  if (plan === "free") {
    return c.json(
      {
        error:
          "Mailed MeasureCards are a paid-plan perk. Download the free print-at-home PDF, or upgrade to have one mailed.",
      },
      403,
    );
  }

  // Abuse guard: one active (unshipped) request per seller. The partial
  // unique index backstops this check under concurrency.
  const { data: active } = await supabaseAdmin
    .from("measure_card_requests")
    .select("id, status")
    .eq("owner_user_id", ownerId)
    .in("status", [...ACTIVE_REQUEST_STATUSES])
    .limit(1);
  if ((active ?? []).length > 0) {
    return c.json(
      { error: "You already have a card request in progress." },
      409,
    );
  }

  // US-2417 AC2: the street lines go in as ciphertext, bound to ownerId as the
  // AES-GCM AAD. `state` and `country` stay readable so the fulfilment export
  // can still filter by region without decrypting every row.
  //
  // Encrypting HERE rather than after the insert is deliberate: an insert that
  // wrote plaintext and then updated it would leave the address readable in the
  // WAL and in any replica that saw the first version, which is most of what a
  // dump-theft scenario actually covers.
  let encrypted;
  try {
    encrypted = await encryptMeasureCardAddress(ownerId, {
      ship_name: shipName,
      address_line1: line1,
      address_line2: line2 || null,
      city,
      postal_code: postal,
    });
  } catch (err) {
    // Fail the request rather than falling back to plaintext. A misconfigured
    // EDGE_ENCRYPTION_KEY must not silently downgrade storage for the one
    // column set this story exists to protect.
    console.error("[measure-card] address encryption failed:", err);
    return c.json({ error: "Could not save your request. Try again shortly." }, 503);
  }

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("measure_card_requests")
    .insert({
      owner_user_id: ownerId,
      plan_key: plan,
      card_version: MEASURE_CARD_VERSIONS[MEASURE_CARD_VERSIONS.length - 1]
        .version,
      ...encrypted,
      state,
      country,
    } as never)
    .select("id, status, card_version, requested_at, shipped_at, tracking_number, tracking_carrier")
    .maybeSingle();
  if (insErr) {
    // 23505 = the partial unique index lost the race — same answer as above.
    if (insErr.code === "23505") {
      return c.json(
        { error: "You already have a card request in progress." },
        409,
      );
    }
    return c.json({ error: "Could not save your request." }, 500);
  }
  return c.json(
    {
      ok: true,
      request: requestSummary(
        inserted as Parameters<typeof requestSummary>[0],
      ),
    },
    201,
  );
});

// Stamp the profile card-version record when the seller downloads the PDF
// (US-1579 AC4). A mailed card ('mail', stamped at ship time) outranks a
// download and is never downgraded.
flipdeskMeasureRoutes.post("/card-downloaded", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const version =
    MEASURE_CARD_VERSIONS[MEASURE_CARD_VERSIONS.length - 1].version;
  const { data: userRow } = await supabaseAdmin
    .from("users")
    .select("measure_card_source")
    .eq("id", ownerId)
    .maybeSingle();
  const source = (userRow as { measure_card_source: string | null } | null)
    ?.measure_card_source;
  if (source !== "mail") {
    await supabaseAdmin
      .from("users")
      .update({
        measure_card_version: version,
        measure_card_source: "download",
      } as never)
      .eq("id", ownerId);
  }
  return c.json({ ok: true, card_version: version });
});

// ── MC-12: "Test my card" ─────────────────────────────────────────────
//
// POST /api/flipdesk/measure/card-test  (multipart, field "photo")
//   -> { ok, markers_found, missing_corner?, missing_corners, card_version,
//        residual_in, tilt_deg, layout_error_pct, warning?, scale_checked:false,
//        scale_note, reason?, message? }
//
// A test shot of the seller's printed card, run through the same detector the
// measure passes use. Nothing is stored and nothing is billed (no model call);
// the photo never leaves this request. Rate-limited with the rest of
// /api/flipdesk/measure/* in main.ts.
//
// US-268: this route reads and writes no tenant table. The only input is the
// uploaded bytes, which are validated by magic bytes before decode (US-276).

/** The honest limit of a card-only photo, sent with every answer. */
export const CARD_TEST_SCALE_NOTE =
  "A photo of the card alone cannot tell a 100% print from a scaled one. " +
  "Check it once with the credit-card box printed on the card.";

export interface CardTestResult {
  ok: boolean;
  markers_found: number;
  missing_corner?: CardCorner;
  missing_corners: CardCorner[];
  card_version: number | null;
  residual_in: number | null;
  tilt_deg: number | null;
  layout_error_pct: number | null;
  warning?: string;
  reason?: string;
  message?: string;
  scale_checked: false;
  scale_note: string;
}

/** Run the card test on a decoded image. Pure apart from CPU; exported for tests. */
export function runCardTest(img: Image): CardTestResult {
  const adaptive = calibrateAdaptive(img, MEASURE_CARD_VERSIONS, {
    evidenceOnly: false,
  });
  const result = adaptive.result;
  const base = { scale_checked: false as const, scale_note: CARD_TEST_SCALE_NOTE };
  if (!result.ok) {
    const found = detectMarkers(adaptive.gray, MEASURE_CARD_VERSIONS);
    const { cardVersion, missing } = missingMarkerCorners(
      found.map((m) => m.id),
      MEASURE_CARD_VERSIONS,
    );
    const r = Number.isFinite(result.quality.reprojResidualIn)
      ? result.quality.reprojResidualIn
      : null;
    return {
      ok: false,
      markers_found: found.length,
      ...(missing.length === 1 ? { missing_corner: missing[0] } : {}),
      missing_corners: missing,
      card_version: cardVersion,
      residual_in: r === null ? null : Math.round(r * 1000) / 1000,
      tilt_deg: estimateTiltDeg(found, MEASURE_CARD_VERSIONS[0]!),
      layout_error_pct: null,
      reason: result.reason,
      message: missing.length === 1 && result.reason === "card_not_fully_visible"
        ? `The ${missing[0]} square is missing or covered. ` +
          CALIBRATE_REMEDIATION.card_not_fully_visible
        : result.message,
      ...base,
    };
  }
  const card = MEASURE_CARD_VERSIONS.find((v) => v.version === result.cardVersion) ??
    MEASURE_CARD_VERSIONS[0]!;
  const layout = cardLayoutErrorFraction(result.homography, result.markers, card);
  const layoutPct = Math.round(layout * 10000) / 100;
  return {
    ok: true,
    markers_found: result.markers.length,
    missing_corners: [],
    card_version: result.cardVersion,
    residual_in: Math.round(result.quality.reprojResidualIn * 1000) / 1000,
    tilt_deg: estimateTiltDeg(result.markers, card),
    layout_error_pct: layoutPct,
    ...(layout > CARD_TEST_LAYOUT_TOLERANCE
      ? {
        warning:
          `The squares are ${layoutPct}% off where the card says they should be. ` +
          "Reprint at 100% on flat paper, or shoot it again flatter.",
      }
      : {}),
    ...base,
  };
}

flipdeskMeasureRoutes.post("/card-test", async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json(
      { error: "Invalid form data. Expected multipart/form-data." },
      400,
    );
  }
  const file = form.get("photo");
  if (!(file instanceof File) || file.size === 0) {
    return c.json({ error: "Add a photo of your card." }, 400);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const verdict = validateImageUpload(bytes, { allow: ["jpeg", "png", "webp"] });
  if (!verdict.ok) return c.json({ error: verdict.reason }, 400);

  let decoded: Image;
  try {
    decoded = await decodeToImage(bytes);
  } catch {
    return c.json({ error: "Could not read that image." }, 422);
  }
  return c.json(runCardTest(decoded));
});

// US-1580: correction telemetry — the production evidence behind the word
// "accurate". The overlay editor posts, per saved measurement that the auto
// pass had proposed, the delta between proposal and the seller's final value.
// Deltas/class/confidence ONLY (no photo content, no free text); rows land in
// the deny-all measure_corrections operator table and are read via the
// documented SQL in vault/20-domain/measurement-accuracy.md. Fire-and-forget from the client;
// never billed.
flipdeskMeasureRoutes.post("/correction", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: {
    garment_class?: unknown;
    card_version?: unknown;
    corrections?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const garmentClass = typeof body.garment_class === "string"
    ? body.garment_class.slice(0, 40)
    : "";
  if (!garmentClass) return c.json({ error: "garment_class is required" }, 400);
  const cardVersion = Number.isInteger(body.card_version)
    ? (body.card_version as number)
    : null;

  const list = Array.isArray(body.corrections) ? body.corrections : [];
  const rows: Array<Record<string, unknown>> = [];
  const plausible = (v: number) => Number.isFinite(v) && v > 0 && v < 200;
  for (const raw of list.slice(0, 20)) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as {
      key?: unknown;
      proposed?: unknown;
      final?: unknown;
      confidence?: unknown;
      flagged?: unknown;
    };
    const key = typeof o.key === "string" ? o.key.slice(0, 40) : "";
    const proposed = Number(o.proposed);
    const final = Number(o.final);
    if (!key || !plausible(proposed) || !plausible(final)) continue;
    const confidence = Number(o.confidence);
    rows.push({
      owner_user_id: ownerId,
      garment_class: garmentClass,
      measurement_key: key,
      proposed_inches: proposed,
      final_inches: final,
      delta_inches: Math.round((final - proposed) * 100) / 100,
      confidence: Number.isFinite(confidence)
        ? Math.max(0, Math.min(1, confidence))
        : null,
      was_flagged: o.flagged === true,
      card_version: cardVersion,
    });
  }
  if (rows.length === 0) return c.json({ ok: true, recorded: 0 });

  const { error } = await supabaseAdmin
    .from("measure_corrections")
    .insert(rows as never);
  if (error) {
    console.error("[flipdesk-measure] correction telemetry failed:", error.message);
    // Telemetry must never surface as a user-facing failure.
  }
  return c.json({ ok: true, recorded: rows.length });
});
