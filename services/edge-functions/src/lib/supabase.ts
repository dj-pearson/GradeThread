import { createClient } from "@supabase/supabase-js";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
// Accept either name. Supabase's canonical env var is SUPABASE_SERVICE_ROLE_KEY,
// but SUPABASE_SERVICE_KEY is a common shorthand.
const supabaseServiceKey =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_KEY");

if (!supabaseUrl) {
  throw new Error("SUPABASE_URL is not set");
}
if (!supabaseServiceKey) {
  throw new Error(
    "SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY) is not set",
  );
}

// Service role client - bypasses RLS
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
