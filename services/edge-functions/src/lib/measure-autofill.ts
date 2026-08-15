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

/** How many of an item's photos the card scan will open. Sellers upload sets of
 *  8-15; the card shot is normally among the first few, and an unbounded scan
 *  would make one bad item pay for every other item's generation latency. */
export const MAX_CARD_SCAN = 12;

/** Photo types that cannot be the calibration frame and are never opened:
 *  the render we produced FROM one, and the seller-private types the AI is
 *  forbidden to read at all (US-1549). */
const NEVER_THE_CARD = new Set([
  "measurement_overlay",
  "internal",
  "certificate",
]);

interface CardPhoto {
  photo: {
    id: string;
    storage_path: string;
    photo_type: string | null;
  };
  calibration: StoredCalibration;
  decoded: Image;
  gray: ReturnType<typeof toGray>["gray"];
  scale: number;
}

/**
 * Find the MeasureCard in the item's photos — by LOOKING for it.
 *
 * The card is a standardized printed target with four ArUco fiducials at known
 * positions, so "is this the calibration frame" is a decidable question, not a
 * guess. Requiring the seller to tag the shot 'measurement' first is what made
 * the whole feature dead weight in practice: a bulk-uploaded set is classified
 * by ai-photo-roles, whose vocabulary is front|back|tag|detail|defect — it has
 * no 'measurement' at all and never could assign one. So every set uploaded the
 * normal way arrived with the card sitting in a photo labelled 'front' or
 * 'detail', and the measure pipeline, which filters on photo_type, saw nothing.
 *
 * Detection is deterministic CV and is never billed, so scanning costs image
 * bandwidth and nothing else. The first photo whose four markers resolve wins;
 * it is retagged 'measurement' (which also keeps the branded card out of the
 * listing gallery, exactly as a manual tag would) and its calibration is stored,
 * so this runs once per item and every later pass reads the cache.
 */
async function findCardPhoto(
  itemId: string,
): Promise<CardPhoto | { reason: MeasureAutofillReason; message: string | null }> {
  const { data: rows } = await supabaseAdmin
    .from("item_photos")
    .select("id, storage_path, photo_type, measure_calibration, sort_order")
    .eq("inventory_item_id", itemId)
    .order("sort_order", { ascending: true });
  const all = ((rows ?? []) as Array<{
    id: string;
    storage_path: string | null;
    photo_type: string | null;
    measure_calibration: StoredCalibration | null;
  }>).filter((p) => p.storage_path && !NEVER_THE_CARD.has(p.photo_type ?? ""));

  // Anything already tagged (or already calibrated) is tried first — that is
  // the cache hit, and it costs one download instead of twelve.
  const known = all.filter(
    (p) => p.photo_type === "measurement" || p.measure_calibration?.v === 1,
  );
  const rest = all.filter((p) => !known.includes(p));
  const candidates = [...known, ...rest].slice(0, MAX_CARD_SCAN);
  if (candidates.length === 0) {
    return { reason: "no_measurement_photo", message: null };
  }
  if (all.length > candidates.length) {
    console.warn(
      `[measure-autofill] item ${itemId}: scanning ${candidates.length} of ${all.length} photos for the card`,
    );
  }

  let lastMessage: string | null = null;
  for (const p of candidates) {
    const dl = await downloadItemPhoto(p.storage_path!, p.photo_type);
    if ("error" in dl) {
      lastMessage = dl.error;
      continue;
    }
    let decoded: Image;
    try {
      decoded = (await Image.decode(
        new Uint8Array(await dl.blob.arrayBuffer()),
      )) as Image;
    } catch {
      lastMessage = "Could not decode the image.";
      continue;
    }
    const { gray, scale } = toGray(decoded);

    // A stored calibration is only trusted on a photo that is actually tagged
    // as the card — otherwise it is a leftover from a retag and must be re-run.
    if (p.photo_type === "measurement" && p.measure_calibration?.v === 1) {
      return {
        photo: { id: p.id, storage_path: p.storage_path!, photo_type: p.photo_type },
        calibration: p.measure_calibration,
        decoded,
        gray,
        scale,
      };
    }

    const detected = calibrateMeasurePhoto(gray, MEASURE_CARD_VERSIONS);
    if (!detected.ok) {
      // "card_not_found" on an ordinary garment shot is the expected answer, not
      // a failure — only carry a message forward when the card WAS seen and
      // something else went wrong (blur, partial card), because that is the one
      // a seller can act on.
      if (detected.reason !== "card_not_found") lastMessage = detected.message;
      continue;
    }
    const rescaled = rescaleCalibration(detected, scale);
    const calibration: StoredCalibration = {
      v: 1,
      cardVersion: rescaled.cardVersion,
      ppi: rescaled.ppi,
      homography: rescaled.homography,
      quality: rescaled.quality,
      computedAt: new Date().toISOString(),
    };
    // Retag + cache. The retag is what makes this one-and-done: the composer's
    // editor, the overlay render and the publish path all filter on
    // photo_type, so after this the card behaves exactly as a hand-tagged one.
    const patch: Record<string, unknown> = { measure_calibration: calibration };
    if (p.photo_type !== "measurement") patch.photo_type = "measurement";
    const { error: upErr } = await supabaseAdmin
      .from("item_photos")
      .update(patch as never)
      .eq("id", p.id);
    if (upErr) {
      console.error("[measure-autofill] card tag/calibration persist failed:", upErr.message);
      // The homography in hand is still valid — measure with it anyway.
    }
    return {
      photo: { id: p.id, storage_path: p.storage_path!, photo_type: "measurement" },
      calibration,
      decoded,
      gray,
      scale,
    };
  }
  return {
    reason: lastMessage ? "calibration_failed" : "no_measurement_photo",
    message: lastMessage,
  };
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
  const result = await runAutofill(itemId, ownerId, item);
  // US-2607: record WHAT HAPPENED, always. Every step of this pass fails
  // softly by design — a bad card photo must never block a listing — and the
  // sum of those soft failures was a feature that produced no measurements and
  // no explanation, on any surface, for anyone. Three separate debugging rounds
  // went into guessing which step was silent. The outcome now rides on the item
  // so the composer can say "no card found in these 9 photos" instead of
  // showing an empty box.
  try {
    await supabaseAdmin
      .from("inventory_items")
      .update({
        ai_field_sources: {
          ...result.aiFieldSources,
          [MEASURE_PASS_KEY]: {
            reason: result.reason,
            message: result.message,
            group: result.group,
            written: result.written,
            ranAt: new Date().toISOString(),
          },
        },
      } as never)
      .eq("id", itemId)
      .eq("user_id", ownerId);
  } catch (err) {
    console.error("[measure-autofill] outcome record failed:", err);
  }
  return result;
}

/** `ai_field_sources` key holding the last pass's outcome (US-2607). Not a
 *  field provenance entry — it is namespaced with a leading underscore so the
 *  provenance readers, which all match on `measurements.<key>`, skip it. */
export const MEASURE_PASS_KEY = "measurements._pass";

async function runAutofill(
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

  const found = await findCardPhoto(itemId);
  if ("reason" in found) {
    return emptyResult(group, found.reason, current, currentSources, found.message);
  }
  const { photo, calibration, decoded, gray, scale } = found;

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
