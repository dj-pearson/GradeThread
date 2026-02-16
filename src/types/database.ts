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
export type ItemStatus = "acquired" | "grading" | "graded" | "listed" | "sold" | "shipped" | "completed" | "returned";
export type ListingPlatform = "ebay" | "poshmark" | "mercari" | "depop" | "grailed" | "facebook" | "offerup" | "other";
export type UserRole = "user" | "reviewer" | "admin" | "super_admin";

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
  created_at: string;
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
}

export interface SaleInsert {
  inventory_item_id: string;
  listing_id?: string | null;
  sale_price: number;
  platform_fees?: number;
  sale_date?: string;
  buyer_username?: string | null;
  buyer_notes?: string | null;
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
    };
  };
}
