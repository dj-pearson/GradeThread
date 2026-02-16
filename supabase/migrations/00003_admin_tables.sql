-- GradeThread Admin Tables & Roles
-- Adds user roles, admin audit log, human reviews, and AI prompt versioning

-- ══════════════════════════════════════════════════════════
-- ENUMS
-- ══════════════════════════════════════════════════════════

CREATE TYPE public.user_role AS ENUM ('user', 'reviewer', 'admin', 'super_admin');

-- ══════════════════════════════════════════════════════════
-- ALTER EXISTING TABLES
-- ══════════════════════════════════════════════════════════

-- Add role column to users table
ALTER TABLE public.users
  ADD COLUMN role public.user_role NOT NULL DEFAULT 'user';

-- ══════════════════════════════════════════════════════════
-- HELPER FUNCTIONS
-- ══════════════════════════════════════════════════════════

-- Admin RLS policy helper: checks if current user has admin or super_admin role
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
    AND role IN ('admin', 'super_admin')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Reviewer RLS policy helper: checks if current user has reviewer, admin, or super_admin role
CREATE OR REPLACE FUNCTION public.is_reviewer_or_admin()
RETURNS boolean AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
    AND role IN ('reviewer', 'admin', 'super_admin')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ══════════════════════════════════════════════════════════
-- TABLES
-- ══════════════════════════════════════════════════════════

-- Admin Audit Log
CREATE TABLE public.admin_audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  action          text NOT NULL,
  target_type     text NOT NULL,
  target_id       uuid,
  details         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Human Reviews (for low-confidence AI grades)
CREATE TABLE public.human_reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grade_report_id uuid NOT NULL REFERENCES public.grade_reports(id) ON DELETE CASCADE,
  reviewer_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  original_score  decimal(3,1) NOT NULL,
  adjusted_score  decimal(3,1),
  review_notes    text,
  reviewed_at     timestamptz NOT NULL DEFAULT now()
);

-- AI Prompt Versions (track prompt iterations and accuracy)
CREATE TABLE public.ai_prompt_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_name    text NOT NULL,
  prompt_text     text NOT NULL,
  is_active       boolean NOT NULL DEFAULT false,
  accuracy_score  decimal(5,4),
  total_grades    integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ══════════════════════════════════════════════════════════
-- INDEXES
-- ══════════════════════════════════════════════════════════

-- Admin Audit Log
CREATE INDEX idx_admin_audit_log_admin_user_id ON public.admin_audit_log(admin_user_id);
CREATE INDEX idx_admin_audit_log_action ON public.admin_audit_log(action);
CREATE INDEX idx_admin_audit_log_target_type ON public.admin_audit_log(target_type);
CREATE INDEX idx_admin_audit_log_created_at ON public.admin_audit_log(created_at DESC);

-- Human Reviews
CREATE INDEX idx_human_reviews_grade_report_id ON public.human_reviews(grade_report_id);
CREATE INDEX idx_human_reviews_reviewer_id ON public.human_reviews(reviewer_id);

-- AI Prompt Versions
CREATE INDEX idx_ai_prompt_versions_is_active ON public.ai_prompt_versions(is_active) WHERE is_active = true;

-- Users role index for RLS helper functions
CREATE INDEX idx_users_role ON public.users(role);

-- ══════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.human_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_prompt_versions ENABLE ROW LEVEL SECURITY;

-- Admin Audit Log: admins only (read + write)
CREATE POLICY "Admins can view audit log"
  ON public.admin_audit_log FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Admins can create audit log entries"
  ON public.admin_audit_log FOR INSERT
  WITH CHECK (public.is_admin());

-- Human Reviews: admins and reviewers (read + write)
CREATE POLICY "Admins and reviewers can view human reviews"
  ON public.human_reviews FOR SELECT
  USING (public.is_reviewer_or_admin());

CREATE POLICY "Admins and reviewers can create human reviews"
  ON public.human_reviews FOR INSERT
  WITH CHECK (public.is_reviewer_or_admin());

CREATE POLICY "Admins and reviewers can update human reviews"
  ON public.human_reviews FOR UPDATE
  USING (public.is_reviewer_or_admin());

-- AI Prompt Versions: admins only (full CRUD)
CREATE POLICY "Admins can view AI prompt versions"
  ON public.ai_prompt_versions FOR SELECT
  USING (public.is_admin());

CREATE POLICY "Admins can create AI prompt versions"
  ON public.ai_prompt_versions FOR INSERT
  WITH CHECK (public.is_admin());

CREATE POLICY "Admins can update AI prompt versions"
  ON public.ai_prompt_versions FOR UPDATE
  USING (public.is_admin());

CREATE POLICY "Admins can delete AI prompt versions"
  ON public.ai_prompt_versions FOR DELETE
  USING (public.is_admin());
