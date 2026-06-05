// US-507: admin feature-flag (kill-switch) management.
//
// Mounted at /api/admin/feature-flags — the /api/admin/* middleware (auth +
// adminAuthMiddleware, incl. the AAL2/MFA gate) already protects it. Lets an
// admin flip a flow off/on without a redeploy; the edge picks up the change
// within the feature-flag cache TTL (clearFeatureFlagCache makes it instant on
// the replica that handled the toggle).
//
// Documented SQL fallback (if the UI is unavailable):
//   update public.feature_flags set enabled = false where key = 'grading';

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { clearFeatureFlagCache } from "../lib/feature-flags.ts";
import { jsonError } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";

export const adminFlagsRoutes = new Hono<{ Variables: { userId: string } }>();

const KNOWN_FLAGS = new Set(["grading", "autolister", "content_ai", "repricing"]);

// List all flags + current state.
adminFlagsRoutes.get("/", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("feature_flags")
    .select("key, enabled, description, updated_at, updated_by")
    .order("key");
  if (error) return jsonError(c, 500, "Failed to load feature flags");
  return c.json({ flags: data ?? [] });
});

// Toggle a flag. Body: { key: string, enabled: boolean }
adminFlagsRoutes.put("/", async (c) => {
  let body: { key?: unknown; enabled?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const key = typeof body.key === "string" ? body.key : "";
  const enabled = body.enabled;
  if (!KNOWN_FLAGS.has(key)) {
    return jsonError(c, 400, `Unknown flag. Known: ${[...KNOWN_FLAGS].join(", ")}`);
  }
  if (typeof enabled !== "boolean") {
    return jsonError(c, 400, "enabled must be a boolean");
  }

  const userId = c.get("userId");
  const { error } = await supabaseAdmin
    .from("feature_flags")
    .update({ enabled, updated_by: userId })
    .eq("key", key);
  if (error) return jsonError(c, 500, "Failed to update feature flag");

  // Instant on this replica; others within the cache TTL.
  clearFeatureFlagCache();

  // Attributable audit trail (US-477) via the shared helper.
  await writeAuditLog(c, {
    action: "feature_flag.toggle",
    targetType: "feature_flag",
    targetId: key,
    after: { enabled },
  });

  return c.json({ ok: true, key, enabled });
});
