// US-2131: bulk import for the authenticity golden set.
//
// The single-case POST works but does not scale to the job actually required —
// an expert sitting down with a labelled corpus and entering it one HTTP request
// at a time. Nothing downstream can move until that corpus exists: the eval gate
// cannot pass (US-2130), the prompt cannot be narrowed (US-2134), and the
// buyer-facing positioning stays blocked (US-2143).
//
// Two properties matter more than throughput here:
//
//   • PARTIAL SUCCESS IS REPORTED, NEVER SILENT. A batch where 3 of 50 rows are
//     malformed must say which 3 and why. Dropping them quietly would leave the
//     operator believing they seeded 50 cases and the gate scoring 47 — and
//     per-brand coverage is what blocks activation, so a silent gap reads as
//     "this brand isn't covered yet" rather than "your import was broken".
//   • ROW ERRORS DO NOT FAIL THE BATCH. Re-uploading 50 rows because one had a
//     typo is how people start bypassing validation.

import { validateAuthenticityCase } from "./authenticity-eval.ts";
import { brandKeyForRaw } from "./brand-normalize.ts";

export interface GoldenSetImportRow {
  label?: unknown;
  /** The brand as written; alias-resolved into brand_key on the way in. */
  brand?: unknown;
  /** Optional explicit key — wins over `brand` when supplied. */
  brand_key?: unknown;
  garment_type?: unknown;
  expected_label?: unknown;
  images?: unknown;
  tags?: unknown;
  notes?: unknown;
  /** Where the LABEL came from — who determined it and how. */
  source_url?: unknown;
}

export interface PreparedCase {
  label: string;
  brand_key: string;
  brand: string | null;
  garment_type: string | null;
  expected_label: string;
  images: unknown;
  tags: string[];
  notes: string | null;
  source_url: string | null;
}

export interface RowError {
  /** 0-based index in the submitted array — the operator's row number. */
  row: number;
  label: string | null;
  error: string;
}

export interface ImportPlan {
  prepared: PreparedCase[];
  errors: RowError[];
}

/** Batch cap. Large enough for a real corpus drop, small enough to bound a request. */
export const MAX_IMPORT_ROWS = 500;

/**
 * Validate and normalize a batch. Pure + exported — no I/O, so the whole
 * accept/reject decision is unit-testable without a database.
 *
 * Every row is checked independently and its failure reported with its index.
 */
export function prepareImport(rows: readonly GoldenSetImportRow[]): ImportPlan {
  const prepared: PreparedCase[] = [];
  const errors: RowError[] = [];

  rows.forEach((raw, i) => {
    const label = typeof raw.label === "string" ? raw.label.trim() : "";

    // brand_key wins when given explicitly; otherwise derive it ALIAS-RESOLVED
    // from the brand, so an import written "Levi Strauss" lands on the same key
    // as the KB row and as a review-promoted case.
    const explicitKey = typeof raw.brand_key === "string" ? raw.brand_key.trim() : "";
    const brand = typeof raw.brand === "string" ? raw.brand.trim() : "";
    const brandKey = explicitKey || (brand ? brandKeyForRaw(brand) ?? "" : "");

    const candidate = {
      label,
      brand_key: brandKey,
      expected_label: raw.expected_label,
      images: raw.images,
    };
    const invalid = validateAuthenticityCase(candidate as Record<string, unknown>);
    if (invalid) {
      errors.push({ row: i, label: label || null, error: invalid });
      return;
    }

    prepared.push({
      label,
      brand_key: brandKey,
      brand: brand || null,
      garment_type: typeof raw.garment_type === "string" ? raw.garment_type : null,
      expected_label: String(raw.expected_label),
      images: raw.images,
      tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
      notes: typeof raw.notes === "string" ? raw.notes : null,
      source_url: typeof raw.source_url === "string" ? raw.source_url : null,
    });
  });

  return { prepared, errors };
}

export interface CoverageWarning {
  brand_key: string;
  message: string;
}

/**
 * Warn about a batch that will not actually help the gate. Pure + exported.
 *
 * A brand with only authentic examples cannot demonstrate the one error the gate
 * exists to catch — a known fake called authentic — so importing 40 genuine
 * Gucci cases and no counterfeits produces a per-brand score that looks
 * excellent and proves nothing. Cheaper to say so at import than to discover it
 * after an eval run has spent a vision call per case.
 *
 * These are WARNINGS, not rejections: a corpus may legitimately arrive in two
 * halves, and refusing the first half would be worse than flagging it.
 */
export function coverageWarnings(prepared: readonly PreparedCase[]): CoverageWarning[] {
  const byBrand = new Map<string, { authentic: number; counterfeit: number }>();
  for (const c of prepared) {
    const b = byBrand.get(c.brand_key) ?? { authentic: 0, counterfeit: 0 };
    if (c.expected_label === "authentic") b.authentic += 1;
    if (c.expected_label === "counterfeit") b.counterfeit += 1;
    byBrand.set(c.brand_key, b);
  }

  const out: CoverageWarning[] = [];
  for (const [brand_key, b] of byBrand) {
    if (b.authentic > 0 && b.counterfeit === 0) {
      out.push({
        brand_key,
        message:
          `${b.authentic} authentic case(s) and no counterfeits. The gate cannot ` +
          `demonstrate a dangerous miss for this brand, so a perfect score here ` +
          `is not evidence — add counterfeit examples before relying on it.`,
      });
    } else if (b.counterfeit > 0 && b.authentic === 0) {
      out.push({
        brand_key,
        message:
          `${b.counterfeit} counterfeit case(s) and no authentic ones. Without ` +
          `genuine examples the gate cannot show a false-positive rate — the ` +
          `error that harms sellers and that nothing else measures.`,
      });
    }
  }
  return out;
}

/** Guard the batch size. Returns an error string, or null. */
export function validateBatchSize(rows: unknown): string | null {
  if (!Array.isArray(rows)) return "Body must be an array of cases (or { cases: [...] }).";
  if (rows.length === 0) return "No cases supplied.";
  if (rows.length > MAX_IMPORT_ROWS) {
    return `Too many rows (${rows.length}). Split into batches of ${MAX_IMPORT_ROWS} or fewer.`;
  }
  return null;
}
