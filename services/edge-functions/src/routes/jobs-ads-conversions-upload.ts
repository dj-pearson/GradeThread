// US-1704: scheduled offline conversion import.
//
// Uploads converted-but-not-yet-uploaded ad_click_attributions to Google Ads via
// ConversionUploadService. Mounted in main.ts as POST /api/jobs/ads-conversions-
// upload, OUTSIDE the JWT groups; the handler enforces X-Internal-Job-Secret
// itself (same pattern as every other Coolify cron). Cleanly no-ops (records a
// 'skipped' run) when Google Ads env isn't configured.
//
// Suggested Coolify cron: daily, e.g. `30 8 * * *` (after the ads-sync at 08:00).

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { supabaseAdmin } from "../lib/supabase.ts";
import { uploadOfflineConversions } from "../lib/google-ads-conversions-upload.ts";

export async function handleAdsConversionsUploadCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const lock = await acquireJobLock("ads-conversions-upload", 900);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const result = await uploadOfflineConversions({ supabase: supabaseAdmin });
    if (!result.configured) {
      return c.json({ ok: true, skipped: true, reason: result.message });
    }
    return c.json({ ok: true, ...result });
  } finally {
    await lock.release();
  }
}
