-- Add webhook_url column to api_keys table for webhook delivery on grade completion
ALTER TABLE public.api_keys ADD COLUMN webhook_url text;

-- Add update policy for api_keys (needed for PATCH /api/v1/webhook)
CREATE POLICY "Users can update own API keys"
  ON public.api_keys FOR UPDATE
  USING (auth.uid() = user_id);
