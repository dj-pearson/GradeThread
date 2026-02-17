-- Function to atomically increment grades_used_this_month for a user
CREATE OR REPLACE FUNCTION increment_grades_used(user_id_param UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE users
  SET grades_used_this_month = grades_used_this_month + 1,
      updated_at = now()
  WHERE id = user_id_param;
END;
$$;
