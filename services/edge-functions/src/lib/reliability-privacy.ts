// Data minimization for reliability-study (QA) access to customer submissions
// (US-488).
//
// Reliability studies sample REAL customer submissions across all tenants, so
// reviewer access is a deliberate privacy exception and must be the minimum
// needed to blind-grade a garment. The contract, enforced here and documented
// in the Privacy Policy ("Human quality assurance", section 4) and the DPA:
//
//   - Reviewers see garment photos + non-identifying garment attributes ONLY.
//   - NO owner identity (user_id, email, name) is ever returned with an item.
//   - NO seller-authored free text (title, description) — it can carry PII the
//     seller typed and it biases a blind condition grade anyway.
//   - Every per-item photo view is audit-logged (see admin-grading.ts).
//
// The allowlist below is the single source of truth for what a QA reviewer may
// see about a submission. Widening it is a privacy-policy change, not just a
// code change.

export const RELIABILITY_QUEUE_FIELDS = [
  "id",
  "garment_type",
  "garment_category",
  "brand",
] as const;

export const RELIABILITY_QUEUE_SELECT: string = RELIABILITY_QUEUE_FIELDS.join(", ");

export interface ReliabilityQueueItem {
  id: string;
  garment_type: string | null;
  garment_category: string | null;
  brand: string | null;
}

const asNullableString = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

// Re-project a submission row onto the allowlist. Field-by-field construction
// (not delete-the-bad-keys) so a column added to the SELECT later cannot leak
// without being added here explicitly.
export function minimizeReliabilityQueueRow(
  row: Record<string, unknown>,
): ReliabilityQueueItem {
  return {
    id: typeof row.id === "string" ? row.id : String(row.id ?? ""),
    garment_type: asNullableString(row.garment_type),
    garment_category: asNullableString(row.garment_category),
    brand: asNullableString(row.brand),
  };
}

export interface ReliabilityItemPhoto {
  id: string;
  image_type: string;
  display_order: number;
  signed_url: string | null;
}

// Same allowlist idea for the per-item photo payload: id + image_type +
// ordering + a short-lived signed URL. storage_path is deliberately dropped —
// it embeds the owner's user UUID ({userId}/{submissionId}/...).
export function minimizeReliabilityPhoto(
  img: { id: string; image_type: string; display_order: number },
  signedUrl: string | null,
): ReliabilityItemPhoto {
  return {
    id: img.id,
    image_type: img.image_type,
    display_order: img.display_order,
    signed_url: signedUrl,
  };
}
