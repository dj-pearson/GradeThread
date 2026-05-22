export type UserPlan = "free" | "starter" | "professional" | "enterprise";
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

export interface UserRow {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  plan: UserPlan;
  role: UserRole;
  stripe_customer_id: string | null;
  grades_used_this_month: number;
  grade_reset_at: string;
  created_at: string;
  updated_at: string;
}

export interface SubmissionRow {
  id: string;
  user_id: string;
  garment_type: GarmentType;
  garment_category: GarmentCategory;
  brand: string | null;
  title: string;
  description: string | null;
  status: SubmissionStatus;
  created_at: string;
  updated_at: string;
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
  confidence_score: number;
  model_version: string;
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
  created_at: string;
  updated_at: string;
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
}

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
  plan?: UserPlan;
  role?: UserRole;
  stripe_customer_id?: string | null;
}

export interface SubmissionInsert {
  user_id: string;
  garment_type: GarmentType;
  garment_category: GarmentCategory;
  brand?: string | null;
  title: string;
  description?: string | null;
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
  confidence_score: number;
  model_version: string;
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
  review_notes?: string | null;
}

export interface AiPromptVersionInsert {
  version_name: string;
  prompt_text: string;
  is_active?: boolean;
  accuracy_score?: number | null;
  total_grades?: number;
}

export interface NotificationInsert {
  user_id: string;
  type: NotificationType;
  title: string;
  message: string;
  link?: string | null;
  is_read?: boolean;
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
      flipdesk_expenses: {
        Row: ExpenseRow;
        Insert: ExpenseInsert;
        Update: ExpenseUpdate;
      };
    };
    Enums: {
      user_plan: UserPlan;
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
    };
  };
}
