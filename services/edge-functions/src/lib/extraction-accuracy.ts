// US-1531: per-field extraction accuracy — pure aggregation core.
//
// From ai_enrichment_log rows (accepted_fields = the final value the user kept
// for each accepted AI suggestion; corrected_fields = {field:{suggested,final}}
// for the subset they edited away from the AI value) compute, per field, how
// often the AI suggestion was corrected. Powers the admin accuracy view so the
// team can see e.g. "style" is wrong 40% of the time and fix the prompt.
//
// Pure + deterministic (no DB): the admin route fetches the rows (optionally
// filtered by item_category/brand/model) and hands them here. Fully unit-tested.

export interface ExtractionLogRow {
  accepted_fields: Record<string, unknown> | null;
  corrected_fields: Record<string, unknown> | null;
}

export interface FieldAccuracy {
  field: string;
  /** Times this field was suggested AND accepted (edited or not). */
  accepted: number;
  /** Of those, times the user changed the AI value. */
  corrected: number;
  /** corrected / accepted, 0..1. */
  correctionRate: number;
}

function has(obj: Record<string, unknown> | null | undefined, key: string): boolean {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Aggregate per-field correction rates across the given logs, sorted worst-first
 * (highest correction rate, then most-sampled). A field counts once per log it
 * was accepted in; a correction counts when the log also recorded it as edited.
 */
export function summarizeExtractionAccuracy(
  rows: readonly ExtractionLogRow[],
): FieldAccuracy[] {
  const acc = new Map<string, { accepted: number; corrected: number }>();
  const bump = (field: string, corrected: boolean) => {
    const e = acc.get(field) ?? { accepted: 0, corrected: 0 };
    e.accepted++;
    if (corrected) e.corrected++;
    acc.set(field, e);
  };

  for (const r of rows) {
    const af = r.accepted_fields ?? {};
    const cf = r.corrected_fields ?? {};
    for (const field of Object.keys(af)) bump(field, has(cf, field));
    // A field edited but somehow not present in accepted_fields still counts.
    for (const field of Object.keys(cf)) {
      if (!has(af, field)) bump(field, true);
    }
  }

  return [...acc.entries()]
    .map(([field, e]) => ({
      field,
      accepted: e.accepted,
      corrected: e.corrected,
      correctionRate: e.accepted > 0 ? e.corrected / e.accepted : 0,
    }))
    .sort((a, b) =>
      b.correctionRate - a.correctionRate || b.accepted - a.accepted ||
      a.field.localeCompare(b.field)
    );
}
