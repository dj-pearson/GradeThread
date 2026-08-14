// US-2566: what makes one derived evidence asset the same as another, and which
// ones are stale.
//
// SPLIT OUT OF defect-annotations.ts ON PURPOSE. That module imports the
// service-role client at load time, so anything living there can only be tested
// with a database — which is exactly how these two decisions came to be
// untested substring matches on a filename in the first place. Nothing here
// touches IO.
//
// Both decisions are destructive or near-destructive and run unattended on every
// annotation pass: the prune DELETES rows, and the identity check decides
// whether to render again. See derived-photo-provenance_test.ts.

// ── US-2566: provenance, in columns ────────────────────────────────────────
//
// Before 00598 an auto-annotated row was identified by its FILENAME. Staleness
// after a regrade was `storage_path.includes("/disclosure_auto_")` plus a
// `_{reportTag}.jpg` suffix test, and "have I already attached this?" was a Set
// of destination paths. That answered one question and no others: not which
// defect a crop shows, not which source photo it came from, not which
// certificate it belongs to. It also COLLIDES the moment a second crop is
// rendered from one source image, which is exactly what US-2567's per-defect
// crops must do.
//
// The three decisions now live in the columns and — since they are the part
// worth being sure about — in pure functions that need no database.

export const AUTO_MARKER = "disclosure_auto_";

/** The item_photos columns these decisions read. */
export interface DerivedPhotoRow {
  id: string;
  storage_path: string | null;
  sort_order: number | null;
  derived_from_grade_report_id: string | null;
  derived_transform: string | null;
  derived_from_storage_path: string | null;
  derived_defect_index: number | null;
}

/** The identity of an asset we are about to render. */
export interface DerivedIdentity {
  gradeReportId: string;
  transform: "annotated_full" | "defect_crop" | "certificate_card";
  sourceStoragePath: string;
  defectIndex: number | null;
}

/**
 * A pre-00598 derived row, recognisable only by its path.
 *
 * ⚠ THE ONE PLACE THIS MODULE STILL READS storage_path AS A STRING, and it is
 * deliberately the only one. Rows written before the provenance columns existed
 * have `derived_from_grade_report_id = NULL`, which by column alone is
 * indistinguishable from a seller upload — and the difference matters
 * enormously, because one must be pruned and re-derived while the other must
 * never be touched. The marker is the only evidence that survives.
 *
 * DELETE THIS once no row carries the marker. It is a migration concern with an
 * expiry, not a design. The condition is
 * `select count(*) from item_photos where storage_path like '%/disclosure_auto_%'
 * and derived_from_grade_report_id is null` reaching zero.
 */
export function isLegacyDerivedPath(storagePath: string | null): boolean {
  return typeof storagePath === "string" && storagePath.includes(`/${AUTO_MARKER}`);
}

/**
 * Which derived rows must go before this report's assets are attached.
 *
 * Everything derived from a DIFFERENT report is stale: a regrade supersedes the
 * old one, and imagery that contradicts the current verified grade is worse than
 * no imagery — it is a documented claim about a garment that is no longer true.
 *
 * A row with a NULL report id is a SELLER UPLOAD and is never returned, with the
 * legacy exception above. That is the property most worth pinning: this prune
 * runs on every annotation pass, so getting it wrong deletes the seller's own
 * photographs, silently, on a path nobody is watching.
 */
export function selectStaleDerivedPhotos(
  rows: readonly DerivedPhotoRow[],
  currentGradeReportId: string,
): string[] {
  const stale: string[] = [];
  for (const row of rows) {
    if (row.derived_from_grade_report_id === null) {
      // Seller upload, or a pre-00598 derivative. Only the latter goes.
      if (isLegacyDerivedPath(row.storage_path)) stale.push(row.id);
      continue;
    }
    if (row.derived_from_grade_report_id !== currentGradeReportId) stale.push(row.id);
  }
  return stale;
}

/**
 * Is this exact asset already attached?
 *
 * Mirrors the partial unique index in 00598 — same four columns, same
 * COALESCE(defect_index, -1) treatment — so the in-process check and the
 * database's own constraint cannot disagree about what "the same asset" means.
 */
export function findAttachedDerivative(
  rows: readonly DerivedPhotoRow[],
  identity: DerivedIdentity,
): DerivedPhotoRow | null {
  const wantIndex = identity.defectIndex ?? -1;
  return rows.find((row) =>
    row.derived_from_grade_report_id === identity.gradeReportId &&
    row.derived_transform === identity.transform &&
    row.derived_from_storage_path === identity.sourceStoragePath &&
    (row.derived_defect_index ?? -1) === wantIndex
  ) ?? null;
}

/** Next free display slot, ignoring the rows about to be pruned. */
export function nextSortOrder(
  rows: readonly DerivedPhotoRow[],
  excludeIds: readonly string[],
): number {
  const skip = new Set(excludeIds);
  let next = 0;
  for (const row of rows) {
    if (skip.has(row.id)) continue;
    if (typeof row.sort_order === "number" && row.sort_order + 1 > next) {
      next = row.sort_order + 1;
    }
  }
  return next;
}
