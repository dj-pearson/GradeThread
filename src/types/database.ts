// Legacy single-plan enum (US-225 migrates these to FlipdeskPlan). Kept until
// the legacy users.plan column is dropped.
export type UserPlan = "free" | "starter" | "professional" | "enterprise";

// Pricing model split (US-200/US-201): FlipDesk subscription tier + Stripe lifecycle.
export type FlipdeskPlan = "free" | "starter" | "pro" | "business";
export type SubscriptionStatus =
  | "none"
  | "trialing"
  | "active"
  | "past_due"
  | "paused"
  | "canceled";
export type BillingInterval = "monthly" | "yearly";
export type GradeCreditReason =
  | "pack_purchase"
  | "grade_debit"
  | "included_grant"
  | "admin_grant"
  | "refund"
  | "expiration";
export type GarmentType = "tops" | "bottoms" | "outerwear" | "dresses" | "footwear" | "accessories";
export type GarmentCategory =
  | "t-shirt" | "shirt" | "blouse" | "sweater" | "hoodie"
  | "jacket" | "coat" | "jeans" | "pants" | "shorts"
  | "skirt" | "dress" | "sneakers" | "boots" | "sandals"
  | "hat" | "bag" | "belt" | "scarf" | "other";
export type SubmissionStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "disputed"
  // US-332: image-quality gate abstained — seller must add better photos.
  | "needs_photos"
  // US-773: abandoned checkout (started but never paid) retired by the reaper.
  | "expired";

// US-332: actionable feedback recorded when the quality gate abstains.
export interface QualityFeedback {
  summary: string;
  photo_requests: string[];
  issues: {
    image_type: string;
    problem: string;
    severity: "block" | "warn";
    message: string;
  }[];
  assessed_at: string;
}
export type GradeTier = "NWT" | "NWOT" | "Excellent" | "Very Good" | "Good" | "Fair" | "Poor";
export type ImageType =
  | "front"
  | "back"
  | "label"
  | "label_2"
  | "detail"
  | "detail_2"
  | "detail_3"
  | "detail_4"
  | "defect"
  | "measurement_chest"
  | "measurement_waist"
  | "measurement_length"
  | "measurement_sleeve"
  | "measurement_inseam";
export type DisputeStatus = "open" | "under_review" | "resolved" | "rejected";
export type ItemStatus =
  | "sourced"
  | "acquired"
  | "cataloged"
  | "measured"
  | "photographed"
  | "grading"
  | "graded"
  | "comped"
  | "drafted"
  | "listed"
  | "sold"
  | "shipped"
  | "completed"
  | "returned"
  | "archived"
  | "keeping"
  | "wearing";

// One comp record stored inside inventory_items.comp_set jsonb.
export interface ItemComp {
  price: number;
  source?: string;
  url?: string;
  sold_date?: string;
  notes?: string;
}
export type ListingPlatform =
  | "ebay"
  | "poshmark"
  | "mercari"
  | "depop"
  | "grailed"
  | "facebook"
  | "offerup"
  | "shopify"
  | "whatnot"
  | "other";
export type UserRole = "user" | "reviewer" | "admin" | "super_admin";

// ─── Workspace (team) roles ────────────────────────────────────────
// Single workspace per "owner user". Members can hold these roles in OTHER
// users' workspaces (the owner themself is implicit — no row in
// workspace_members; their effective role is always 'owner').
export type WorkspaceRole =
  | "viewer"
  | "member"
  | "listing_manager"
  | "admin"
  | "owner";
export type NotificationType =
  | "grade_complete"
  | "grading_submitted"
  | "grading_ready"
  | "dispute_update"
  | "billing"
  | "system"
  | "item_status_change"
  | "listing_live"
  | "sale_recorded"
  | "payout_imported";

// ─── FlipDesk enums ────────────────────────────────────────────────
export type FlipdeskSourceType =
  | "thrift"
  | "goodwill_auction"
  | "estate_sale"
  | "wholesale"
  | "retail_arbitrage"
  | "consignment"
  | "other";
// US-600: consignment mode.
export type ConsignorStatus = "active" | "paused" | "archived";
export type ConsignorPayoutStatus =
  | "pending"
  | "processing"
  | "paid"
  | "failed"
  | "canceled";
export type ItemCategory =
  | "clothing"
  | "shoes"
  | "watches"
  | "sports_cards"
  | "collectibles"
  | "electronics"
  | "books"
  | "other";
export type FlipdeskPhotoType =
  | "front"
  | "back"
  | "tag"
  | "tag_2"
  | "detail"
  | "detail_2"
  | "detail_3"
  | "detail_4"
  | "interior"
  | "defect"
  | "flatlay"
  | "on_model"
  | "measurement_chest"
  | "measurement_waist"
  | "measurement_length"
  | "measurement_sleeve"
  | "measurement_inseam";
export type ListingStatus = "draft" | "active" | "ended" | "sold" | "relisted";
export type GradingSubmissionTier = "standard" | "premium" | "express";
export type PayoutImportMethod = "csv_upload" | "api_sync";
// AutoLister (migration 00052)
export type ListingGenerationStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "partial";
export type ListingGenerationJobStatus =
  | "pending"
  | "running"
  | "success"
  | "failed";
export type ListingGenerationSource = "autolister" | "manual" | "api";
export type BusinessPolicyType = "fulfillment" | "payment" | "return";
export type ExpenseCategory =
  | "shipping_supplies"
  | "mileage"
  | "subscriptions"
  | "platform_fees"
  | "sourcing_travel"
  | "equipment"
  | "storage"
  | "other";

// ─── Row types (what you SELECT) ───────────────────────────────────

export interface NotificationPreferences {
  grade_complete: { email: boolean; in_app: boolean };
  dispute_updates: { email: boolean; in_app: boolean };
  billing_alerts: { email: boolean };
  product_updates: { email: boolean };
  // Selling lifecycle: listing went live, sale recorded, payout imported,
  // item status changed (US-737).
  selling_activity: { email: boolean; in_app: boolean };
}

export type UserUseCase = "seller" | "buyer" | "consignment" | "developer";

export interface UserRow {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  /** @deprecated legacy single-plan enum; use flipdesk_plan + grade_credit_balance (US-201/US-225). */
  plan: UserPlan;
  role: UserRole;
  stripe_customer_id: string | null;
  // REPURPOSED (US-201): now counts INCLUDED Standard grades used this billing cycle
  // against the FlipDesk tier's monthly bundle (Free 3, Starter 10, Pro 30, Business 75).
  grades_used_this_month: number;
  grade_reset_at: string;
  notification_preferences: NotificationPreferences;
  use_case: UserUseCase | null;
  onboarded_at: string | null;
  suspended: boolean;
  // FlipDesk user-state flags (migrations 00028, 00029)
  flipdesk_onboarded: boolean;
  dismissed_flipdesk_promo: boolean;
  // AI enrichment usage (US-158, US-167)
  ai_actions_used_this_month: number;
  ai_actions_reset_at: string;
  ai_enrichment_enabled: boolean;
  ai_action_limit: number | null;
  // Closed-loop sale-outcome opt-in (US-132)
  share_sale_outcomes: boolean;
  // Pricing split (US-201): FlipDesk subscription state
  flipdesk_plan: FlipdeskPlan;
  flipdesk_interval: BillingInterval | null;
  subscription_status: SubscriptionStatus;
  flipdesk_subscription_id: string | null;
  flipdesk_period_end: string | null;
  flipdesk_pause_until: string | null;
  flipdesk_cancel_at_period_end: boolean;
  // GradeThread credit wallet (US-201)
  grade_credit_balance: number;
  // 14-day Pro trial bookkeeping (US-219). One trial per user, ever.
  trial_ends_at: string | null;
  // Scheduled downgrade target (US-217). NULL when no downgrade is pending.
  pending_flipdesk_plan: FlipdeskPlan | null;
  pending_flipdesk_interval: BillingInterval | null;
  pending_schedule_id: string | null;
  pending_effective_at: string | null;
  // Multi-user (US-Team): the workspace this user is currently acting
  // inside. NULL = personal workspace (workspace_owner_id = id).
  active_workspace_owner_id: string | null;
  // US-374: owner-scoped MFA-enforcement threshold. When set, members at or
  // above this role must use MFA (AAL2) to act in this owner's workspace.
  // NULL = no enforcement.
  workspace_mfa_required_role: WorkspaceRole | null;
  // Soft upgrade triggers (US-209, migration 00071). usage_alert_thresholds:
  // percentages (out of 100) the user wants to be warned at — default [80],
  // Settings offers 50/80/95. last_warning_at: dedup ledger keyed
  // "<cap>:<threshold>" → "YYYY-MM" so each trigger fires once per month.
  usage_alert_thresholds: number[];
  last_warning_at: Record<string, string>;
  // GradeThread Verified — public seller trust profile (migration 00057).
  verified_handle: string | null;
  verified_display_name: string | null;
  verified_bio: string | null;
  verified_enabled: boolean;
  verified_since: string | null;
  // Storefront opt-in: list active listings on the public profile (migration 00122).
  verified_show_listings: boolean;
  // Cross-source sync-conflict email alert: send one email when the open
  // conflict count crosses this number (US-148, migration 00133). NULL disables.
  sync_conflict_email_threshold: number | null;
  // US-377: current accepted ToS/Privacy versions (clickwrap). NULL = never
  // recorded → the client legal gate blocks the dashboard until acceptance.
  tos_accepted_version: string | null;
  tos_accepted_at: string | null;
  privacy_accepted_version: string | null;
  privacy_accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Workspace membership / invitations ────────────────────────────

export interface WorkspaceMemberRow {
  id: string;
  owner_id: string;
  member_id: string;
  role: WorkspaceRole;
  invited_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMemberInsert {
  owner_id: string;
  member_id: string;
  role?: WorkspaceRole;
  invited_by?: string | null;
}

export type WorkspaceMemberUpdate = Partial<
  Pick<WorkspaceMemberRow, "role">
>;

export interface WorkspaceInvitationRow {
  id: string;
  owner_id: string;
  email: string;
  role: WorkspaceRole;
  token: string;
  invited_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceInvitationInsert {
  owner_id: string;
  email: string;
  role: WorkspaceRole;
  token: string;
  invited_by?: string | null;
  expires_at?: string;
}

export type WorkspaceInvitationUpdate = Partial<
  Pick<WorkspaceInvitationRow, "role" | "revoked_at">
>;

// US-377: append-only ToS/Privacy clickwrap acceptance log. One row per
// acceptance event (signup / oauth / re-acceptance) — the provable, exportable
// record. Written only by the edge service-role client + the signup trigger.
export interface LegalAcceptanceRow {
  id: string;
  user_id: string;
  tos_version: string;
  privacy_version: string;
  method: string;
  user_agent: string | null;
  ip_address: string | null;
  accepted_at: string;
}

// US-374: single-use MFA recovery codes. Only SHA-256 hashes are persisted;
// plaintext is shown once at generation time.
export interface MfaRecoveryCodeRow {
  id: string;
  user_id: string;
  code_hash: string;
  used_at: string | null;
  created_at: string;
}

// Returned by peek_workspace_invitation RPC.
export interface WorkspaceInvitationPeek {
  email: string;
  role: WorkspaceRole;
  owner_email: string;
  owner_full_name: string | null;
  expires_at: string;
  status: "pending" | "accepted" | "revoked" | "expired";
}

// Shape used in the auth store to describe a workspace the user can
// switch into (either their own personal workspace, or one they're a
// member of).
export interface WorkspaceSummary {
  ownerId: string;
  ownerEmail: string;
  ownerName: string | null;
  role: WorkspaceRole;
  isPersonal: boolean;
}

export type ModerationStatus = "approved" | "rejected";

export interface SubmissionRow {
  id: string;
  user_id: string;
  garment_type: GarmentType;
  garment_category: GarmentCategory;
  brand: string | null;
  title: string;
  description: string | null;
  // Seller-declared intentional design features (distressed, raw-hem, …) — a
  // hint to the grader so factory distressing isn't read as damage.
  style_attributes: string[];
  status: SubmissionStatus;
  flagged: boolean;
  flag_reason: string | null;
  moderation_status: ModerationStatus | null;
  // US-332: present when status === 'needs_photos' (the quality gate abstained).
  quality_feedback: QualityFeedback | null;
  // US-385: set when a per-grade charge was refunded/disputed — the grade's
  // public certificate is withheld and the submission is flagged for review.
  refunded_at: string | null;
  // US-340: the seller opted into the Verified Capture provenance path. The
  // badge is only AWARDED if the server-side checks also pass; opting in never
  // lowers a grade.
  verified_capture_opt_in: boolean;
  // US-773/US-569: durable grading job state. grading_started_at is stamped on
  // the first claim; grading_lease_until is the lease expiry (a live grade run
  // owns the row until then; an expired lease is re-claimable/resumable);
  // grading_attempts bounds resume retries of a poison submission.
  grading_started_at: string | null;
  grading_lease_until: string | null;
  grading_attempts: number;
  created_at: string;
  updated_at: string;
}

// Intentional design feature the grader judged present (does NOT lower grade).
export interface DetectedStyleAttribute {
  attribute: string;
  location: string;
  confidence: number;
}

// Genuine wear/damage the grader identified (NOT intentional design). Persisted
// on grade_reports.defects_found (migration 00058) — powers the Auto-Disclosure
// Engine's condition & flaws section + annotated defect photos.
export interface DefectFound {
  defect: string;
  severity: "minor" | "moderate" | "major";
  location: string;
  impact_on_grade?: string;
}

// Aggregated photo-authenticity assessment from the grading vision pass
// (US-336/US-338). A suspected result forces a human review; surfaced on the
// public certificate. Null on grades created before migration 00061.
export interface ImageAuthenticity {
  manipulation_suspected: boolean;
  manipulation_confidence: number;
  screenshot_or_watermark_detected: boolean;
  tells: string[];
  flagged_image_types: string[];
  summary: string;
}

// EXIF/provenance metadata captured client-side from the ORIGINAL file before
// compression (US-339). Every field is optional — absence is normal (re-shared
// photos, screenshots, stripped uploads) and is never penalized on its own.
// GPS, when present, is privacy-sensitive: access-controlled, never exposed
// publicly or to buyers.
export interface ImageExifMetadata {
  make?: string;
  model?: string;
  software?: string;
  lensModel?: string;
  orientation?: number;
  dateTime?: string;
  dateTimeOriginal?: string;
  gps?: { latitude: number; longitude: number };
}

// US-340: server-side Verified Capture provenance evaluation, persisted on
// grade_reports.verified_capture. A POSITIVE signal only — `verified: true`
// earned the certificate badge + a small confidence boost; it never lowers a
// grade and missing provenance is never penalized.
export interface VerifiedCaptureResult {
  verified: boolean;
  reasons: string[];
  device: string | null;
  with_exif: number;
  total: number;
  max_age_days: number;
  checked_at: string;
}

// US-341: server-side forensic manipulation pass fused with the US-336 vision
// signal, persisted on grade_reports.forensic_analysis. Internal anti-fraud
// data — never exposed on the public certificate. Null unless an uncompressed
// original was retained (US-339) so the pass actually ran.
export interface ForensicTamperAssessment {
  tamper_likelihood: number;
  manipulation_suspected: boolean;
  needs_review: boolean;
  confidence_penalty: number;
  forensic_ran: boolean;
  forensic_suspected: boolean;
  vision_suspected: boolean;
  tells: string[];
  summary: string;
  // Raw per-image forensic detail (structural scores + features).
  forensic?: unknown;
}

export interface SubmissionImageRow {
  id: string;
  submission_id: string;
  image_type: ImageType;
  storage_path: string;
  display_order: number;
  created_at: string;
  // US-337: 64-bit dHash (16 hex chars) for cross-submission photo-reuse
  // detection. Null when client-side hashing was unavailable.
  phash?: string | null;
  // US-339: structured EXIF/provenance read from the original file before
  // compression. Null/absent is normal.
  exif?: ImageExifMetadata | null;
  // US-339: path to the retained ORIGINAL (uncompressed, EXIF-intact) file in
  // the private bucket, for server-side forensic/provenance use. Null unless
  // original retention is enabled. Never public, never served to buyers.
  original_storage_path?: string | null;
}

export interface GradeReportRow {
  id: string;
  submission_id: string;
  overall_score: number;
  grade_tier: GradeTier;
  fabric_condition_score: number;
  structural_integrity_score: number;
  cosmetic_appearance_score: number;
  functional_elements_score: number;
  odor_cleanliness_score: number;
  ai_summary: string;
  // US-759: longer buyer-facing certified condition report. Null for grades
  // finalized before the write-up existed (the UI falls back to ai_summary).
  buyer_writeup: string | null;
  detailed_notes: Record<string, string> | null;
  // Intentional design features the AI recognized (distressing, raw hems, …).
  // These did NOT lower the grade — condition is graded vs. as-manufactured state.
  detected_style_attributes: DetectedStyleAttribute[];
  // Structured genuine defects (migration 00058). Empty array for historical
  // grades that never persisted them — the disclosure engine falls back to
  // detailed_notes.defects_summary in that case.
  defects_found: DefectFound[];
  // Raw per-image analysis trace (eval/training/dispute explanation). Nullable
  // for historical rows graded before migration 00050.
  per_image_analysis: unknown[] | null;
  confidence_score: number;
  needs_human_review: boolean;
  // Aggregated photo-authenticity assessment (US-336/US-338). Null for grades
  // created before migration 00061.
  image_authenticity: ImageAuthenticity | null;
  // US-340: Verified Capture provenance result. Null for grades produced before
  // the check / when the seller did not opt in.
  verified_capture: VerifiedCaptureResult | null;
  // US-341: forensic manipulation pass fused with the vision signal. Null unless
  // a retained original made the pass run (migration 00139). Internal — never
  // exposed on the public certificate view.
  forensic_analysis: ForensicTamperAssessment | null;
  // True once a human reviewer has checked this grade (migration 00061).
  human_reviewed: boolean;
  model_version: string;
  // First-class prompt version that produced this grade (e.g. "composite_v2").
  prompt_version: string | null;
  certificate_id: string | null;
  // US-333 tamper-evident integrity (migration 00068). Null for grades
  // finalized before the integrity scheme — they verify as "unverifiable".
  content_hash: string | null;
  content_signature: string | null;
  integrity_version: number | null;
  // US-769: aggregate certificate view count (no buyer PII). 0 until viewed.
  view_count: number;
  // US-479: set when an admin reject-and-regrade replaced this report with a
  // fresh grade. A non-null value means this is HISTORY — the active report for
  // the submission is the one with superseded_at IS NULL. Null for every report
  // graded before the regrade flow existed.
  superseded_at: string | null;
  created_at: string;
}

// US-348: public-safe projection of a certified grade report, served by the
// `public_grade_reports` view. Anonymous certificate viewers read THIS, never
// the base grade_reports row — so anti-fraud/internal signals (raw
// confidence_score, image_authenticity.tells, per_image_analysis,
// detailed_notes, content_signature, needs_human_review) are never exposed.
export type PublicConfidenceLabel = "very_high" | "high" | "moderate" | "reviewed";

export interface PublicGradeReportRow {
  id: string;
  submission_id: string;
  certificate_id: string;
  created_at: string;
  overall_score: number;
  grade_tier: GradeTier;
  fabric_condition_score: number;
  structural_integrity_score: number;
  cosmetic_appearance_score: number;
  functional_elements_score: number;
  odor_cleanliness_score: number;
  ai_summary: string;
  // US-759: longer buyer-facing certified condition report (null on older
  // certificates; the cert page falls back to ai_summary).
  buyer_writeup: string | null;
  model_version: string;
  human_reviewed: boolean;
  defects_found: DefectFound[];
  detected_style_attributes: DetectedStyleAttribute[];
  // Buyer-facing authenticity summary derived from image_authenticity; the raw
  // detection tells stay server-side so they can't be used to evade the check.
  authenticity_checked: boolean;
  authenticity_manipulation_suspected: boolean;
  authenticity_screenshot_or_watermark_detected: boolean;
  // Coarse confidence bucket — the precise confidence_score is not exposed.
  confidence_label: PublicConfidenceLabel;
  // US-340: true when the opt-in provenance checks passed (the certificate
  // "Verified Capture" badge). Only the pass/fail boolean is public — the raw
  // device/recency reasons stay server-side.
  verified_capture_passed: boolean;
}

export interface DisputeRow {
  id: string;
  grade_report_id: string;
  user_id: string;
  reason: string;
  status: DisputeStatus;
  resolution_notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  last_used_at: string | null;
  expires_at: string | null;
  webhook_url: string | null;
  created_at: string;
}

export interface InventoryItemRow {
  id: string;
  user_id: string;
  title: string;
  brand: string | null;
  garment_type: GarmentType | null;
  garment_category: GarmentCategory | null;
  size: string | null;
  color: string | null;
  acquired_price: number | null;
  acquired_date: string | null;
  acquired_source: string | null;
  condition_notes: string | null;
  status: ItemStatus;
  submission_id: string | null;
  grade_report_id: string | null;
  // FlipDesk extensions
  sku: string | null;
  item_category: ItemCategory | null;
  source_id: string | null;
  target_price: number | null;
  location_bin: string | null;
  measurements: Record<string, number | string> | null;
  material: string | null;
  grade_value: number | null;
  grade_label: string | null;
  certificate_url: string | null;
  // Tracking fields (mirror user's Google Sheet)
  container: string | null;
  style: string | null;
  description: string | null;
  sourced_by: string | null;
  comp_set: ItemComp[];
  // AI enrichment (US-158)
  ai_field_sources: Record<string, AiFieldSource>;
  ai_enriched_at: string | null;
  // eBay taxonomy mapping (migration 00030)
  ebay_category_id: string | null;
  ebay_aspects: Record<string, string[]> | null;
  // AutoLister: when listing fields were last AI-generated (migration 00052)
  ai_generated_aspects_at: string | null;
  // AI photo-QA readiness (US-537, migration 00090)
  photo_qa_score: number | null;
  photo_qa_issues: PhotoQaIssue[] | null;
  photo_qa_at: string | null;
  // Per-listing automation override (US-150, migration 00135)
  exclude_from_automations: boolean;
  // US-538: opt-in — AutoLister auto-attaches AI defect-callout photos
  // composited from the verified grade report (migration 00152).
  annotate_defect_photos: boolean;
  // US-600: consignment mode. consignor_id set ⇒ item is consigned.
  // consignment_split_pct snapshots the split at intake (null ⇒ use consignor's).
  consignor_id: string | null;
  consignment_split_pct: number | null;
  created_at: string;
  updated_at: string;
}

// US-537: one issue the photo-QA vision pass found with an item's photos.
export interface PhotoQaIssue {
  type:
    | "blurry"
    | "dark"
    | "overexposed"
    | "cropped"
    | "low_resolution"
    | "cluttered_background"
    | "glare"
    | "tag_unreadable"
    | "missing_angle"
    | "other";
  severity: "low" | "medium" | "high";
  message: string;
  // 1-based index of the offending photo, or null for set-level issues
  // (e.g. a missing back/tag shot).
  photo_index?: number | null;
}

export interface AiFieldSource {
  source: string; // e.g. "text", "photo:tag", "photo:front"
  confidence: number; // 0..1
  accepted: boolean;
}

export interface ListingRow {
  id: string;
  inventory_item_id: string;
  // Denormalized owning tenant (= inventory_items.user_id), kept in sync by the
  // set_listings_tenant trigger (US-410, migration 00146).
  user_id: string;
  platform: ListingPlatform;
  platform_listing_id: string | null;
  listing_url: string | null;
  listing_price: number;
  listed_at: string;
  is_active: boolean;
  notes: string | null;
  // FlipDesk extensions
  listing_title: string | null;
  listing_description: string | null;
  listing_status: ListingStatus;
  watchers: number;
  views: number;
  // Listing-composer picks (migration 00027)
  primary_photo_id: string | null;
  badge_enabled: boolean;
  // eBay handles (migrations 00031, 00034)
  platform_offer_id: string | null;
  platform_category_id: string | null;
  // AutoLister draft + publish fields (migration 00052)
  batch_id: string | null;
  scheduled_publish_at: string | null;
  publish_error: string | null;
  publish_failed_at: string | null;
  ebay_condition: string | null;
  ebay_condition_description: string | null;
  item_specifics_override: Record<string, string[]> | null;
  return_policy_id: string | null;
  shipping_policy_id: string | null;
  payment_policy_id: string | null;
  quantity: number;
  best_offer_enabled: boolean;
  // US-562: per-listing best-offer auto-clear thresholds (cents). NULL → derive
  // from the comp range (p75 → accept, p25 → decline) at publish.
  best_offer_auto_accept_cents: number | null;
  best_offer_auto_decline_cents: number | null;
  synced_to_ebay_at: string | null;
  price_is_estimated: boolean;
  // US-542: comp-derived price range + confidence + source. price_comp_source
  // is one of: 'ai_estimate' | 'active_asking' | 'private_sales' | 'ebay_sold'.
  // price_is_estimated is false only for the sold-backed sources.
  price_range_low_cents: number | null;
  price_range_high_cents: number | null;
  price_confidence: number | null;
  price_comp_source: string | null;
  // Per-field winning source for cross-source sync conflicts, e.g.
  // {"price": "flipdesk"} (US-148, migration 00133). A field pinned to a
  // non-eBay source is protected from the eBay pull's default overwrite.
  source_of_truth: Record<string, string>;
  // Cross-listing group key (US-149, migration 00134): siblings created by a
  // multi-marketplace push share the source draft's id; the source draft
  // points at itself.
  draft_id: string | null;
  // Promoted Listings ad rate (US-150, migration 00135). promo_rate_pct is the
  // seller's accepted/adjusted ad rate (%); null falls back to the category
  // suggestion at publish. The rest (US-561, migration 00157) is the eBay-side
  // ad state surfaced post-publish.
  promo_rate_pct: number | null;
  // US-561: per-listing opt-out from Promoted Listings; eBay campaign/ad handles
  // created at publish; lifecycle status ('active'|'failed'|eBay's adStatus);
  // accrued ad spend (cents, charged only on sale); last performance sync.
  promo_opt_out: boolean;
  promo_campaign_id: string | null;
  promo_ad_id: string | null;
  promo_status: string | null;
  promo_ad_fees_cents: number;
  promo_synced_at: string | null;
  // Listing-performance metrics from Sell Analytics getTrafficReport
  // (US-151, migration 00136), synced every 6h. view_trend_7d is a rolling
  // per-day array of views snapshots (oldest→newest, max 7) for the sparkline.
  views_total: number;
  watchers_count: number;
  impressions_7d: number;
  click_through_rate: number | null;
  last_metrics_synced_at: string | null;
  view_trend_7d: Array<{ date: string; views: number }>;
  // US-547/US-551: snapshot of the AI's generated fields at draft time. Stays
  // immutable as the seller edits the live columns, so the composer + bulk grid
  // can diff edited-vs-AI and offer a per-field revert-to-AI. Null for listings
  // that were never AI-generated (manual drafts).
  ai_generated_snapshot: ListingAiSnapshot | null;
  // US-568: listing format + auction terms + variation matrix. listing_format
  // is 'fixed_price' (default) or 'auction'; the auction price columns are cents
  // and only consulted when the format is 'auction'. variations is the
  // multi-variant matrix (null/empty → single-SKU listing).
  listing_format: ListingFormat;
  auction_start_price_cents: number | null;
  auction_reserve_price_cents: number | null;
  auction_buy_it_now_price_cents: number | null;
  auction_duration: string | null;
  variations: ListingVariations | null;
  created_at: string;
  updated_at: string;
}

// US-568: eBay offer format. Mirrors listings.listing_format.
export type ListingFormat = "fixed_price" | "auction";

// US-568: one variant of a multi-variant listing. aspects names the
// variation values (e.g. {"Size":"M","Color":"Red"}); quantity is per-variant
// stock; price_cents optionally overrides the listing price for this variant;
// sku_suffix is appended to the base SKU when publishing (derived from the
// aspects when omitted).
export interface ListingVariation {
  aspects: Record<string, string>;
  quantity: number;
  price_cents?: number | null;
  sku_suffix?: string | null;
}

// US-568: shape of listings.variations. specifications are the varies-by
// aspect names (e.g. ["Size", "Color"]); variants enumerates the combinations.
export interface ListingVariations {
  specifications: string[];
  variants: ListingVariation[];
}

// US-551: shape of listings.ai_generated_snapshot (written in ai-listing.ts).
export interface ListingAiSnapshot {
  title?: string | null;
  description?: string | null;
  price_cents?: number | null;
  ebay_condition?: string | null;
  condition_description?: string | null;
  category_id?: string | null;
  item_specifics?: Record<string, string[]> | null;
}

export interface SaleRow {
  id: string;
  inventory_item_id: string;
  // Denormalized owning tenant (= inventory_items.user_id), kept in sync by the
  // set_sales_tenant trigger (US-410, migration 00146).
  user_id: string;
  listing_id: string | null;
  sale_price: number;
  platform_fees: number;
  sale_date: string;
  buyer_username: string | null;
  buyer_notes: string | null;
  // FlipDesk extensions
  shipping_collected: number;
  payment_processing_fees: number;
  shipping_cost: number;
  grading_cost: number;
  other_costs: number;
  net_profit: number | null;
  buyer_id: string | null;
  sold_at: string | null;
  shipped_at: string | null;
  tracking_number: string | null;
  payout_reference: string | null;
  tax: number;
  payout_amount: number | null;
  // Sale lifecycle (00111). Only 'completed' counts toward revenue/profit/sold.
  status: "completed" | "cancelled" | "refunded" | "pending";
  cancelled_at: string | null;
  created_at: string;
}

// ─── FlipDesk rows ─────────────────────────────────────────────────

export interface SourceRow {
  id: string;
  user_id: string;
  name: string;
  source_type: FlipdeskSourceType;
  location: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// US-600: consignment mode. Base table from 00107 (US-676); the status /
// Stripe-Connect / intake columns are added in 00171.
export interface ConsignorRow {
  id: string;
  user_id: string;
  name: string;
  contact_email: string | null;
  contact_phone: string | null;
  default_split_pct: number;
  notes: string | null;
  // 00171 web-portal additions.
  status: ConsignorStatus;
  stripe_connect_account_id: string | null;
  payouts_enabled: boolean;
  intake_signed_at: string | null;
  intake_signature_name: string | null;
  intake_agreement_version: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConsignorInsert {
  user_id: string;
  name: string;
  contact_email?: string | null;
  contact_phone?: string | null;
  default_split_pct?: number;
  status?: ConsignorStatus;
  notes?: string | null;
}

export type ConsignorUpdate = Partial<
  Omit<ConsignorRow, "id" | "user_id" | "created_at" | "updated_at">
>;

export interface ConsignorPnlRow {
  consignor_id: string;
  user_id: string;
  name: string;
  default_split_pct: number;
  status: ConsignorStatus;
  payouts_enabled: boolean;
  total_items: number;
  items_sold: number;
  gross_revenue: number;
  net_proceeds: number;
  consignor_share: number;
  store_share: number;
  payouts_paid: number;
  payouts_pending: number;
  balance_owed: number;
}

export interface ConsignorPayoutRow {
  id: string;
  user_id: string;
  consignor_id: string;
  sale_id: string | null;
  inventory_item_id: string | null;
  amount: number;
  status: ConsignorPayoutStatus;
  stripe_transfer_id: string | null;
  note: string | null;
  error: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConsignorPayoutInsert {
  user_id: string;
  consignor_id: string;
  sale_id?: string | null;
  inventory_item_id?: string | null;
  amount: number;
  status?: ConsignorPayoutStatus;
  note?: string | null;
}

export type ConsignorPayoutUpdate = Partial<
  Omit<ConsignorPayoutRow, "id" | "user_id" | "consignor_id" | "created_at" | "updated_at">
>;

export interface ItemPhotoRow {
  id: string;
  inventory_item_id: string;
  photo_url: string;
  storage_path: string | null;
  photo_type: FlipdeskPhotoType;
  sort_order: number;
  used_for_grading: boolean;
  ebay_uploaded: boolean;
  archived_to_r2: boolean;
  created_at: string;
  // 00035 — thumbnails generated client-side at upload time.
  thumbnail_url: string | null;
  thumbnail_storage_path: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  // 00066 — photo-dump reconciliation: original EXIF capture time + session.
  captured_at: string | null;
  reconcile_session_id: string | null;
}

export type ReconcileSessionStatus = "open" | "committed" | "abandoned";

// One entry of the persisted assignment snapshot (00067) — enough to restore
// the cluster grouping on reload. Photo blobs themselves are re-bound client-side.
export interface ReconcileAssignmentSnapshot {
  id: string;
  capturedAt: string | null;
  name: string;
  clusterId: string | null;
  manual: boolean;
  // US-289: when a photo was staged by the iOS app (uploaded to storage before
  // an item exists), this points at the already-uploaded blob in the
  // `item-photos` bucket. The web board hydrates a preview from it on restore
  // and, at commit, references the existing object instead of re-uploading.
  // Absent for browser-staged photos whose blob lives only in memory.
  storagePath?: string | null;
  photoType?: FlipdeskPhotoType | null;
}

export interface ReconcileSessionRow {
  id: string;
  user_id: string;
  photo_count: number;
  status: ReconcileSessionStatus;
  assignments: ReconcileAssignmentSnapshot[];
  gap_seconds: number;
  created_at: string;
  updated_at: string;
}

export interface ReconcileSessionInsert {
  user_id: string;
  photo_count?: number;
  status?: ReconcileSessionStatus;
  assignments?: ReconcileAssignmentSnapshot[];
  gap_seconds?: number;
}

export type ReconcileSessionUpdate = Partial<
  Omit<ReconcileSessionRow, "id" | "user_id" | "created_at" | "updated_at">
>;

export interface MarketplaceConnectionRow {
  id: string;
  user_id: string;
  marketplace: ListingPlatform;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
  account_handle: string | null;
  // 00140: marketplace-stable account id (eBay /commerce/identity userId), used
  // to match account-deletion webhooks on a verified id, not the handle (US-364).
  external_account_id: string | null;
  scopes: string[];
  is_active: boolean;
  last_synced_at: string | null;
  last_refresh_attempt_at: string | null;
  refresh_error: string | null;
  // 00054: cached default Sell Inventory location key (US-314).
  merchant_location_key: string | null;
  // 00136: set when getTrafficReport 403s for missing Sell Analytics access
  // (US-151) so the UI can prompt a reconnect to enable performance metrics.
  analytics_access_denied: boolean;
  created_at: string;
  updated_at: string;
}

// AutoLister batch generation (migration 00052)
export interface ListingGenerationBatchRow {
  id: string;
  user_id: string;
  status: ListingGenerationStatus;
  source: ListingGenerationSource;
  item_count: number;
  succeeded_count: number;
  failed_count: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListingGenerationBatchInsert {
  user_id: string;
  status?: ListingGenerationStatus;
  source?: ListingGenerationSource;
  item_count?: number;
  succeeded_count?: number;
  failed_count?: number;
  error?: string | null;
}

export type ListingGenerationBatchUpdate = Partial<
  Omit<ListingGenerationBatchRow, "id" | "user_id" | "created_at" | "updated_at">
>;

export interface ListingGenerationJobRow {
  id: string;
  batch_id: string;
  inventory_item_id: string;
  status: ListingGenerationJobStatus;
  error: string | null;
  attempts: number;
  listing_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListingGenerationJobInsert {
  batch_id: string;
  inventory_item_id: string;
  status?: ListingGenerationJobStatus;
  error?: string | null;
  attempts?: number;
  listing_id?: string | null;
}

export type ListingGenerationJobUpdate = Partial<
  Omit<ListingGenerationJobRow, "id" | "batch_id" | "inventory_item_id" | "created_at">
>;

export interface BusinessPolicyRow {
  id: string;
  user_id: string;
  marketplace: ListingPlatform;
  policy_id: string;
  policy_type: BusinessPolicyType;
  policy_name: string | null;
  policy_data: Record<string, unknown> | null;
  is_default: boolean;
  synced_from_ebay_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessPolicyInsert {
  user_id: string;
  marketplace: ListingPlatform;
  policy_id: string;
  policy_type: BusinessPolicyType;
  policy_name?: string | null;
  policy_data?: Record<string, unknown> | null;
  is_default?: boolean;
  synced_from_ebay_at?: string | null;
}

export type BusinessPolicyUpdate = Partial<
  Omit<BusinessPolicyRow, "id" | "user_id" | "created_at" | "updated_at">
>;

export interface PayoutImportRow {
  id: string;
  user_id: string;
  marketplace: ListingPlatform;
  import_method: PayoutImportMethod;
  raw_payload: Record<string, unknown>;
  reconciled: boolean;
  sale_id: string | null;
  payout_date: string | null;
  amount: number | null;
  created_at: string;
  updated_at: string;
}

// Read-only join of inventory_items + most-recent listing + sale.
// Backed by the items_full view (migration 00009).
export interface ItemFullRow {
  id: string;
  user_id: string;
  item_number: string | null;
  container: string | null;
  item_title: string;
  item_description: string | null;
  brand: string | null;
  style: string | null;
  size: string | null;
  notes: string | null;
  comps: ItemComp[];
  category: string | null;
  source_name: string | null;
  source_id: string | null;
  sourced_by: string | null;
  purchase_date: string | null;
  purchase_price: number | null;
  listed: boolean;
  list_date: string | null;
  link: string | null;
  list_price: number | null;
  sale_date: string | null;
  sale_price: number | null;
  fees: number | null;
  tax: number | null;
  shipping_cost: number | null;
  net_profit: number | null;
  payout: number | null;
  status: ItemStatus;
  days_to_sell: number | null;
  tracking: string | null;
  target_price: number | null;
  grade_value: number | null;
  grade_label: string | null;
  certificate_url: string | null;
  measurements: Record<string, number | string> | null;
  location_bin: string | null;
  created_at: string;
  updated_at: string;
  // Trailing columns added in migration 00012
  buyer_id: string | null;
  sold_at_raw: string | null;
  payout_reference: string | null;
  listing_status: ListingStatus | null;
  // Trailing columns added in migration 00013
  listing_id: string | null;
  listing_watchers: number | null;
  listing_views: number | null;
  // Trailing columns added in migration 00018
  photo_count: number;
  has_required_photos: boolean;
  // Trailing columns added in migration 00033 — AI provenance for fields
  // and prefixed measurement keys (measurements.<field>).
  ai_field_sources: Record<string, AiFieldSource> | null;
  ai_enriched_at: string | null;
  // Trailing columns added in migration 00111 — sale lifecycle. Null when the
  // item has no sale. Only 'completed' counts toward sold/revenue/profit.
  sale_status: "completed" | "cancelled" | "refunded" | "pending" | null;
  sale_cancelled_at: string | null;
}

// ── Admin task / project management (00047) ──────────────────────────────
export type AdminTaskStatus = "todo" | "in_progress" | "blocked" | "done";
export type AdminTaskPriority = "low" | "medium" | "high";

export interface AdminTaskProjectRow {
  id: string;
  title: string;
  description: string | null;
  archived: boolean;
  position: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminTaskProjectInsert {
  title: string;
  description?: string | null;
  archived?: boolean;
  position?: number;
}

export type AdminTaskProjectUpdate = Partial<
  Omit<AdminTaskProjectRow, "id" | "created_by" | "created_at" | "updated_at">
>;

export interface AdminTaskRow {
  id: string;
  project_id: string;
  title: string;
  body: string | null;
  section: string | null;
  status: AdminTaskStatus;
  priority: AdminTaskPriority;
  due_date: string | null;
  position: number;
  created_by: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminTaskInsert {
  project_id: string;
  title: string;
  body?: string | null;
  section?: string | null;
  status?: AdminTaskStatus;
  priority?: AdminTaskPriority;
  due_date?: string | null;
  position?: number;
  completed_at?: string | null;
}

export type AdminTaskUpdate = Partial<
  Omit<AdminTaskRow, "id" | "project_id" | "created_by" | "created_at" | "updated_at">
>;

export interface AdminTaskCommentRow {
  id: string;
  task_id: string;
  author_id: string | null;
  body: string;
  created_at: string;
}

export interface AdminTaskCommentInsert {
  task_id: string;
  body: string;
}

export type AdminTaskCommentUpdate = Partial<Pick<AdminTaskCommentRow, "body">>;

export interface SavedViewRow {
  id: string;
  user_id: string;
  name: string;
  emoji: string | null;
  query_json: Record<string, unknown>;
  pinned: boolean;
  scope: string;
  created_at: string;
}

export interface SavedViewInsert {
  user_id: string;
  name: string;
  emoji?: string | null;
  query_json: Record<string, unknown>;
  pinned?: boolean;
  scope?: string;
}

export type SavedViewUpdate = Partial<
  Omit<SavedViewRow, "id" | "user_id" | "created_at">
>;

export interface ExpenseRow {
  id: string;
  user_id: string;
  category: ExpenseCategory;
  description: string | null;
  amount: number;
  spent_on: string;
  created_at: string;
  updated_at: string;
}

export interface ExpenseInsert {
  user_id: string;
  category?: ExpenseCategory;
  description?: string | null;
  amount: number;
  spent_on?: string;
}

export type ExpenseUpdate = Partial<
  Omit<ExpenseRow, "id" | "user_id" | "created_at" | "updated_at">
>;

// A snapshot of one eBay listing, imported from the eBay Active Listings CSV
// report. `custom_label` is eBay's "Custom label (SKU)" field. Backed by the
// flipdesk_ebay_listings table (migration 00020).
export type EbayMatchStatus = "matched" | "unmatched" | "ignored";

export interface EbayListingRow {
  id: string;
  user_id: string;
  ebay_item_id: string;
  custom_label: string | null;
  title: string | null;
  current_price: number | null;
  available_quantity: number | null;
  listing_url: string | null;
  listing_format: string | null;
  start_date: string | null;
  matched_item_id: string | null;
  match_status: EbayMatchStatus;
  raw: Record<string, unknown>;
  imported_at: string;
  created_at: string;
  updated_at: string;
}

export interface EbayListingInsert {
  user_id: string;
  ebay_item_id: string;
  custom_label?: string | null;
  title?: string | null;
  current_price?: number | null;
  available_quantity?: number | null;
  listing_url?: string | null;
  listing_format?: string | null;
  start_date?: string | null;
  matched_item_id?: string | null;
  match_status?: EbayMatchStatus;
  raw?: Record<string, unknown>;
  imported_at?: string;
}

export type EbayListingUpdate = Partial<
  Omit<EbayListingRow, "id" | "user_id" | "ebay_item_id" | "created_at" | "updated_at">
>;

// Per-user FlipDesk behavior settings (US-149, migration 00134). One row per
// user, created lazily on first write; absent row = all defaults.
export interface FlipdeskSettingsRow {
  user_id: string;
  auto_end_cross_listings: boolean;
  // Global default (migration 00145): burn the grade badge onto the hero photo
  // and append the certificate link to the description for graded listings.
  auto_grade_badge: boolean;
  created_at: string;
  updated_at: string;
}

export interface FlipdeskSettingsInsert {
  user_id: string;
  auto_end_cross_listings?: boolean;
  auto_grade_badge?: boolean;
}

export type FlipdeskSettingsUpdate = Partial<
  Omit<FlipdeskSettingsRow, "user_id" | "created_at" | "updated_at">
>;

export interface FlipdeskGradingSubmissionRow {
  id: string;
  inventory_item_id: string;
  submission_id: string | null;
  gradethread_submission_id: string | null;
  tier: GradingSubmissionTier;
  status: SubmissionStatus;
  cost: number;
  submitted_at: string | null;
  graded_at: string | null;
  webhook_received_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShipmentRow {
  id: string;
  sale_id: string;
  carrier: string;
  tracking_number: string | null;
  shipping_cost: number;
  label_cost: number;
  ship_date: string | null;
  delivery_date: string | null;
  weight_oz: number | null;
  created_at: string;
  updated_at: string;
}

export interface AdminAuditLogRow {
  id: string;
  // Null for SYSTEM-originated entries (e.g. the content scheduler tick);
  // actor_role is 'system' in that case. (US-269)
  admin_user_id: string | null;
  actor_role: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface HumanReviewRow {
  id: string;
  grade_report_id: string;
  reviewer_id: string;
  original_score: number;
  adjusted_score: number | null;
  // Optional per-factor corrections — null where the reviewer didn't change a
  // factor. Drives real per-factor accuracy (vs. estimating from overall).
  adjusted_fabric_condition: number | null;
  adjusted_structural_integrity: number | null;
  adjusted_cosmetic_appearance: number | null;
  adjusted_functional_elements: number | null;
  adjusted_odor_cleanliness: number | null;
  // Reviewer flag: AI mistook an intentional design feature for damage.
  intentional_misread: boolean;
  review_notes: string | null;
  reviewed_at: string;
}

export interface AiPromptVersionRow {
  id: string;
  version_name: string;
  prompt_text: string;
  is_active: boolean;
  accuracy_score: number | null;
  total_grades: number;
  // Which grading stage this prompt drives + optional category scope (00050).
  // listing_gen joined the stages for AutoLister listing prompts (US-547).
  stage: "per_image" | "composite" | "listing_gen";
  garment_scope: string | null;
  eval_passed: boolean | null;
  eval_run_id: string | null;
  notes: string | null;
  created_at: string;
}

export interface GradingEvalCaseRow {
  id: string;
  label: string;
  garment_type: GarmentType;
  garment_category: GarmentCategory;
  brand: string | null;
  description: string | null;
  style_attributes: string[];
  images: Array<{ image_type: string; storage_path: string }>;
  expected_score: number;
  expected_tier: GradeTier;
  tags: string[];
  is_active: boolean;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface GradingEvalRunRow {
  id: string;
  prompt_version_id: string | null;
  prompt_version_name: string;
  model: string;
  mean_absolute_error: number;
  agreement_rate: number;
  cases_total: number;
  cases_passed: number;
  passed: boolean;
  per_case: unknown[];
  per_tag: Record<string, unknown>;
  triggered_by: string | null;
  created_at: string;
}

// US-308: Google Search Console search-performance ingestion.
// Admin-only — one row per (date, site_url, page, query, country, device).
export interface GscPerformanceRow {
  id: string;
  date: string;
  site_url: string;
  page: string | null;
  query: string | null;
  country: string | null;
  device: string | null;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
  ingested_at: string;
}

export interface GscPerformanceInsert {
  date: string;
  site_url: string;
  page?: string | null;
  query?: string | null;
  country?: string | null;
  device?: string | null;
  impressions?: number;
  clicks?: number;
  ctr?: number;
  position?: number;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  message: string;
  link: string | null;
  is_read: boolean;
  created_at: string;
}

// ─── Insert types ──────────────────────────────────────────────────

export interface UserInsert {
  id: string;
  email: string;
  full_name?: string | null;
  avatar_url?: string | null;
  /** @deprecated kept for legacy compatibility; new code should not set this. */
  plan?: UserPlan;
  role?: UserRole;
  stripe_customer_id?: string | null;
  flipdesk_plan?: FlipdeskPlan;
  flipdesk_interval?: BillingInterval | null;
  subscription_status?: SubscriptionStatus;
  flipdesk_subscription_id?: string | null;
  flipdesk_period_end?: string | null;
  flipdesk_pause_until?: string | null;
  flipdesk_cancel_at_period_end?: boolean;
  grade_credit_balance?: number;
  trial_ends_at?: string | null;
  pending_flipdesk_plan?: FlipdeskPlan | null;
  pending_flipdesk_interval?: BillingInterval | null;
  pending_schedule_id?: string | null;
  pending_effective_at?: string | null;
}

export interface SubmissionInsert {
  user_id: string;
  garment_type: GarmentType;
  garment_category: GarmentCategory;
  brand?: string | null;
  title: string;
  description?: string | null;
  style_attributes?: string[];
  verified_capture_opt_in?: boolean;
}

export interface SubmissionImageInsert {
  submission_id: string;
  image_type: ImageType;
  storage_path: string;
  display_order?: number;
  phash?: string | null;
  exif?: ImageExifMetadata | null;
  original_storage_path?: string | null;
}

export interface GradeReportInsert {
  submission_id: string;
  overall_score: number;
  grade_tier: GradeTier;
  fabric_condition_score: number;
  structural_integrity_score: number;
  cosmetic_appearance_score: number;
  functional_elements_score: number;
  odor_cleanliness_score: number;
  ai_summary: string;
  detailed_notes?: Record<string, string> | null;
  detected_style_attributes?: DetectedStyleAttribute[];
  per_image_analysis?: unknown[] | null;
  confidence_score: number;
  needs_human_review?: boolean;
  verified_capture?: VerifiedCaptureResult | null;
  forensic_analysis?: ForensicTamperAssessment | null;
  model_version: string;
  prompt_version?: string | null;
  certificate_id?: string | null;
  content_hash?: string | null;
  content_signature?: string | null;
  integrity_version?: number | null;
  superseded_at?: string | null;
}

export interface DisputeInsert {
  grade_report_id: string;
  user_id: string;
  reason: string;
}

export interface ApiKeyInsert {
  user_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  expires_at?: string | null;
  webhook_url?: string | null;
}

export interface InventoryItemInsert {
  user_id: string;
  title: string;
  brand?: string | null;
  garment_type?: GarmentType | null;
  garment_category?: GarmentCategory | null;
  size?: string | null;
  color?: string | null;
  acquired_price?: number | null;
  acquired_date?: string | null;
  acquired_source?: string | null;
  condition_notes?: string | null;
  status?: ItemStatus;
  submission_id?: string | null;
  grade_report_id?: string | null;
  sku?: string | null;
  item_category?: ItemCategory | null;
  source_id?: string | null;
  target_price?: number | null;
  location_bin?: string | null;
  measurements?: Record<string, number | string> | null;
  material?: string | null;
  grade_value?: number | null;
  grade_label?: string | null;
  certificate_url?: string | null;
  container?: string | null;
  style?: string | null;
  description?: string | null;
  sourced_by?: string | null;
  comp_set?: ItemComp[];
  ai_field_sources?: Record<string, AiFieldSource>;
  ai_enriched_at?: string | null;
  ebay_category_id?: string | null;
  ebay_aspects?: Record<string, string[]> | null;
  ai_generated_aspects_at?: string | null;
  exclude_from_automations?: boolean;
}

export interface ListingInsert {
  inventory_item_id: string;
  // Optional: derived from inventory_item_id by the set_listings_tenant trigger
  // when omitted (US-410).
  user_id?: string;
  platform: ListingPlatform;
  platform_listing_id?: string | null;
  listing_url?: string | null;
  listing_price: number;
  listed_at?: string;
  is_active?: boolean;
  notes?: string | null;
  listing_title?: string | null;
  listing_description?: string | null;
  listing_status?: ListingStatus;
  watchers?: number;
  views?: number;
  primary_photo_id?: string | null;
  badge_enabled?: boolean;
  // eBay handles (migrations 00031, 00034)
  platform_offer_id?: string | null;
  platform_category_id?: string | null;
  // AutoLister (migration 00052)
  batch_id?: string | null;
  scheduled_publish_at?: string | null;
  publish_error?: string | null;
  publish_failed_at?: string | null;
  ebay_condition?: string | null;
  ebay_condition_description?: string | null;
  item_specifics_override?: Record<string, string[]> | null;
  return_policy_id?: string | null;
  shipping_policy_id?: string | null;
  payment_policy_id?: string | null;
  quantity?: number;
  best_offer_enabled?: boolean;
  best_offer_auto_accept_cents?: number | null;
  best_offer_auto_decline_cents?: number | null;
  synced_to_ebay_at?: string | null;
  price_is_estimated?: boolean;
  // US-542: comp-derived price range + confidence + source.
  price_range_low_cents?: number | null;
  price_range_high_cents?: number | null;
  price_confidence?: number | null;
  price_comp_source?: string | null;
  // Cross-listing group key (US-149)
  draft_id?: string | null;
  // Promoted Listings (US-150 / US-561). promo_rate_pct = the accepted/adjusted
  // ad rate; promo_opt_out turns promotion off for this listing.
  promo_rate_pct?: number | null;
  promo_opt_out?: boolean;
  // US-568: format + auction terms + variation matrix.
  listing_format?: ListingFormat;
  auction_start_price_cents?: number | null;
  auction_reserve_price_cents?: number | null;
  auction_buy_it_now_price_cents?: number | null;
  auction_duration?: string | null;
  variations?: ListingVariations | null;
}

export interface SaleInsert {
  inventory_item_id: string;
  // Optional: derived from inventory_item_id by the set_sales_tenant trigger when
  // omitted (US-410).
  user_id?: string;
  listing_id?: string | null;
  sale_price: number;
  platform_fees?: number;
  sale_date?: string;
  buyer_username?: string | null;
  buyer_notes?: string | null;
  shipping_collected?: number;
  payment_processing_fees?: number;
  shipping_cost?: number;
  grading_cost?: number;
  other_costs?: number;
  net_profit?: number | null;
  buyer_id?: string | null;
  sold_at?: string | null;
  shipped_at?: string | null;
  tracking_number?: string | null;
  payout_reference?: string | null;
  tax?: number;
  payout_amount?: number | null;
}

// ─── FlipDesk inserts ──────────────────────────────────────────────

export interface SourceInsert {
  user_id: string;
  name: string;
  source_type?: FlipdeskSourceType;
  location?: string | null;
  notes?: string | null;
}

export interface ItemPhotoInsert {
  inventory_item_id: string;
  photo_url: string;
  storage_path?: string | null;
  photo_type?: FlipdeskPhotoType;
  sort_order?: number;
  used_for_grading?: boolean;
  ebay_uploaded?: boolean;
  archived_to_r2?: boolean;
  captured_at?: string | null;
  reconcile_session_id?: string | null;
}

export interface MarketplaceConnectionInsert {
  user_id: string;
  marketplace: ListingPlatform;
  access_token_encrypted?: string | null;
  refresh_token_encrypted?: string | null;
  token_expires_at?: string | null;
  account_handle?: string | null;
  scopes?: string[];
  is_active?: boolean;
  merchant_location_key?: string | null;
}

// US-146: Google Sheets connection (migration 00131). The SPA only ever READs
// its own row (status surfacing) — writes go through the service-role edge
// client — but typing Insert/Update keeps the table shape in one place.
export interface GoogleConnectionRow {
  id: string;
  user_id: string;
  google_email: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  sheet_id: string | null;
  sheet_url: string | null;
  last_sync_at: string | null;
  sync_status: string;
  sync_error: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface GoogleConnectionInsert {
  user_id: string;
  google_email?: string | null;
  access_token_enc?: string | null;
  refresh_token_enc?: string | null;
  token_expires_at?: string | null;
  sheet_id?: string | null;
  sheet_url?: string | null;
  sync_status?: string;
  is_active?: boolean;
}

export interface PayoutImportInsert {
  user_id: string;
  marketplace: ListingPlatform;
  import_method: PayoutImportMethod;
  raw_payload: Record<string, unknown>;
  reconciled?: boolean;
  sale_id?: string | null;
  payout_date?: string | null;
  amount?: number | null;
}

export interface FlipdeskGradingSubmissionInsert {
  inventory_item_id: string;
  submission_id?: string | null;
  gradethread_submission_id?: string | null;
  tier?: GradingSubmissionTier;
  status?: SubmissionStatus;
  cost?: number;
  submitted_at?: string | null;
}

export interface ShipmentInsert {
  sale_id: string;
  carrier: string;
  tracking_number?: string | null;
  shipping_cost: number;
  label_cost?: number;
  ship_date?: string | null;
  delivery_date?: string | null;
  weight_oz?: number | null;
}

export interface AdminAuditLogInsert {
  admin_user_id: string;
  action: string;
  target_type: string;
  target_id?: string | null;
  details?: Record<string, unknown> | null;
}

export interface HumanReviewInsert {
  grade_report_id: string;
  reviewer_id: string;
  original_score: number;
  adjusted_score?: number | null;
  adjusted_fabric_condition?: number | null;
  adjusted_structural_integrity?: number | null;
  adjusted_cosmetic_appearance?: number | null;
  adjusted_functional_elements?: number | null;
  adjusted_odor_cleanliness?: number | null;
  intentional_misread?: boolean;
  review_notes?: string | null;
}

export interface AiPromptVersionInsert {
  version_name: string;
  prompt_text: string;
  is_active?: boolean;
  accuracy_score?: number | null;
  total_grades?: number;
  stage?: "per_image" | "composite" | "listing_gen";
  garment_scope?: string | null;
  eval_passed?: boolean | null;
  eval_run_id?: string | null;
  notes?: string | null;
}

export interface GradingEvalCaseInsert {
  label: string;
  garment_type: GarmentType;
  garment_category: GarmentCategory;
  brand?: string | null;
  description?: string | null;
  style_attributes?: string[];
  images: Array<{ image_type: string; storage_path: string }>;
  expected_score: number;
  expected_tier: GradeTier;
  tags?: string[];
  is_active?: boolean;
  notes?: string | null;
  created_by?: string | null;
}

export interface NotificationInsert {
  user_id: string;
  type: NotificationType;
  title: string;
  message: string;
  link?: string | null;
  is_read?: boolean;
}

// ─── AI enrichment log (US-158) ────────────────────────────────────

export type AiInputKind = "text" | "photo" | "both";

export interface AiEnrichmentLogRow {
  id: string;
  user_id: string;
  inventory_item_id: string | null;
  model: string;
  input_kind: AiInputKind;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latency_ms: number;
  suggested_fields: Record<string, unknown>;
  accepted_fields: Record<string, unknown>;
  created_at: string;
}

export interface AiEnrichmentLogInsert {
  user_id: string;
  inventory_item_id?: string | null;
  model: string;
  input_kind: AiInputKind;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  latency_ms?: number;
  suggested_fields?: Record<string, unknown>;
  accepted_fields?: Record<string, unknown>;
}

export type AiEnrichmentLogUpdate = Partial<
  Pick<AiEnrichmentLogRow, "accepted_fields">
>;

// Grade credit ledger (US-201). Append-only — inserted only by the
// debit_grade_credits / grant_grade_credits SECURITY DEFINER functions.
export interface GradeCreditTransactionRow {
  id: string;
  user_id: string;
  delta: number;
  reason: GradeCreditReason;
  // US-398: NULL for zero-delta audit rows (included_grant / included refund).
  balance_after: number | null;
  submission_id: string | null;
  stripe_payment_intent_id: string | null;
  notes: string | null;
  created_at: string;
}

// FlipDesk subscription event log (US-201). Idempotency + audit trail for
// Stripe webhooks. Service-role writes only.
export interface FlipdeskSubscriptionEventRow {
  id: string;
  user_id: string;
  stripe_event_id: string | null;
  event_type: string;
  from_plan: FlipdeskPlan | null;
  to_plan: FlipdeskPlan | null;
  raw_payload: Record<string, unknown> | null;
  created_at: string;
}

export interface FlipdeskSubscriptionEventInsert {
  user_id: string;
  stripe_event_id?: string | null;
  event_type: string;
  from_plan?: FlipdeskPlan | null;
  to_plan?: FlipdeskPlan | null;
  raw_payload?: Record<string, unknown> | null;
}

// US-587: data-driven plan pricing/limits (00166_pricing_plans.sql). Read by the
// SPA (anon SELECT) for pricing display; written only by the audited admin edge
// route. gate_flags mirrors FlipdeskGateFlags in src/lib/constants.ts.
export interface PricingPlanRow {
  key: FlipdeskPlan;
  name: string;
  sort_order: number;
  price_monthly_cents: number;
  price_yearly_cents: number;
  active_listing_cap: number;
  ai_actions_per_month: number;
  marketplaces_cap: number;
  included_standard_grades_per_month: number;
  team_seat_cap: number;
  features: string[];
  gate_flags: Record<string, boolean>;
  stripe_price_monthly: string;
  stripe_price_yearly: string;
  updated_at: string;
  updated_by: string | null;
}

// Closed-loop sale-outcome feedback (US-132). Written via SECURITY DEFINER
// triggers on sales + disputes — never inserted from app code.
export interface GradeOutcomeRow {
  id: string;
  grade_report_id: string;
  inventory_item_id: string | null;
  sale_id: string | null;
  listing_price: number | null;
  sold_price: number | null;
  sold_at: string | null;
  dispute_reported: boolean;
  source: string;
  created_at: string;
  updated_at: string;
}

// ─── Growth / Promote suite (00102_growth_suite.sql) ───────────────

export type CampaignChannel = "email" | "in_app" | "push";
export type CampaignStatus =
  | "draft"
  | "scheduled"
  | "sending"
  | "sent"
  | "failed"
  | "canceled";
export type CampaignRecipientStatus = "pending" | "sent" | "failed" | "skipped";
export type AnnouncementVariant = "info" | "success" | "warning" | "promo";
export type ReferralRewardStatus = "pending" | "qualified" | "granted" | "void";

/** A single segment condition — field + operator + value, allowlist-validated
 *  server-side in edge lib/segments.ts. */
export interface SegmentCondition {
  field: string;
  op: string;
  value: string | number | boolean | null;
}

/** Rule tree for an audience segment. `match` = AND ('all') / OR ('any'). */
export interface SegmentRules {
  match: "all" | "any";
  conditions: SegmentCondition[];
}

export interface AudienceSegmentRow {
  id: string;
  name: string;
  description: string | null;
  rules: SegmentRules;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
export interface AudienceSegmentInsert {
  name: string;
  description?: string | null;
  rules?: SegmentRules;
  is_active?: boolean;
}
export type AudienceSegmentUpdate = Partial<
  Omit<AudienceSegmentRow, "id" | "created_by" | "created_at" | "updated_at">
>;

export interface GrowthCampaignRow {
  id: string;
  name: string;
  subject: string;
  body: string;
  cta_label: string | null;
  cta_url: string | null;
  channels: CampaignChannel[];
  segment_id: string | null;
  status: CampaignStatus;
  scheduled_for: string | null;
  sent_at: string | null;
  stats: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
export interface GrowthCampaignInsert {
  name: string;
  subject: string;
  body: string;
  cta_label?: string | null;
  cta_url?: string | null;
  channels?: CampaignChannel[];
  segment_id?: string | null;
  status?: CampaignStatus;
  scheduled_for?: string | null;
}
export type GrowthCampaignUpdate = Partial<
  Omit<GrowthCampaignRow, "id" | "created_by" | "created_at" | "updated_at">
>;

export interface CampaignRecipientRow {
  id: string;
  campaign_id: string;
  user_id: string;
  channel: CampaignChannel;
  status: CampaignRecipientStatus;
  error: string | null;
  sent_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  created_at: string;
}
export interface CampaignRecipientInsert {
  campaign_id: string;
  user_id: string;
  channel: CampaignChannel;
  status?: CampaignRecipientStatus;
  error?: string | null;
  sent_at?: string | null;
}
export type CampaignRecipientUpdate = Partial<
  Omit<CampaignRecipientRow, "id" | "campaign_id" | "user_id" | "channel" | "created_at">
>;

export interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  variant: AnnouncementVariant;
  cta_label: string | null;
  cta_url: string | null;
  segment_id: string | null;
  starts_at: string;
  ends_at: string | null;
  dismissible: boolean;
  priority: number;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
export interface AnnouncementInsert {
  title: string;
  body: string;
  variant?: AnnouncementVariant;
  cta_label?: string | null;
  cta_url?: string | null;
  segment_id?: string | null;
  starts_at?: string;
  ends_at?: string | null;
  dismissible?: boolean;
  priority?: number;
  is_active?: boolean;
}
export type AnnouncementUpdate = Partial<
  Omit<AnnouncementRow, "id" | "created_by" | "created_at" | "updated_at">
>;

export interface AnnouncementDismissalRow {
  id: string;
  announcement_id: string;
  user_id: string;
  dismissed_at: string;
}
export interface AnnouncementDismissalInsert {
  announcement_id: string;
  user_id: string;
}

export interface ReferralCodeRow {
  id: string;
  user_id: string;
  code: string;
  created_at: string;
}
export interface ReferralCodeInsert {
  user_id: string;
  code: string;
}

export interface ReferralEventRow {
  id: string;
  referrer_user_id: string;
  referred_user_id: string;
  code: string;
  reward_status: ReferralRewardStatus;
  referrer_reward_credits: number | null;
  referred_reward_credits: number | null;
  qualified_at: string | null;
  granted_at: string | null;
  created_at: string;
}
export interface ReferralEventInsert {
  referrer_user_id: string;
  referred_user_id: string;
  code: string;
  reward_status?: ReferralRewardStatus;
  referrer_reward_credits?: number | null;
  referred_reward_credits?: number | null;
}
export type ReferralEventUpdate = Partial<
  Omit<ReferralEventRow, "id" | "referrer_user_id" | "referred_user_id" | "created_at">
>;

// ─── Update types ──────────────────────────────────────────────────

export type UserUpdate = Partial<Omit<UserRow, "id" | "created_at" | "updated_at">>;
export type SubmissionUpdate = Partial<Omit<SubmissionRow, "id" | "user_id" | "created_at" | "updated_at">>;
export type GradeReportUpdate = Partial<Omit<GradeReportRow, "id" | "submission_id" | "created_at">>;
export type DisputeUpdate = Partial<Omit<DisputeRow, "id" | "grade_report_id" | "user_id" | "created_at" | "updated_at">>;
export type InventoryItemUpdate = Partial<Omit<InventoryItemRow, "id" | "user_id" | "created_at" | "updated_at">>;
export type ListingUpdate = Partial<Omit<ListingRow, "id" | "created_at" | "updated_at">>;
export type SaleUpdate = Partial<Omit<SaleRow, "id" | "created_at">>;
export type ShipmentUpdate = Partial<Omit<ShipmentRow, "id" | "created_at" | "updated_at">>;
export type HumanReviewUpdate = Partial<Omit<HumanReviewRow, "id" | "grade_report_id" | "reviewer_id">>;
export type AiPromptVersionUpdate = Partial<Omit<AiPromptVersionRow, "id" | "created_at">>;
export type NotificationUpdate = Partial<Omit<NotificationRow, "id" | "user_id" | "created_at">>;
export type SourceUpdate = Partial<Omit<SourceRow, "id" | "user_id" | "created_at" | "updated_at">>;
export type ItemPhotoUpdate = Partial<Omit<ItemPhotoRow, "id" | "inventory_item_id" | "created_at">>;
export type MarketplaceConnectionUpdate = Partial<Omit<MarketplaceConnectionRow, "id" | "user_id" | "created_at" | "updated_at">>;
export type GoogleConnectionUpdate = Partial<Omit<GoogleConnectionRow, "id" | "user_id" | "created_at" | "updated_at">>;
export type PayoutImportUpdate = Partial<Omit<PayoutImportRow, "id" | "user_id" | "created_at" | "updated_at">>;
export type FlipdeskGradingSubmissionUpdate = Partial<Omit<FlipdeskGradingSubmissionRow, "id" | "inventory_item_id" | "created_at" | "updated_at">>;

// ─── Content module (Blog + Social) ────────────────────────────────
// Mirrors the Phase A migration (00041_content_module.sql).

export type ContentSurface = "blog" | "social";
export type ContentProduct = "gradethread" | "flipdesk" | "both";
export type ContentStatus =
  | "draft"
  | "scheduled"
  | "published"
  | "archived"
  | "failed";
export type TopicStatus = "queued" | "assigned" | "used" | "rejected";
export type ContentGeneratedBy = "ai" | "human";
export type ContentTopicSource = "research" | "manual" | "history_derived";
/** Pre-publish safety review state (US-486, migration 00151). */
export type ContentSafetyStatus = "unchecked" | "passed" | "held";

export interface ContentTopicRow {
  id: string;
  surface: ContentSurface;
  product_focus: ContentProduct;
  title: string;
  angle: string | null;
  primary_keyword: string;
  secondary_keywords: string[];
  search_intent: string | null;
  status: TopicStatus;
  used_by_post_id: string | null;
  generated_by: ContentGeneratedBy;
  source: ContentTopicSource;
  notes: string | null;
  created_at: string;
  used_at: string | null;
  updated_at: string;
}
export interface ContentTopicInsert {
  surface: ContentSurface;
  product_focus: ContentProduct;
  title: string;
  primary_keyword: string;
  angle?: string | null;
  secondary_keywords?: string[];
  search_intent?: string | null;
  status?: TopicStatus;
  generated_by?: ContentGeneratedBy;
  source?: ContentTopicSource;
  notes?: string | null;
}
export type ContentTopicUpdate = Partial<
  Omit<ContentTopicRow, "id" | "created_at" | "updated_at">
>;

/** A single on-page FAQ entry (US-304); rendered visibly + as FAQPage JSON-LD. */
export interface BlogFaq {
  q: string;
  a: string;
}

export interface BlogPostRow {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  body_html: string;
  body_json: Record<string, unknown>;
  product_focus: ContentProduct;
  status: ContentStatus;
  hero_image_url: string | null;
  hero_image_path: string | null;
  hero_prompt: string | null;
  seo_title: string | null;
  seo_description: string | null;
  primary_keyword: string | null;
  secondary_keywords: string[];
  jsonld: Record<string, unknown> | null;
  reading_time_min: number | null;
  scheduled_for: string | null;
  published_at: string | null;
  topic_id: string | null;
  generated_by: ContentGeneratedBy;
  model_used: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  // Blog GEO / E-E-A-T fields (US-304). Nullable/defaulted → legacy posts OK.
  author: string | null;
  key_takeaways: string[];
  faqs: BlogFaq[];
  // Pre-publish safety review state (US-486).
  safety_status: ContentSafetyStatus;
  safety_notes: string | null;
  safety_checked_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface BlogPostInsert {
  title: string;
  slug: string;
  product_focus?: ContentProduct;
  status?: ContentStatus;
  excerpt?: string | null;
  body_html?: string;
  body_json?: Record<string, unknown>;
  hero_image_url?: string | null;
  primary_keyword?: string | null;
  secondary_keywords?: string[];
  topic_id?: string | null;
  generated_by?: ContentGeneratedBy;
}
export type BlogPostUpdate = Partial<
  Omit<BlogPostRow, "id" | "created_at" | "updated_at">
>;

// Convenience row returned by GET /api/content/blog (list) — tags appended client-side.
export interface BlogPostListRow {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  product_focus: ContentProduct;
  status: ContentStatus;
  hero_image_url: string | null;
  primary_keyword: string | null;
  published_at: string | null;
  scheduled_for: string | null;
  generated_by: ContentGeneratedBy;
  model_used: string | null;
  created_at: string;
  updated_at: string;
}

export interface SocialPostRow {
  id: string;
  product_focus: ContentProduct;
  status: ContentStatus;
  long_body: string;
  short_body: string;
  hashtags: string[];
  cta_url: string | null;
  scheduled_for: string | null;
  published_at: string | null;
  topic_id: string | null;
  asset_image_url: string | null;
  asset_image_path: string | null;
  generated_by: ContentGeneratedBy;
  model_used: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  // Pre-publish safety review state (US-486).
  safety_status: ContentSafetyStatus;
  safety_notes: string | null;
  safety_checked_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface SocialPostInsert {
  product_focus?: ContentProduct;
  status?: ContentStatus;
  long_body?: string;
  short_body?: string;
  hashtags?: string[];
  cta_url?: string | null;
  topic_id?: string | null;
  generated_by?: ContentGeneratedBy;
}
export type SocialPostUpdate = Partial<
  Omit<SocialPostRow, "id" | "created_at" | "updated_at">
>;

export interface ContentKnowledgeRow {
  id: string;
  key: string;
  title: string;
  body_md: string;
  token_count_est: number;
  created_at: string;
  updated_at: string;
}
export interface ContentKnowledgeListRow {
  id: string;
  key: string;
  title: string;
  token_count_est: number;
  updated_at: string;
}

export interface ContentSettingsRow {
  id: number;
  make_webhook_blog: string | null;
  make_webhook_social_long: string | null;
  make_webhook_social_short: string | null;
  auto_publish_blog: boolean;
  auto_publish_social: boolean;
  default_blog_model: string;
  default_social_model: string;
  default_research_model: string;
  default_image_model: string;
  min_topics_in_bank: number;
  topics_refill_batch: number;
  post_cadence_per_day_blog: number;
  post_cadence_per_day_social: number;
  public_site_url: string;
  // US-486: kill-switch + weekly auto-publish ceiling.
  publishing_paused: boolean;
  max_auto_publishes_per_week: number;
  created_at: string;
  updated_at: string;
}

// ─── Database schema type (for Supabase client) ────────────────────

export interface Database {
  public: {
    Tables: {
      users: {
        Row: UserRow;
        Insert: UserInsert;
        Update: UserUpdate;
      };
      submissions: {
        Row: SubmissionRow;
        Insert: SubmissionInsert;
        Update: SubmissionUpdate;
      };
      submission_images: {
        Row: SubmissionImageRow;
        Insert: SubmissionImageInsert;
        Update: Partial<Omit<SubmissionImageRow, "id" | "created_at">>;
      };
      grade_reports: {
        Row: GradeReportRow;
        Insert: GradeReportInsert;
        Update: GradeReportUpdate;
      };
      disputes: {
        Row: DisputeRow;
        Insert: DisputeInsert;
        Update: DisputeUpdate;
      };
      api_keys: {
        Row: ApiKeyRow;
        Insert: ApiKeyInsert;
        Update: Partial<Omit<ApiKeyRow, "id" | "user_id" | "created_at">>;
      };
      inventory_items: {
        Row: InventoryItemRow;
        Insert: InventoryItemInsert;
        Update: InventoryItemUpdate;
      };
      listings: {
        Row: ListingRow;
        Insert: ListingInsert;
        Update: ListingUpdate;
      };
      sales: {
        Row: SaleRow;
        Insert: SaleInsert;
        Update: SaleUpdate;
      };
      shipments: {
        Row: ShipmentRow;
        Insert: ShipmentInsert;
        Update: ShipmentUpdate;
      };
      admin_audit_log: {
        Row: AdminAuditLogRow;
        Insert: AdminAuditLogInsert;
        Update: Partial<Omit<AdminAuditLogRow, "id" | "created_at">>;
      };
      human_reviews: {
        Row: HumanReviewRow;
        Insert: HumanReviewInsert;
        Update: HumanReviewUpdate;
      };
      ai_prompt_versions: {
        Row: AiPromptVersionRow;
        Insert: AiPromptVersionInsert;
        Update: AiPromptVersionUpdate;
      };
      grading_eval_cases: {
        Row: GradingEvalCaseRow;
        Insert: GradingEvalCaseInsert;
        Update: Partial<Omit<GradingEvalCaseRow, "id" | "created_at" | "updated_at">>;
      };
      grading_eval_runs: {
        Row: GradingEvalRunRow;
        Insert: Omit<GradingEvalRunRow, "id" | "created_at">;
        Update: Partial<Omit<GradingEvalRunRow, "id" | "created_at">>;
      };
      gsc_performance: {
        Row: GscPerformanceRow;
        Insert: GscPerformanceInsert;
        Update: Partial<GscPerformanceInsert>;
      };
      notifications: {
        Row: NotificationRow;
        Insert: NotificationInsert;
        Update: NotificationUpdate;
      };
      sources: {
        Row: SourceRow;
        Insert: SourceInsert;
        Update: SourceUpdate;
      };
      consignors: {
        Row: ConsignorRow;
        Insert: ConsignorInsert;
        Update: ConsignorUpdate;
      };
      consignor_payouts: {
        Row: ConsignorPayoutRow;
        Insert: ConsignorPayoutInsert;
        Update: ConsignorPayoutUpdate;
      };
      consignor_pnl: {
        // Read-only security-invoker view (US-600).
        Row: ConsignorPnlRow;
        Insert: never;
        Update: never;
      };
      item_photos: {
        Row: ItemPhotoRow;
        Insert: ItemPhotoInsert;
        Update: ItemPhotoUpdate;
      };
      marketplace_connections: {
        Row: MarketplaceConnectionRow;
        Insert: MarketplaceConnectionInsert;
        Update: MarketplaceConnectionUpdate;
      };
      google_connections: {
        Row: GoogleConnectionRow;
        Insert: GoogleConnectionInsert;
        Update: GoogleConnectionUpdate;
      };
      flipdesk_reconcile_sessions: {
        Row: ReconcileSessionRow;
        Insert: ReconcileSessionInsert;
        Update: ReconcileSessionUpdate;
      };
      listing_generation_batches: {
        Row: ListingGenerationBatchRow;
        Insert: ListingGenerationBatchInsert;
        Update: ListingGenerationBatchUpdate;
      };
      listing_generation_jobs: {
        Row: ListingGenerationJobRow;
        Insert: ListingGenerationJobInsert;
        Update: ListingGenerationJobUpdate;
      };
      business_policies: {
        Row: BusinessPolicyRow;
        Insert: BusinessPolicyInsert;
        Update: BusinessPolicyUpdate;
      };
      payout_imports: {
        Row: PayoutImportRow;
        Insert: PayoutImportInsert;
        Update: PayoutImportUpdate;
      };
      flipdesk_grading_submissions: {
        Row: FlipdeskGradingSubmissionRow;
        Insert: FlipdeskGradingSubmissionInsert;
        Update: FlipdeskGradingSubmissionUpdate;
      };
      flipdesk_saved_views: {
        Row: SavedViewRow;
        Insert: SavedViewInsert;
        Update: SavedViewUpdate;
      };
      admin_task_projects: {
        Row: AdminTaskProjectRow;
        Insert: AdminTaskProjectInsert;
        Update: AdminTaskProjectUpdate;
      };
      admin_tasks: {
        Row: AdminTaskRow;
        Insert: AdminTaskInsert;
        Update: AdminTaskUpdate;
      };
      admin_task_comments: {
        Row: AdminTaskCommentRow;
        Insert: AdminTaskCommentInsert;
        Update: AdminTaskCommentUpdate;
      };
      flipdesk_expenses: {
        Row: ExpenseRow;
        Insert: ExpenseInsert;
        Update: ExpenseUpdate;
      };
      flipdesk_ebay_listings: {
        Row: EbayListingRow;
        Insert: EbayListingInsert;
        Update: EbayListingUpdate;
      };
      flipdesk_settings: {
        Row: FlipdeskSettingsRow;
        Insert: FlipdeskSettingsInsert;
        Update: FlipdeskSettingsUpdate;
      };
      ai_enrichment_log: {
        Row: AiEnrichmentLogRow;
        Insert: AiEnrichmentLogInsert;
        Update: AiEnrichmentLogUpdate;
      };
      grade_outcomes: {
        Row: GradeOutcomeRow;
        Insert: Partial<Omit<GradeOutcomeRow, "id" | "created_at" | "updated_at">>;
        Update: Partial<Omit<GradeOutcomeRow, "id" | "created_at" | "updated_at">>;
      };
      grade_credit_transactions: {
        Row: GradeCreditTransactionRow;
        // Service-role only — clients should call debit_grade_credits /
        // grant_grade_credits RPCs, not insert directly.
        Insert: Partial<Omit<GradeCreditTransactionRow, "id" | "created_at">>;
        Update: never;
      };
      flipdesk_subscription_events: {
        Row: FlipdeskSubscriptionEventRow;
        Insert: FlipdeskSubscriptionEventInsert;
        Update: never;
      };
      pricing_plans: {
        Row: PricingPlanRow;
        // Service-role only (audited admin edge route) — clients read but never write.
        Insert: never;
        Update: never;
      };
      content_topics: {
        Row: ContentTopicRow;
        Insert: ContentTopicInsert;
        Update: ContentTopicUpdate;
      };
      blog_posts: {
        Row: BlogPostRow;
        Insert: BlogPostInsert;
        Update: BlogPostUpdate;
      };
      social_posts: {
        Row: SocialPostRow;
        Insert: SocialPostInsert;
        Update: SocialPostUpdate;
      };
      content_knowledge: {
        Row: ContentKnowledgeRow;
        Insert: Pick<ContentKnowledgeRow, "key" | "title" | "body_md"> & {
          token_count_est?: number;
        };
        Update: Partial<Pick<ContentKnowledgeRow, "title" | "body_md" | "token_count_est">>;
      };
      content_settings: {
        Row: ContentSettingsRow;
        Insert: Partial<ContentSettingsRow> & { id: number };
        Update: Partial<Omit<ContentSettingsRow, "id" | "created_at" | "updated_at">>;
      };
      workspace_members: {
        Row: WorkspaceMemberRow;
        Insert: WorkspaceMemberInsert;
        Update: WorkspaceMemberUpdate;
      };
      workspace_invitations: {
        Row: WorkspaceInvitationRow;
        Insert: WorkspaceInvitationInsert;
        Update: WorkspaceInvitationUpdate;
      };
      mfa_recovery_codes: {
        Row: MfaRecoveryCodeRow;
        Insert: Pick<MfaRecoveryCodeRow, "user_id" | "code_hash"> &
          Partial<Pick<MfaRecoveryCodeRow, "used_at">>;
        Update: Partial<Pick<MfaRecoveryCodeRow, "used_at">>;
      };
      legal_acceptances: {
        Row: LegalAcceptanceRow;
        Insert: Pick<LegalAcceptanceRow, "user_id" | "tos_version" | "privacy_version" | "method"> &
          Partial<Pick<LegalAcceptanceRow, "user_agent" | "ip_address" | "accepted_at">>;
        Update: never;
      };
      // Growth / Promote suite (00102)
      audience_segments: {
        Row: AudienceSegmentRow;
        Insert: AudienceSegmentInsert;
        Update: AudienceSegmentUpdate;
      };
      growth_campaigns: {
        Row: GrowthCampaignRow;
        Insert: GrowthCampaignInsert;
        Update: GrowthCampaignUpdate;
      };
      campaign_recipients: {
        Row: CampaignRecipientRow;
        Insert: CampaignRecipientInsert;
        Update: CampaignRecipientUpdate;
      };
      announcements: {
        Row: AnnouncementRow;
        Insert: AnnouncementInsert;
        Update: AnnouncementUpdate;
      };
      announcement_dismissals: {
        Row: AnnouncementDismissalRow;
        Insert: AnnouncementDismissalInsert;
        Update: never;
      };
      referral_codes: {
        Row: ReferralCodeRow;
        Insert: ReferralCodeInsert;
        Update: never;
      };
      referral_events: {
        Row: ReferralEventRow;
        Insert: ReferralEventInsert;
        Update: ReferralEventUpdate;
      };
    };
    Views: {
      // US-348: column-restricted public certificate projection.
      public_grade_reports: {
        Row: PublicGradeReportRow;
      };
    };
    Enums: {
      user_plan: UserPlan;
      flipdesk_plan: FlipdeskPlan;
      subscription_status: SubscriptionStatus;
      garment_type: GarmentType;
      garment_category: GarmentCategory;
      submission_status: SubmissionStatus;
      grade_tier: GradeTier;
      image_type: ImageType;
      dispute_status: DisputeStatus;
      item_status: ItemStatus;
      listing_platform: ListingPlatform;
      user_role: UserRole;
      notification_type: NotificationType;
      flipdesk_source_type: FlipdeskSourceType;
      item_category: ItemCategory;
      flipdesk_photo_type: FlipdeskPhotoType;
      listing_status: ListingStatus;
      grading_submission_tier: GradingSubmissionTier;
      payout_import_method: PayoutImportMethod;
      content_surface: ContentSurface;
      content_product: ContentProduct;
      content_status: ContentStatus;
      topic_status: TopicStatus;
      content_generated_by: ContentGeneratedBy;
      content_topic_source: ContentTopicSource;
      workspace_role: WorkspaceRole;
      campaign_channel: CampaignChannel;
      campaign_status: CampaignStatus;
      campaign_recipient_status: CampaignRecipientStatus;
      announcement_variant: AnnouncementVariant;
      referral_reward_status: ReferralRewardStatus;
    };
  };
}
