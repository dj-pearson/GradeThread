// Server-side feature flags / kill-switches (US-507).
//
// isFeatureEnabled(key) reads feature_flags (migration 00096) with a short
// in-memory cache so flipping a flag in the DB takes effect within ~CACHE_TTL
// across the fleet WITHOUT a redeploy. Used to gate expensive / external-
// dependency flows (grading, autolister, content AI, repricing) so they can be
// switched off during an outage or cost spike.
//
// FAIL-OPEN for availability: a missing flag row OR a DB read error defaults to
// ENABLED — a kill-switch should only ever turn something OFF when an operator
// explicitly sets enabled=false, never because of a transient DB blip or a
// fresh deploy that hasn't seeded the row.

import { supabaseAdmin } from "./supabase.ts";
import { logEvent } from "./observability.ts";

export type FeatureKey =
  | "grading"
  | "autolister"
  | "content_ai"
  | "repricing"
  | "authenticity_addon"
  | "support_assistant";

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { enabled: boolean; expires: number }>();

// `defaultEnabled` controls the fail behaviour for a MISSING row or a DB read
// error. It defaults to true (fail-open) for availability of established
// flows; pass false for a pre-launch flow that must stay OFF unless an operator
// has explicitly enabled it (the support assistant, US-844).
export async function isFeatureEnabled(
  key: FeatureKey,
  opts: { defaultEnabled?: boolean } = {},
): Promise<boolean> {
  const failDefault = opts.defaultEnabled ?? true;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.enabled;

  let enabled = failDefault; // fail default (open unless overridden)
  try {
    const { data, error } = await supabaseAdmin
      .from("feature_flags")
      .select("enabled")
      .eq("key", key)
      .maybeSingle();
    if (error) {
      logEvent("warn", "feature_flag.read_error", { key });
    } else if (data) {
      enabled = (data as { enabled: boolean }).enabled;
    }
    // No row → stays at failDefault (fail-open unless the caller opted out).
  } catch {
    logEvent("warn", "feature_flag.read_error", { key });
  }

  cache.set(key, { enabled, expires: now + CACHE_TTL_MS });
  if (!enabled) logEvent("info", "feature_flag.disabled_hit", { key });
  return enabled;
}

// Clear the cache (used after an admin toggle so the change is instant for the
// replica that handled the toggle; other replicas pick it up within the TTL).
export function clearFeatureFlagCache(): void {
  cache.clear();
}

// Standard 503 body for a disabled flow.
export function featureDisabledBody(key: FeatureKey): { error: string; code: string } {
  return {
    error: `The ${key} feature is temporarily unavailable. Please try again shortly.`,
    code: "FEATURE_DISABLED",
  };
}

// Hono middleware that 503s a whole route group when its flag is off. Use for
// flows with many endpoints (e.g. content AI) instead of gating each handler.
export function featureGate(key: FeatureKey) {
  return async (
    c: { json: (body: unknown, status?: number) => Response },
    next: () => Promise<void>,
  ): Promise<Response | void> => {
    if (!(await isFeatureEnabled(key))) {
      return c.json(featureDisabledBody(key), 503);
    }
    await next();
  };
}
