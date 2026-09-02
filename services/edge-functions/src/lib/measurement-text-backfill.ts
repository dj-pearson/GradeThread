// US-3035: drain the descriptions already on file into the Fit & Measurement
// Index.
//
// The live path only sees garments a seller touches after this ships. Every
// listing already synced holds measurements a reseller typed by hand, and the
// cohorts need them: at the sample floor of five garments from three sellers,
// the difference between a backfill and no backfill is the difference between
// having pages and not.
//
// ── WHY THERE IS A SCAN MARKER, AND WHY IT IS NOT A NEW COLUMN ─────────────
//
// Most descriptions state no measurements at all. So "items with no
// listing_text row yet" cannot be the work queue — it cannot tell "never
// scanned" from "scanned and said nothing", and the job would re-read the same
// thousands of prose descriptions every tick and never drain.
//
// The marker is a namespaced key in `inventory_items.ai_field_sources`, which
// is exactly what US-2607 already does with `measurements._pass`. Same jsonb,
// same leading-underscore namespace so the provenance readers (which all match
// `measurements.<key>`) skip it, and no migration.
//
// ── IDEMPOTENT, AND RE-RUNNABLE AFTER A PARSER FIX ────────────────────────
//
// Re-running is safe: the upsert is keyed on (item_id, field_key), so a second
// pass over the same item rewrites its own rows rather than adding any.
//
// After a parser fix you want the opposite of draining — you want every item
// read again with the new rules. That is `reset`, which clears the markers (and
// only the markers) so the queue refills. It deliberately does NOT delete the
// observations: the re-scan overwrites what it can still parse, and a value the
// fixed parser no longer accepts is one it should never have written, so
// `purge` exists to drop the listing_text rows outright when that is what a fix
// calls for. Two switches because they answer two different questions.

import { supabaseAdmin } from "./supabase.ts";
import { htmlToPlainText } from "./cert-description.ts";
import { measurementGroupForItem } from "./measurement-templates.ts";
import { ingestListingTextObservations } from "./measurement-ingest.ts";

/** `ai_field_sources` key recording that this item's text has been read. */
export const TEXT_SCAN_KEY = "measurements._textScan";

/** Bounded per run so a large backlog drains across ticks. */
export const TEXT_BACKFILL_BATCH = 100;

export interface TextBackfillSummary {
  /** Items examined this run. */
  scanned: number;
  /** Items whose text stated at least one usable measurement. */
  withMeasurements: number;
  /** Observation rows written or updated. */
  ingested: number;
  /** True when the queue is empty and the backlog has drained. */
  drained: boolean;
}

interface BackfillItemRow {
  id: string;
  user_id: string;
  brand: string | null;
  style: string | null;
  size: string | null;
  title: string | null;
  description: string | null;
  ai_field_sources: Record<string, unknown> | null;
  item_category: string | null;
  garment_category: string | null;
  garment_type: string | null;
}

/**
 * Clear the scan markers so every item is read again. Use after a parser fix.
 *
 * Returns the number of items unmarked.
 */
export async function resetTextScanMarkers(): Promise<number> {
  // US-2317: PAGED, not one read of the whole table. inventory_items grows with
  // usage and PostgREST clips an over-cap read SILENTLY -- a short array with
  // error: null -- so an unpaged select here would quietly reset the markers on
  // the first N items and report success for all of them. The cursor is the id
  // itself, ordered, so each page is bounded and the walk still drains.
  const PAGE = 500;
  const FIRST_UUID = "00000000-0000-0000-0000-000000000000";
  let cursor = FIRST_UUID;
  let cleared = 0;

  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("inventory_items")
      .select("id, ai_field_sources")
      .not("ai_field_sources", "is", null)
      .gt("id", cursor)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (error || !data || data.length === 0) return cleared;

    const rows = data as unknown as {
      id: string;
      ai_field_sources: Record<string, unknown>;
    }[];
    for (const raw of rows) {
      const sources = raw.ai_field_sources ?? {};
      if (!(TEXT_SCAN_KEY in sources)) continue;
      const next = { ...sources };
      delete next[TEXT_SCAN_KEY];
      const { error: upErr } = await supabaseAdmin
        .from("inventory_items")
        .update({ ai_field_sources: next } as never)
        .eq("id", raw.id);
      if (!upErr) cleared++;
    }

    if (rows.length < PAGE) return cleared;
    cursor = rows[rows.length - 1]!.id;
  }
}

/**
 * Delete every observation this parser produced, leaving MeasureCard rows.
 *
 * The stronger half of a parser fix: when the old rules wrote values the new
 * rules would refuse, re-scanning cannot remove them, because a value the fixed
 * parser declines to parse is a value it never overwrites.
 */
export async function purgeListingTextObservations(): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("garment_measurements")
    .delete()
    .eq("source", "listing_text")
    .select("id");
  if (error || !data) return 0;
  return (data as unknown as unknown[]).length;
}

/**
 * Read one batch of unscanned items and file whatever their text states.
 *
 * Text comes from the item's own description plus every listing body synced for
 * it. They are read as ONE document rather than one at a time, because a seller
 * usually writes the measurements once and the same numbers appear on every
 * channel; parsing per-listing would produce the same value repeatedly and the
 * first-wins rule would discard the duplicates anyway.
 */
export async function backfillMeasurementsFromText(
  batchSize = TEXT_BACKFILL_BATCH,
): Promise<TextBackfillSummary> {
  const summary: TextBackfillSummary = {
    scanned: 0,
    withMeasurements: 0,
    ingested: 0,
    drained: false,
  };

  // The queue: items that can join a cohort at all (a brand and a size are both
  // required) and have not been read yet. Filtering on brand and size here
  // rather than after the read keeps the job off the large tail of part-filled
  // items that could never contribute.
  const { data, error } = await supabaseAdmin
    .from("inventory_items")
    .select(
      "id, user_id, brand, style, size, title, description, ai_field_sources, item_category, garment_category, garment_type",
    )
    .not("brand", "is", null)
    .not("size", "is", null)
    .order("created_at", { ascending: true })
    .limit(batchSize * 4);
  if (error) {
    console.error("[measurement-text-backfill] queue read failed:", error.message);
    return summary;
  }

  const rows = (data ?? []) as unknown as BackfillItemRow[];
  const pending = rows
    .filter((r) => !((r.ai_field_sources ?? {}) as Record<string, unknown>)[TEXT_SCAN_KEY])
    .slice(0, batchSize);

  if (pending.length === 0) {
    summary.drained = true;
    return summary;
  }

  for (const item of pending) {
    summary.scanned++;

    const { data: listingRows } = await supabaseAdmin
      .from("listings")
      .select("listing_description")
      .eq("inventory_item_id", item.id)
      .eq("user_id", item.user_id);

    const bodies = [
      item.description ?? "",
      ...((listingRows ?? []) as unknown as { listing_description: string | null }[])
        .map((l) => l.listing_description ?? ""),
    ].filter((s) => s.trim() !== "");

    let written = 0;
    if (bodies.length > 0) {
      const text = htmlToPlainText(bodies.join("\n\n"));
      written = await ingestListingTextObservations({
        userId: item.user_id,
        itemId: item.id,
        brand: item.brand,
        style: item.style,
        size: item.size,
        group: measurementGroupForItem(item),
        text,
      });
    }

    if (written > 0) {
      summary.withMeasurements++;
      summary.ingested += written;
    }

    // Mark it read either way. An item whose prose says nothing is DONE, not
    // pending — that distinction is the only thing that lets this drain.
    const nextSources = {
      ...((item.ai_field_sources ?? {}) as Record<string, unknown>),
      [TEXT_SCAN_KEY]: { written, scannedAt: new Date().toISOString() },
    };
    const { error: markErr } = await supabaseAdmin
      .from("inventory_items")
      .update({ ai_field_sources: nextSources } as never)
      .eq("id", item.id)
      .eq("user_id", item.user_id);
    if (markErr) {
      console.error("[measurement-text-backfill] mark failed:", markErr.message);
    }
  }

  return summary;
}
