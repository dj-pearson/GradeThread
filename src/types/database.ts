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

// ─── Row types (what you SELECT) ───────────────────────────────────

export interface UserRow {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  plan: UserPlan;
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

// ─── Insert types ──────────────────────────────────────────────────

export interface UserInsert {
  id: string;
  email: string;
  full_name?: string | null;
  avatar_url?: string | null;
  plan?: UserPlan;
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

// ─── Update types ──────────────────────────────────────────────────

export type UserUpdate = Partial<Omit<UserRow, "id" | "created_at" | "updated_at">>;
export type SubmissionUpdate = Partial<Omit<SubmissionRow, "id" | "user_id" | "created_at" | "updated_at">>;
export type GradeReportUpdate = Partial<Omit<GradeReportRow, "id" | "submission_id" | "created_at">>;
export type DisputeUpdate = Partial<Omit<DisputeRow, "id" | "grade_report_id" | "user_id" | "created_at" | "updated_at">>;

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
    };
    Enums: {
      user_plan: UserPlan;
      garment_type: GarmentType;
      garment_category: GarmentCategory;
      submission_status: SubmissionStatus;
      grade_tier: GradeTier;
      image_type: ImageType;
      dispute_status: DisputeStatus;
    };
  };
}
