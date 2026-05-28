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
export type SubmissionStatus = "pending" | "processing" | "completed" | "failed" | "disputed";
export type GradeTier = "NWT" | "NWOT" | "Excellent" | "Very Good" | "Good" | "Fair" | "Poor";
export type ImageType = "front" | "back" | "label" | "detail" | "defect";
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
export type NotificationType = "grade_complete" | "dispute_update" | "billing" | "system";

// ─── FlipDesk enums ────────────────────────────────────────────────
export type FlipdeskSourceType =
  | "thrift"
  | "goodwill_auction"
  | "estate_sale"
  | "wholesale"
  | "retail_arbitrage"
  | "consignment"
  | "other";
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
  | "detail"
  | "detail_2"
  | "detail_3"
  | "interior"
  | "defect"
  | "flatlay"
  | "on_model";
export type ListingStatus = "draft" | "active" | "ended" | "sold" | "relisted";
export type GradingSubmissionTier = "standard" | "premium" | "express";
export type PayoutImportMethod = "csv_upload" | "api_sync";
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
  created_at: string;
  updated_at: string;
}

// Intentional design feature the grader judged present (does NOT lower grade).
export interface DetectedStyleAttribute {
  attribute: string;
  location: string;
  confidence: number;
}

export interface SubmissionImageRow {
  id: string;
  submission_id: string;
  image_type: ImageType;
  storage_path: string;
  display_order: number;
  created_at: string;
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
  detailed_notes: Record<string, string> | null;
  // Intentional design features the AI recognized (distressing, raw hems, …).
  // These did NOT lower the grade — condition is graded vs. as-manufactured state.
  detected_style_attributes: DetectedStyleAttribute[];
  // Raw per-image analysis trace (eval/training/dispute explanation). Nullable
  // for historical rows graded before migration 00050.
  per_image_analysis: unknown[] | null;
  confidence_score: number;
  needs_human_review: boolean;
  model_version: string;
  // First-class prompt version that produced this grade (e.g. "composite_v2").
  prompt_version: string | null;
  certificate_id: string | null;
  created_at: string;
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
  created_at: string;
  updated_at: string;
}

export interface AiFieldSource {
  source: string; // e.g. "text", "photo:tag", "photo:front"
  confidence: number; // 0..1
  accepted: boolean;
}

export interface ListingRow {
  id: string;
  inventory_item_id: string;
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
  created_at: string;
  updated_at: string;
}

export interface SaleRow {
  id: string;
  inventory_item_id: string;
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
}

export interface MarketplaceConnectionRow {
  id: string;
  user_id: string;
  marketplace: ListingPlatform;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
  account_handle: string | null;
  scopes: string[];
  is_active: boolean;
  last_synced_at: string | null;
  last_refresh_attempt_at: string | null;
  refresh_error: string | null;
  created_at: string;
  updated_at: string;
}

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
  admin_user_id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  details: Record<string, unknown> | null;
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
  stage: "per_image" | "composite";
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
}

export interface SubmissionImageInsert {
  submission_id: string;
  image_type: ImageType;
  storage_path: string;
  display_order?: number;
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
  model_version: string;
  prompt_version?: string | null;
  certificate_id?: string | null;
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
}

export interface ListingInsert {
  inventory_item_id: string;
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
}

export interface SaleInsert {
  inventory_item_id: string;
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
  stage?: "per_image" | "composite";
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
  balance_after: number;
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
    };
  };
}
