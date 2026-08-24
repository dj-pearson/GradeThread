// US-2844: writing comp condition samples, once each.
//
// A comp read costs an AI call. The same listing turns up again and again -
// relisted, duplicated by other sellers, met a second time on the next pass
// over the same cell - so the dedupe key is the whole point of this module. It
// is a hash over the listing's photo set, sorted, because sellers reshuffle a
// gallery without changing what is in it.
//
// WHAT NEVER REACHES THE TABLE. No seller, no listing id, no URL, no title, no
// image bytes. A row here is a sample in a distribution, never a statement
// about a particular person's listing (US-2841 standing constraint). The mapper
// below is the only way to build a row, and it is exhaustive on purpose: a
// field that is not in it cannot be written by accident.

import { type CompPhoto } from "./comp-stock-photo.ts";

export const COMP_READS_TABLE = "comp_condition_reads";

/** The sample, in the caller's terms. */
export interface CompReadInput {
  cellKey: string;
  photoSetHash: string;
  /** 1.0-10.0, or null when we rejected the listing before scoring it. */
  readScore: number | null;
  readConfidence: number | null;
  imagesAnalyzed: number;
  askingPriceCents: number | null;
  currency: string;
  stockRejected: boolean;
  stockReasons: string[];
}

/** The sample, in the table's terms. */
export interface CompReadRow {
  cell_key: string;
  photo_set_hash: string;
  read_score: number | null;
  read_confidence: number | null;
  images_analyzed: number;
  asking_price_cents: number | null;
  currency: string;
  stock_rejected: boolean;
  stock_reasons: string[];
}

/**
 * Hash a photo set into its dedupe key.
 *
 * SORTED first. Two listings carrying the same photos in a different order are
 * the same listing as far as an AI read is concerned, and paying twice for the
 * shuffle is exactly the waste this exists to stop.
 */
export async function photoSetHash(photoHashes: string[]): Promise<string> {
  const clean = photoHashes.map((h) => h.trim()).filter((h) => h.length > 0);
  if (clean.length === 0) {
    throw new Error("photoSetHash: no photos to hash");
  }
  const joined = [...clean].sort().join("\n");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(joined),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Convenience: hash the photos we already carry metadata for. */
export function hashesOf(photos: CompPhoto[]): string[] {
  return photos.map((p) => p.hash);
}

/**
 * Build the row, refusing anything the table would refuse.
 *
 * These checks duplicate the CHECK constraints in 00663 deliberately. A
 * constraint violation surfaces as a 23514 from a background worker at some
 * unhelpful hour; a thrown Error surfaces at the call site with the field name
 * in it.
 */
export function toCompReadRow(input: CompReadInput): CompReadRow {
  const cell = input.cellKey?.trim() ?? "";
  if (cell.length === 0) throw new Error("toCompReadRow: cell_key is empty");

  const hash = input.photoSetHash?.trim() ?? "";
  if (hash.length === 0) throw new Error("toCompReadRow: photo_set_hash is empty");

  if (
    input.readScore != null && (input.readScore < 1 || input.readScore > 10)
  ) {
    throw new Error(`toCompReadRow: read_score ${input.readScore} is off the 1.0-10.0 scale`);
  }
  if (
    input.readConfidence != null &&
    (input.readConfidence < 0 || input.readConfidence > 1)
  ) {
    throw new Error(`toCompReadRow: read_confidence ${input.readConfidence} is not in 0..1`);
  }
  const reasons = input.stockReasons ?? [];
  if (input.stockRejected && reasons.length === 0) {
    throw new Error("toCompReadRow: a rejected read must carry stock_reasons");
  }

  return {
    cell_key: cell,
    photo_set_hash: hash,
    read_score: input.readScore,
    read_confidence: input.readConfidence,
    images_analyzed: input.imagesAnalyzed ?? 0,
    asking_price_cents: input.askingPriceCents,
    currency: input.currency || "USD",
    stock_rejected: input.stockRejected,
    stock_reasons: reasons,
  };
}

/**
 * The slice of supabase-js this module uses.
 *
 * Injected rather than imported so the duplicate-is-a-no-op behaviour can be
 * proven without a database, which is the same reason ai-budget.ts takes its
 * dependencies as arguments.
 */
export interface CompReadClient {
  from(table: string): {
    upsert(
      rows: CompReadRow[],
      opts: { onConflict: string; ignoreDuplicates: boolean },
    ): {
      select(columns: string): Promise<{
        // Only the conflict key is selected back, because the count of returned
        // rows IS the answer: with ignoreDuplicates, PostgREST returns the rows
        // it actually inserted and stays quiet about the ones it skipped.
        data: { photo_set_hash: string }[] | null;
        error: { message: string } | null;
      }>;
    };
  };
}

export interface CompReadWriteResult {
  written: number;
  skipped: number;
  error: string | null;
}

/**
 * Write samples, skipping any photo set we already hold.
 *
 * The skip happens in Postgres, not here: asking the database to ignore
 * conflicts is the only version that stays correct when two workers claim
 * overlapping cells at the same moment.
 */
export async function recordCompReads(
  client: CompReadClient,
  inputs: CompReadInput[],
): Promise<CompReadWriteResult> {
  if (inputs.length === 0) return { written: 0, skipped: 0, error: null };

  const rows = inputs.map(toCompReadRow);
  const { data, error } = await client
    .from(COMP_READS_TABLE)
    .upsert(rows, { onConflict: "photo_set_hash", ignoreDuplicates: true })
    .select("photo_set_hash");

  if (error) return { written: 0, skipped: 0, error: error.message };

  const written = data?.length ?? 0;
  return { written, skipped: rows.length - written, error: null };
}
