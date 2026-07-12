-- Admin read-all policies for platform-wide queries
-- Allows admin/super_admin users to SELECT all rows from core tables

-- Users: admins can view all user profiles
DROP POLICY IF EXISTS "Admins can view all users" ON public.users;
CREATE POLICY "Admins can view all users"
  ON public.users FOR SELECT
  USING (public.is_admin());

-- Submissions: admins can view all submissions
DROP POLICY IF EXISTS "Admins can view all submissions" ON public.submissions;
CREATE POLICY "Admins can view all submissions"
  ON public.submissions FOR SELECT
  USING (public.is_admin());

-- Grade Reports: admins can view all grade reports
DROP POLICY IF EXISTS "Admins can view all grade reports" ON public.grade_reports;
CREATE POLICY "Admins can view all grade reports"
  ON public.grade_reports FOR SELECT
  USING (public.is_admin());

-- Disputes: admins can view all disputes
DROP POLICY IF EXISTS "Admins can view all disputes" ON public.disputes;
CREATE POLICY "Admins can view all disputes"
  ON public.disputes FOR SELECT
  USING (public.is_admin());

-- Sales: admins can view all sales (for revenue metrics)
DROP POLICY IF EXISTS "Admins can view all sales" ON public.sales;
CREATE POLICY "Admins can view all sales"
  ON public.sales FOR SELECT
  USING (public.is_admin());
