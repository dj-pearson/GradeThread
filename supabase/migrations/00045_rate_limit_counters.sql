-- Distributed rate-limit store (US-265).
--
-- Replaces the edge service's in-memory Map (which was per-process: lost on
-- restart and not shared across replicas). Fixed-window counters keyed by
-- "<scope>|<subject>" where subject is user:<uuid> or ip:<addr>.

CREATE TABLE IF NOT EXISTS public.rate_limit_counters (
  bucket_key    text NOT NULL,
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_window_start
  ON public.rate_limit_counters(window_start);

-- Service-role only (edge service). RLS on, no policies → deny-all for
-- anon/authenticated roles.
ALTER TABLE public.rate_limit_counters ENABLE ROW LEVEL SECURITY;

-- Atomically increment the counter for (bucket_key, window_start) and return
-- the new count. Prunes the key's older windows on each call so the table
-- stays ~1 row per active bucket without needing a separate cleanup job.
CREATE OR REPLACE FUNCTION public.increment_rate_limit(
  p_bucket_key text,
  p_window_start timestamptz
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM public.rate_limit_counters
   WHERE bucket_key = p_bucket_key AND window_start < p_window_start;

  INSERT INTO public.rate_limit_counters (bucket_key, window_start, count)
  VALUES (p_bucket_key, p_window_start, 1)
  ON CONFLICT (bucket_key, window_start)
  DO UPDATE SET count = public.rate_limit_counters.count + 1
  RETURNING count INTO v_count;

  RETURN v_count;
END;
$$;
