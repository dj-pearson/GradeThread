// US-2595: one MeasureCard photo, every measurement — without a second click.
//
// Before this, the card was a three-step manual ritual on the composer: tag the
// shot, press "Detect card", press "Auto-measure". Miss any step and the draft
// generated with an empty measurements block, which is the one thing the card
// exists to prevent. This module is that ritual as a function, so the listing
// generator can run it on the seller's behalf.
//
// Two failures it also fixes, both of which made the manual path useless:
//
//   1. /measure/extract selected a `category` column that does not exist on
//      inventory_items (it lives on the items_full VIEW). PostgREST answered
//      42703, the route read `data` as null and returned "Item not found" —
//      so Auto-measure 404'd on every item, on every client.
//   2. The measurement group was resolved from the coarse vertical, and
//      measurementGroupFor("clothing") is `generic`. Even had the query worked,
//      a blazer would have been measured for "length" and "width" instead of
//      chest / length / shoulder / sleeve. measurementGroupForItem now reads the
//      garment word.
//
// Billing: exactly the metering shape the tag-OCR pass in ai-listing.ts uses —
// the caller owns the reservation, this bundles into it and logs the spend.
// Calibration is deterministic CV and is never billed.

import { Image } from "imagescript";
import { supabaseAdmin } from "./supabase.ts";
import { bucketForItemPhoto, downloadItemPhoto } from "./item-photo-storage.ts";
import { MEASURE_CARD_VERSIONS } from "./measure-card.ts";
import { calibrateMeasurePhoto } from "./measure-detect.ts";
import {
  rescaleCalibration,
  toGray,
  type StoredCalibration,
} from "./measure-calibrate.ts";
import {
  extractMeasurements,
  mergeMeasurementsFillOnly,
} from "./measure-extract.ts";
import {
  MEASUREMENT_TEMPLATES,
  measurementGroupForItem,
  type GarmentDescriptorSource,
  type MeasurementGroup,
} from "./measurement-templates.ts";

/** The inventory_items columns this pass reads. Kept as one string so the two
 *  callers cannot drift into selecting different things. */
export const MEASURE_ITEM_COLUMNS =
  "id, title, size, measurements, ai_field_sources, item_category, garment_category, garment_type";

export interface MeasureItemRow extends GarmentDescriptorSource {
  id: string;
  size: string | null;
  measurements: Record<string, unknown> | null;
  ai_field_sources: Record<string, unknown> | null;
}

export type MeasureAutofillReason =
  | "no_measurement_photo"
  | "no_measurable_fields"
  | "already_measured"
  | "calibration_failed"
  | "extract_failed";

export interface MeasureAutofillResult {
  ran: boolean;
  group: MeasurementGroup;
  /** Keys written onto inventory_items.measurements. */
  written: string[];
  /** Present when nothing ran; null on a successful pass. */
  reason: MeasureAutofillReason | null;
  /** Human-readable detail for a failed calibration (card not found, blur…). */
  message: string | null;
  /** Spend from the one vision call, for the caller's own log line. */
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  /** The item's measurements AFTER the pass — the caller's row is now stale. */
  measurements: Record<string, unknown>;
  /** Ditto for ai_field_sources: the 'ai_measured' provenance the listing
   *  generator reads to earn the "measured with a calibration card" note. */
  aiFieldSources: Record<string, unknown>;
}

function emptyResult(
  group: MeasurementGroup,
  reason: MeasureAutofillReason,
  measurements: Record<string, unknown>,
  aiFieldSources: Record<string, unknown>,
  message: string | null = null,
): MeasureAutofillResult {
  return {
    ran: false,
    group,
    written: [],
    reason,
    message,
    model: null,
    tokensIn: 0,
    tokensOut: 0,
    measurements,
    aiFieldSources,
  };
}

/** The photo-measurable (length-unit) keys for a group. */
export function measurableKeys(group: MeasurementGroup): string[] {
  return MEASUREMENT_TEMPLATES[group]
    .filter((f) => f.unit === "length")
    .map((f) => f.key);
}

/**
 * True when the item is still missing at least one measurable value. A value
 * the seller typed counts as present — this pass fills blanks, it never argues
 * with a tape measure.
 */
export function needsMeasuring(
  group: MeasurementGroup,
  measurements: Record<string, unknown> | null,
): boolean {
  const current = measurements ?? {};
  return measurableKeys(group).some((key) => {
    const v = current[key];
    return v == null || String(v).trim() === "";
  });
}

/**
 * Calibrate (free) and measure (one bundled AI action) the item's MeasureCard
 * photo, writing the results onto inventory_items.
 *
 * Tenant safety (CLAUDE.md US-268): every query is scoped to `ownerId`, and the
 * photo is reached only through the owner-verified item row.
 */
export async function autofillMeasurementsFromCard(
  itemId: string,
  ownerId: string,
  item: MeasureItemRow,
): Promise<MeasureAutofillResult> {
  const group = measurementGroupForItem(item);
  const current = (item.measurements ?? {}) as Record<string, unknown>;
  const currentSources = (item.ai_field_sources ?? {}) as Record<string, unknown>;
  const fields = MEASUREMENT_TEMPLATES[group].filter((f) => f.unit === "length");
  if (fields.length === 0) {
    return emptyResult(group, "no_measurable_fields", current, currentSources);
  }
  if (!needsMeasuring(group, current)) {
    return emptyResult(group, "already_measured", current, currentSources);
  }

  // The item's most recent MeasureCard shot. Scoped through the item, which the
  // caller has already verified against ownerId.
  const { data: photoRows } = await supabaseAdmin
    .from("item_photos")
    .select("id, storage_path, photo_type, measure_calibration")
    .eq("inventory_item_id", itemId)
    .eq("photo_type", "measurement")
    .order("created_at", { ascending: false })
    .limit(1);
  const photo = ((photoRows ?? []) as Array<{
    id: string;
    storage_path: string | null;
    photo_type: string | null;
    measure_calibration: StoredCalibration | null;
  }>)[0];
  if (!photo?.storage_path) {
    return emptyResult(group, "no_measurement_photo", current, currentSources);
  }

  const dl = await downloadItemPhoto(photo.storage_path, photo.photo_type);
  if ("error" in dl) {
    return emptyResult(group, "calibration_failed", current, currentSources, dl.error);
  }
  let decoded: Image;
  try {
    decoded = (await Image.decode(
      new Uint8Array(await dl.blob.arrayBuffer()),
    )) as Image;
  } catch {
    return emptyResult(
      group,
      "calibration_failed",
      current,
      currentSources,
      "Could not decode the image.",
    );
  }
  const { gray, scale } = toGray(decoded);

  // Reuse a cached calibration; compute one when the seller never pressed
  // "Detect card" (which is the whole point of this pass).
  let calibration = photo.measure_calibration?.v === 1
    ? photo.measure_calibration
    : null;
  if (!calibration) {
    const detected = calibrateMeasurePhoto(gray, MEASURE_CARD_VERSIONS);
    if (!detected.ok) {
      return emptyResult(
        group,
        "calibration_failed",
        current,
        currentSources,
        detected.message,
      );
    }
    const rescaled = rescaleCalibration(detected, scale);
    calibration = {
      v: 1,
      cardVersion: rescaled.cardVersion,
      ppi: rescaled.ppi,
      homography: rescaled.homography,
      quality: rescaled.quality,
      computedAt: new Date().toISOString(),
    };
    const { error: calErr } = await supabaseAdmin
      .from("item_photos")
      .update({ measure_calibration: calibration } as never)
      .eq("id", photo.id);
    if (calErr) {
      console.error("[measure-autofill] calibration persist failed:", calErr.message);
      // The homography in hand is still valid — measure with it anyway.
    }
  }

  const publicUrl = supabaseAdmin.storage
    .from(bucketForItemPhoto(photo.photo_type))
    .getPublicUrl(photo.storage_path).data.publicUrl;

  let result;
  try {
    result = await extractMeasurements({
      photoUrl: publicUrl,
      gray,
      grayScale: scale,
      homography: calibration.homography,
      imageWidth: decoded.width,
      imageHeight: decoded.height,
      group,
      fields,
      sizeLabel: item.size,
    });
  } catch (err) {
    console.error("[measure-autofill] extract failed:", err);
    return emptyResult(
      group,
      "extract_failed",
      current,
      currentSources,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Line geometry on the photo (the US-1577 overlay and the US-1574 editor both
  // need to know WHERE each number came from — inches alone can't draw a line).
  const lines: NonNullable<StoredCalibration["lines"]> = {};
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
        measure_calibration: { ...calibration, lines },
      } as never)
      .eq("id", photo.id);
    if (lineErr) {
      console.error("[measure-autofill] line persist failed:", lineErr.message);
    }
  }

  const merged = mergeMeasurementsFillOnly(
    current,
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
      .eq("id", itemId)
      .eq("user_id", ownerId);
    if (upErr) {
      console.error("[measure-autofill] persist failed:", upErr.message);
    }
  }

  try {
    await supabaseAdmin.from("ai_enrichment_log").insert({
      user_id: ownerId,
      inventory_item_id: itemId,
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

  return {
    ran: true,
    group,
    written: merged.written,
    reason: null,
    message: null,
    model: result.model,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    measurements: merged.measurements,
    aiFieldSources: merged.aiFieldSources,
  };
}
