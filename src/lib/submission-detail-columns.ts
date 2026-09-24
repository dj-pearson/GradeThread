import type {
  DisputeRow,
  SubmissionRow,
  GradeReportRow,
  InventoryItemRow,
  SubmissionImageRow,
} from "@/types/database";

// SUB-02: the seller's submission detail page reads exactly what it renders.
//
// `select("*")` on grade_reports handed image_authenticity (with its tells),
// forensic_analysis, detailed_notes and reviewed_by to the browser on every
// 5s poll. Those are anti-fraud signals: an evader who can read them learns
// what tripped the detector. submission_images `*` carried GPS EXIF and the
// original_storage_path, and inventory_items `*` carried cost basis for a card
// that shows three fields.
//
// Each projection is paired with a Pick<> type, so a component that later
// reaches for a column the select stopped fetching is a tsc error rather than
// an undefined at runtime.

export const GRADE_REPORT_OWNER_COLUMNS = [
  "id",
  "submission_id",
  "overall_score",
  "grade_tier",
  "fabric_condition_score",
  "structural_integrity_score",
  "cosmetic_appearance_score",
  "functional_elements_score",
  "odor_cleanliness_score",
  "ai_summary",
  "buyer_writeup",
  "defects_found",
  "detected_style_attributes",
  // cleanlinessVisible() reads unassessable_factors from it (US-3329).
  "per_image_analysis",
  "confidence_score",
  "authenticity_assessment",
  "limiting_flaw",
  "review_status",
  "review_due_at",
  "release_at",
  "model_version",
  "certificate_id",
  "view_count",
  "garment_id",
  "created_at",
] as const;

export type GradeReportOwnerView = Pick<
  GradeReportRow,
  (typeof GRADE_REPORT_OWNER_COLUMNS)[number]
>;

export const GRADE_REPORT_OWNER_SELECT = GRADE_REPORT_OWNER_COLUMNS.join(", ");

export const SUBMISSION_IMAGE_COLUMNS = "id, image_type, storage_path, display_order";
export type SubmissionImageView = Pick<
  SubmissionImageRow,
  "id" | "image_type" | "storage_path" | "display_order"
>;

export const LINKED_ITEM_COLUMNS = "id, title, brand, status";
export type LinkedItemView = Pick<InventoryItemRow, "id" | "title" | "brand" | "status">;

export const DISPUTE_VIEW_COLUMNS =
  "id, grade_report_id, kind, status, reason, resolution_notes, created_at";
export type DisputeView = Pick<
  DisputeRow,
  "id" | "grade_report_id" | "kind" | "status" | "reason" | "resolution_notes" | "created_at"
>;

export const SUBMISSION_DETAIL_COLUMN_LIST = [
  "id",
  "user_id",
  "title",
  "brand",
  "description",
  "garment_type",
  "garment_category",
  "style_attributes",
  "status",
  "service_tier",
  "quality_feedback",
  "grading_started_at",
  "showcase_opt_in",
  "showcase_value_cents",
  "created_at",
  "updated_at",
] as const;
export const SUBMISSION_DETAIL_COLUMNS = SUBMISSION_DETAIL_COLUMN_LIST.join(", ");
export type SubmissionDetailView = Pick<
  SubmissionRow,
  (typeof SUBMISSION_DETAIL_COLUMN_LIST)[number]
>;
