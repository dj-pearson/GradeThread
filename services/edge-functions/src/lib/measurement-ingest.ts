// US-3034: feed MeasureCard extractions into the Fit & Measurement Index.
//
// `measure-extract.ts` produces the highest-quality garment measurements
// available anywhere, including from the brands: real inches on the card plane
// via the US-1572 calibration homography, with a per-field model confidence and
// a `flagged` bit for anything outside the size prior. Until this file they
// landed on `inventory_items.measurements` and stopped there.
//
// ── WHAT GETS INGESTED, AND WHAT DOES NOT ──────────────────────────────────
//
// Only fields that were actually WRITTEN onto the item, and only if the
// extractor did not flag them.
//
//   Not written means the fill-only merge found a seller-typed value already
//   there. The seller's number is what the listing carries and what they stand
//   behind; the model's rejected alternative is not a measurement of record and
//   must not quietly outvote it in the aggregate.
//
//   Flagged means the extractor itself distrusts the value — outside the size
//   prior, or low landmark confidence. A number the producer distrusts must
//   never become a published median. This is the same instinct as the
//   `all_rejected` outcome in measure-autofill.ts: a pass can succeed and save
//   nothing, and that is correct behaviour rather than a failure.
//
// ── THE TWO KEYS THAT DECIDE WHETHER ANY OF THIS WORKS ─────────────────────
//
// A cohort is (brand, style, department, group, size, field). Get either key
// wrong and the corpus fragments into cohorts too small to clear the sample
// floor, which reads as "we do not have coverage" rather than as a bug.
//
//   BRAND: `brandKeyForRaw`, never `brandKey`. This is the US-2692 lesson
//   verbatim — the read side keys on `brandKey(canonicalizeBrand(brand))`, so
//   keying the RAW brand puts "Levi" and "Lulu" under keys nothing ever asks
//   for. That bug learned observations into a namespace no lookup reads, and
//   this file would reproduce it exactly.
//
//   SIZE: `normalizeSizeLabel`, which owns the "W34 L32" / "34x32" collapse and
//   the refusals that go with it (US-3033).
//
// A row with no resolvable brand or no usable size is DROPPED, not stored under
// a blank key. An empty `style_key` is fine and expected — it rolls up to a
// brand-level cohort, which is a weaker page but a real one. An empty brand is
// not the same thing: it would merge every unbranded garment on the platform
// into one meaningless bucket.

import { supabaseAdmin } from "./supabase.ts";
import { brandKeyForRaw } from "./brand-normalize.ts";
import { resolveBrandKnowledgePack, type BrandStyleKnowledge } from "./brand-knowledge.ts";
import { normalizeSizeLabel, normalizeDepartment, systemFromLabel } from "./size-systems.ts";
import {
  LISTING_TEXT_CONFIDENCE,
  parseMeasurementsFromText,
} from "./measurement-text-parse.ts";
import type { ExtractedMeasurement } from "./measure-extract.ts";
import type { MeasurementGroup } from "./measurement-templates.ts";

/** Confidence floor below which an extraction is not worth keeping at all. */
export const MIN_INGEST_CONFIDENCE = 0.5;

export interface MeasurementCohort {
  brandKey: string;
  styleKey: string;
  department: string;
  measurementGroup: string;
  sizeLabel: string;
  sizeSystem: string | null;
}

export interface MeasurementObservationRow {
  user_id: string;
  item_id: string;
  brand_key: string;
  style_key: string;
  department: string;
  measurement_group: string;
  size_label: string;
  size_system: string | null;
  field_key: string;
  inches: number;
  source: "measurecard" | "listing_text";
  confidence: number | null;
}

/**
 * The stable join form of a style name. Mirrors `styleMatchKey` in
 * garment-baselines.ts, which is what already decides "the same style" for the
 * grading pipeline — two spellings of one style must not become two cohorts for
 * the same reason they must not become two baselines.
 */
export function styleKeyFor(v: string | null | undefined): string {
  if (!v) return "";
  return v.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Resolve a garment to its cohort, or null when it cannot join one.
 *
 * Pure: the caller supplies the brand's known styles, so this is testable
 * without a database and the matching rule stays readable in one place.
 */
export function resolveMeasurementCohort(args: {
  brand: string | null | undefined;
  style: string | null | undefined;
  size: string | null | undefined;
  group: MeasurementGroup;
  styles: readonly BrandStyleKnowledge[];
}): MeasurementCohort | null {
  const brandKey = brandKeyForRaw(args.brand);
  if (!brandKey) return null;

  const sizeLabel = normalizeSizeLabel(args.size, args.group);
  if (!sizeLabel) return null;

  // Match the item's free-text style against the brand's known styles, by the
  // same key the grading pipeline uses. Aliases count: a brand_styles row lists
  // them precisely so "501xx" and "501 XX" reach one entry.
  const wanted = styleKeyFor(args.style);
  const matched = wanted
    ? args.styles.find((s) =>
      styleKeyFor(s.styleName) === wanted ||
      s.aliases.some((a) => styleKeyFor(a) === wanted)
    )
    : undefined;

  return {
    brandKey,
    // An unmatched style is deliberately dropped rather than stored as typed.
    // Free text would mint a cohort per spelling, and a cohort of one is worse
    // than the brand-level rollup it would otherwise have joined.
    styleKey: matched ? styleKeyFor(matched.styleName) : "",
    department: (matched?.department && normalizeDepartment(matched.department)) || "",
    measurementGroup: args.group,
    sizeLabel,
    sizeSystem: systemFromLabel(sizeLabel),
  };
}

/**
 * The rows a MeasureCard pass contributes. Pure, so the two filters that decide
 * what the index believes are unit-testable without a database.
 *
 * `written` is the fill-only merge's answer about which keys actually landed on
 * the item.
 */
export function buildMeasureCardObservations(args: {
  userId: string;
  itemId: string;
  cohort: MeasurementCohort;
  extracted: readonly ExtractedMeasurement[];
  written: readonly string[];
}): MeasurementObservationRow[] {
  const writtenKeys = new Set(args.written);
  const rows: MeasurementObservationRow[] = [];

  for (const m of args.extracted) {
    if (!writtenKeys.has(m.key)) continue;
    if (m.flagged) continue;
    if (!Number.isFinite(m.inches) || m.inches <= 0) continue;
    if (typeof m.confidence === "number" && m.confidence < MIN_INGEST_CONFIDENCE) continue;

    rows.push({
      user_id: args.userId,
      item_id: args.itemId,
      brand_key: args.cohort.brandKey,
      style_key: args.cohort.styleKey,
      department: args.cohort.department,
      measurement_group: args.cohort.measurementGroup,
      size_label: args.cohort.sizeLabel,
      size_system: args.cohort.sizeSystem,
      field_key: m.key,
      inches: Math.round(m.inches * 100) / 100,
      source: "measurecard",
      confidence: typeof m.confidence === "number" ? m.confidence : null,
    });
  }

  return rows;
}

/**
 * The rows a parsed listing description contributes.
 *
 * Same cohort, different evidence. Pure, and separate from the MeasureCard
 * builder rather than a flag on it, because the two sources are filtered on
 * different things and folding them together is how one source quietly
 * inherits the other's rules.
 */
export function buildListingTextObservations(args: {
  userId: string;
  itemId: string;
  cohort: MeasurementCohort;
  parsed: readonly { key: string; inches: number }[];
}): MeasurementObservationRow[] {
  return args.parsed
    .filter((p) => Number.isFinite(p.inches) && p.inches > 0)
    .map((p) => ({
      user_id: args.userId,
      item_id: args.itemId,
      brand_key: args.cohort.brandKey,
      style_key: args.cohort.styleKey,
      department: args.cohort.department,
      measurement_group: args.cohort.measurementGroup,
      size_label: args.cohort.sizeLabel,
      size_system: args.cohort.sizeSystem,
      field_key: p.key,
      inches: Math.round(p.inches * 100) / 100,
      source: "listing_text" as const,
      confidence: LISTING_TEXT_CONFIDENCE,
    }));
}

/**
 * Drop any field a MeasureCard pass already measured.
 *
 * The unique key is (item_id, field_key), so without this a description saying
 * "chest 22" would UPSERT straight over a calibrated card-plane measurement of
 * the same garment — replacing the best evidence in the system with a
 * hand-tape number, silently, on every sync.
 *
 * The reverse is deliberately not true: a card pass DOES overwrite parsed text,
 * because that is a strict upgrade. Evidence quality only ratchets up.
 *
 * Pure and exported for the test.
 */
export function dropFieldsMeasuredByCard(
  rows: MeasurementObservationRow[],
  stored: readonly { field_key: string; source: string }[],
): MeasurementObservationRow[] {
  const byCard = new Set(
    stored.filter((s) => s.source === "measurecard").map((s) => s.field_key),
  );
  return rows.filter((r) => !byCard.has(r.field_key));
}

/**
 * Decide, per field, whether a stored style beats the incoming one.
 *
 * Pure so the rule is testable on its own: an empty incoming style keeps the
 * stored style and its department; anything else is left alone. Exported for
 * the test, not for callers.
 */
export function mergeResolvedStyle(
  rows: MeasurementObservationRow[],
  stored: readonly { field_key: string; style_key: string; department: string }[],
): void {
  const byField = new Map(stored.map((s) => [s.field_key, s]));
  for (const row of rows) {
    if (row.style_key !== "") continue;
    const prior = byField.get(row.field_key);
    if (!prior || prior.style_key === "") continue;
    row.style_key = prior.style_key;
    row.department = prior.department;
  }
}

/** The read half of the rule above. Best-effort: a failure leaves rows as-is. */
async function carryForwardResolvedStyle(
  rows: MeasurementObservationRow[],
): Promise<void> {
  if (rows.every((r) => r.style_key !== "")) return;
  const itemId = rows[0]?.item_id;
  if (!itemId) return;

  const { data, error } = await supabaseAdmin
    .from("garment_measurements")
    .select("field_key, style_key, department")
    .eq("item_id", itemId);
  if (error || !data) return;

  mergeResolvedStyle(
    rows,
    data as unknown as { field_key: string; style_key: string; department: string }[],
  );
}

/**
 * Write a MeasureCard pass into the index. Best-effort by contract.
 *
 * NEVER throws and never surfaces an error to the caller. The seller's own
 * measurement save is the primary action; contributing to a corpus they are not
 * waiting on must not be able to fail it. A failure here is logged and the
 * garment is simply absent from the aggregate, which the sample floor already
 * knows how to handle.
 *
 * Returns the number of rows written, for the caller's log line.
 */
export async function ingestMeasureCardObservations(args: {
  userId: string;
  itemId: string;
  brand: string | null | undefined;
  style: string | null | undefined;
  size: string | null | undefined;
  group: MeasurementGroup;
  extracted: readonly ExtractedMeasurement[];
  written: readonly string[];
}): Promise<number> {
  try {
    if (args.written.length === 0) return 0;

    const brandKey = brandKeyForRaw(args.brand);
    if (!brandKey) return 0;

    const pack = await resolveBrandKnowledgePack(args.brand);
    const cohort = resolveMeasurementCohort({
      brand: args.brand,
      style: args.style,
      size: args.size,
      group: args.group,
      styles: pack?.styles ?? [],
    });
    if (!cohort) return 0;

    const rows = buildMeasureCardObservations({
      userId: args.userId,
      itemId: args.itemId,
      cohort,
      extracted: args.extracted,
      written: args.written,
    });
    if (rows.length === 0) return 0;

    // One garment counts ONCE per field: re-measuring updates its row rather
    // than adding a second one. The unique index on (item_id, field_key) is
    // what makes this an update; naming it here keeps the two in step.
    //
    // An update carries the identity too, so it can DOWNGRADE one — which is a
    // real defect found by running this against a database rather than a
    // fixture. A second pass on the same garment whose style string failed to
    // match wrote style_key '' over a stored '550', moving the observation out
    // of the style cohort and into the brand-level one. Repeated across mixed
    // spellings, cohorts would thrash and never accumulate, which attacks the
    // sample floor the whole feature rests on.
    //
    // So an empty style is treated the way size-systems.ts treats a refusal:
    // it means "we could not tell", not "this garment has no style", and it
    // never overwrites a match. A NON-empty new style still wins, because that
    // is a seller correcting the identity and the newest answer is the truth.
    await carryForwardResolvedStyle(rows);

    const { error } = await supabaseAdmin
      .from("garment_measurements")
      .upsert(rows as never, { onConflict: "item_id,field_key" });
    if (error) {
      console.error("[measurement-ingest] upsert failed:", error.message);
      return 0;
    }
    return rows.length;
  } catch (err) {
    console.error(
      "[measurement-ingest] ingest failed:",
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
}

/**
 * Read a garment's own listing text and file whatever it states unambiguously.
 *
 * Best-effort on the same contract as the MeasureCard path: never throws,
 * returns a count. `text` may be HTML — `listings.listing_description` holds an
 * eBay body — and the caller is expected to have flattened it already, because
 * flattening is the one step that needs no database and is worth doing once per
 * item rather than once per listing.
 *
 * Two guards run before the write, and they protect different things:
 *
 *   dropFieldsMeasuredByCard stops a hand-tape number replacing a calibrated
 *   one. Without it every sync would quietly downgrade the best evidence in the
 *   system, because the upsert key does not know about sources.
 *
 *   carryForwardResolvedStyle stops a failed style match wiping a good one, the
 *   same defect found on the MeasureCard path in US-3034.
 */
export async function ingestListingTextObservations(args: {
  userId: string;
  itemId: string;
  brand: string | null | undefined;
  style: string | null | undefined;
  size: string | null | undefined;
  group: MeasurementGroup;
  text: string | null | undefined;
}): Promise<number> {
  try {
    if (!args.text) return 0;

    const parsed = parseMeasurementsFromText(args.text, args.group);
    if (parsed.length === 0) return 0;

    if (!brandKeyForRaw(args.brand)) return 0;
    const pack = await resolveBrandKnowledgePack(args.brand);
    const cohort = resolveMeasurementCohort({
      brand: args.brand,
      style: args.style,
      size: args.size,
      group: args.group,
      styles: pack?.styles ?? [],
    });
    if (!cohort) return 0;

    let rows = buildListingTextObservations({
      userId: args.userId,
      itemId: args.itemId,
      cohort,
      parsed,
    });
    if (rows.length === 0) return 0;

    const { data: stored, error: readErr } = await supabaseAdmin
      .from("garment_measurements")
      .select("field_key, style_key, department, source")
      .eq("item_id", args.itemId);
    if (readErr) {
      console.error("[measurement-ingest] prior read failed:", readErr.message);
      return 0;
    }
    const priors = (stored ?? []) as unknown as {
      field_key: string;
      style_key: string;
      department: string;
      source: string;
    }[];

    rows = dropFieldsMeasuredByCard(rows, priors);
    if (rows.length === 0) return 0;
    mergeResolvedStyle(rows, priors);

    const { error } = await supabaseAdmin
      .from("garment_measurements")
      .upsert(rows as never, { onConflict: "item_id,field_key" });
    if (error) {
      console.error("[measurement-ingest] listing-text upsert failed:", error.message);
      return 0;
    }
    return rows.length;
  } catch (err) {
    console.error(
      "[measurement-ingest] listing-text ingest failed:",
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
}
