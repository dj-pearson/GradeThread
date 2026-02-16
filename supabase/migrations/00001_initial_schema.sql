-- GradeThread Initial Schema
-- Creates all enums, tables, indexes, RLS policies, triggers, and storage

-- ══════════════════════════════════════════════════════════
-- ENUMS
-- ══════════════════════════════════════════════════════════

CREATE TYPE public.user_plan AS ENUM ('free', 'starter', 'professional', 'enterprise');
CREATE TYPE public.garment_type AS ENUM ('tops', 'bottoms', 'outerwear', 'dresses', 'footwear', 'accessories');
CREATE TYPE public.garment_category AS ENUM (
  't-shirt', 'shirt', 'blouse', 'sweater', 'hoodie',
  'jacket', 'coat', 'jeans', 'pants', 'shorts',
  'skirt', 'dress', 'sneakers', 'boots', 'sandals',
  'hat', 'bag', 'belt', 'scarf', 'other'
);
CREATE TYPE public.submission_status AS ENUM ('pending', 'processing', 'completed', 'failed', 'disputed');
CREATE TYPE public.grade_tier AS ENUM ('NWT', 'NWOT', 'Excellent', 'Very Good', 'Good', 'Fair', 'Poor');
CREATE TYPE public.image_type AS ENUM ('front', 'back', 'label', 'detail', 'defect');
CREATE TYPE public.dispute_status AS ENUM ('open', 'under_review', 'resolved', 'rejected');

-- ══════════════════════════════════════════════════════════
-- TABLES
-- ══════════════════════════════════════════════════════════

-- Users (extends auth.users)
CREATE TABLE public.users (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email         text NOT NULL,
  full_name     text,
  avatar_url    text,
  plan          public.user_plan NOT NULL DEFAULT 'free',
  stripe_customer_id text,
  grades_used_this_month integer NOT NULL DEFAULT 0,
  grade_reset_at timestamptz NOT NULL DEFAULT (date_trunc('month', now()) + interval '1 month'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Submissions
CREATE TABLE public.submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  garment_type  public.garment_type NOT NULL,
  garment_category public.garment_category NOT NULL,
  brand         text,
  title         text NOT NULL,
  description   text,
  status        public.submission_status NOT NULL DEFAULT 'pending',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Submission Images
CREATE TABLE public.submission_images (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES public.submissions(id) ON DELETE CASCADE,
  image_type    public.image_type NOT NULL,
  storage_path  text NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Grade Reports
CREATE TABLE public.grade_reports (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id             uuid NOT NULL REFERENCES public.submissions(id) ON DELETE CASCADE,
  overall_score             numeric(3,1) NOT NULL CHECK (overall_score >= 1.0 AND overall_score <= 10.0),
  grade_tier                public.grade_tier NOT NULL,
  fabric_condition_score    numeric(3,1) NOT NULL CHECK (fabric_condition_score >= 1.0 AND fabric_condition_score <= 10.0),
  structural_integrity_score numeric(3,1) NOT NULL CHECK (structural_integrity_score >= 1.0 AND structural_integrity_score <= 10.0),
  cosmetic_appearance_score numeric(3,1) NOT NULL CHECK (cosmetic_appearance_score >= 1.0 AND cosmetic_appearance_score <= 10.0),
  functional_elements_score numeric(3,1) NOT NULL CHECK (functional_elements_score >= 1.0 AND functional_elements_score <= 10.0),
  odor_cleanliness_score    numeric(3,1) NOT NULL CHECK (odor_cleanliness_score >= 1.0 AND odor_cleanliness_score <= 10.0),
  ai_summary                text NOT NULL,
  detailed_notes            jsonb,
  confidence_score          numeric(3,2) NOT NULL CHECK (confidence_score >= 0.0 AND confidence_score <= 1.0),
  model_version             text NOT NULL,
  certificate_id            uuid UNIQUE,
  created_at                timestamptz NOT NULL DEFAULT now()
);

-- Disputes
CREATE TABLE public.disputes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grade_report_id uuid NOT NULL REFERENCES public.grade_reports(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  reason          text NOT NULL,
  status          public.dispute_status NOT NULL DEFAULT 'open',
  resolution_notes text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- API Keys
CREATE TABLE public.api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  key_hash    text NOT NULL,
  key_prefix  text NOT NULL,
  last_used_at timestamptz,
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ══════════════════════════════════════════════════════════
-- INDEXES
-- ══════════════════════════════════════════════════════════

CREATE INDEX idx_submissions_user_id ON public.submissions(user_id);
CREATE INDEX idx_submissions_status ON public.submissions(status);
CREATE INDEX idx_submissions_created_at ON public.submissions(created_at DESC);
CREATE INDEX idx_submission_images_submission_id ON public.submission_images(submission_id);
CREATE INDEX idx_grade_reports_submission_id ON public.grade_reports(submission_id);
CREATE INDEX idx_grade_reports_certificate_id ON public.grade_reports(certificate_id) WHERE certificate_id IS NOT NULL;
CREATE INDEX idx_disputes_grade_report_id ON public.disputes(grade_report_id);
CREATE INDEX idx_disputes_user_id ON public.disputes(user_id);
CREATE INDEX idx_api_keys_user_id ON public.api_keys(user_id);
CREATE INDEX idx_api_keys_key_hash ON public.api_keys(key_hash);

-- ══════════════════════════════════════════════════════════
-- TRIGGERS
-- ══════════════════════════════════════════════════════════

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_submissions_updated_at
  BEFORE UPDATE ON public.submissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_disputes_updated_at
  BEFORE UPDATE ON public.disputes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Auto-create user profile on auth signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id, email, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data ->> 'full_name',
    NEW.raw_user_meta_data ->> 'avatar_url'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ══════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submission_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grade_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

-- Users: own data only
CREATE POLICY "Users can view own profile"
  ON public.users FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON public.users FOR UPDATE
  USING (auth.uid() = id);

-- Submissions: own data only
CREATE POLICY "Users can view own submissions"
  ON public.submissions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create submissions"
  ON public.submissions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own submissions"
  ON public.submissions FOR UPDATE
  USING (auth.uid() = user_id);

-- Submission Images: via submission ownership
CREATE POLICY "Users can view own submission images"
  ON public.submission_images FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.submissions
      WHERE submissions.id = submission_images.submission_id
      AND submissions.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create submission images"
  ON public.submission_images FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.submissions
      WHERE submissions.id = submission_images.submission_id
      AND submissions.user_id = auth.uid()
    )
  );

-- Grade Reports: own data + public certificate view
CREATE POLICY "Users can view own grade reports"
  ON public.grade_reports FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.submissions
      WHERE submissions.id = grade_reports.submission_id
      AND submissions.user_id = auth.uid()
    )
  );

CREATE POLICY "Public can view grade reports with certificates"
  ON public.grade_reports FOR SELECT
  USING (certificate_id IS NOT NULL);

-- Disputes: own data only
CREATE POLICY "Users can view own disputes"
  ON public.disputes FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create disputes"
  ON public.disputes FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- API Keys: own data only
CREATE POLICY "Users can view own API keys"
  ON public.api_keys FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create API keys"
  ON public.api_keys FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own API keys"
  ON public.api_keys FOR DELETE
  USING (auth.uid() = user_id);

-- ══════════════════════════════════════════════════════════
-- STORAGE
-- ══════════════════════════════════════════════════════════

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'submission-images',
  'submission-images',
  false,
  10485760, -- 10MB
  ARRAY['image/jpeg', 'image/png', 'image/webp']
);

-- Storage RLS: users can manage files in their own folder
CREATE POLICY "Users can upload to own folder"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'submission-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Users can view own files"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'submission-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Users can delete own files"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'submission-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
