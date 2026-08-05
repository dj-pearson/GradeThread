// US-507: admin feature-flag (kill-switch) management.
// US-886: feature flags v2 — gradual rollout + plan/user targeting + schedule.
//
// Mounted at /api/admin/feature-flags — the /api/admin/* middleware (auth +
// adminAuthMiddleware, incl. the AAL2/MFA gate) already protects it.
//
//   • GET  /                 — list flags + their full targeting rule.
//   • PUT  /                 — fast kill-switch toggle (enabled only). Admin-level
//                              so an operator can disable a flow during an
//                              incident without a super-admin step-up.
//   • PUT  /:key/rule        — edit the targeting rule (rollout %, plan targets,
//                              user allow/deny, schedule, enabled). super_admin +
//                              a fresh MFA step-up + audited — a botched targeting
//                              rule can silently dark-launch or kill a feature for
//                              a slice of users, so it's gated like other config.
//   • POST /preview          — "who this resolves to" count for a PROPOSED rule,
//                              run against the live user base with the SAME
//                              resolver, so the editor previews before saving.
//
// Documented SQL fallback (if the UI is unavailable):
//   update public.feature_flags set enabled = false where key = 'grading';

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  clearFeatureFlagCache,
  type FeatureFlagRule,
  resolveFlagRule,
} from "../lib/feature-flags.ts";
import { effectivePlanFor } from "../lib/grade-pricing.ts";
import { jsonError } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireFreshStepUp, requireStepUp } from "../lib/step-up.ts";
import { requireScope } from "../lib/scope-guard.ts";

type AdminEnv = {
  Variables: { userId: string; adminRole: "admin" | "super_admin" };
};

export const adminFlagsRoutes = new Hono<AdminEnv>();

// US-1560: whole-router scope guard (see lib/admin-scope-map.ts).
adminFlagsRoutes.use("*", requireScope("ops:write"));

// Plans a flag can target — the LIVE `users.flipdesk_plan` tiers (US-2398).
//
// It used to be the `users.plan` enum from 00001, which is a different
// vocabulary AND a frozen column: nothing has written it since the 00039
// backfill, so a rule targeting 'professional' could never match a real account
// and one targeting 'free' matched everyone. Both spellings of the same tier
// were on offer and only the dead one was accepted.
const VALID_PLANS = new Set(["free", "starter", "pro", "business"]);

// The two tiers that were renamed. Applied on write so an existing rule saved
// through the admin UI is corrected in place rather than rejected — a validation
// error on a flag someone is mid-edit is how a stale target survives.
const LEGACY_PLAN_ALIASES: Record<string, string> = {
  professional: "pro",
  enterprise: "business",
};
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Bound the per-user override lists so a paste can't bloat a row.
const MAX_OVERRIDES = 1000;
// Preview scans at most this many users; beyond it we sample + scale.
const PREVIEW_SAMPLE_CAP = 25_000;

const FLAG_SELECT =
  "key, enabled, description, rollout_percentage, plan_targets, user_allow, " +
  "user_deny, starts_at, ends_at, updated_at, updated_by";

// ── List all flags + their targeting rule ──
adminFlagsRoutes.get("/", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("feature_flags")
    .select(FLAG_SELECT)
    .order("key");
  if (error) return jsonError(c, 500, "Failed to load feature flags");
  return c.json({ flags: data ?? [], plans: [...VALID_PLANS] });
});

// ── Fast kill-switch toggle (enabled only). Body: { key, enabled } ──
adminFlagsRoutes.put("/", async (c) => {
  // US-2353 AC2: a feature flag is a kill switch. PUT here toggles ANY flag
  // under the router-wide ops:write and nothing else, while the far less
  // impactful per-flag RULE endpoint below required super_admin AND a step-up —
  // the risk ordering was inverted.
  {
    const stepUp = requireFreshStepUp(c);
    if (stepUp) return stepUp;
  }
  let body: { key?: unknown; enabled?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const key = typeof body.key === "string" ? body.key : "";
  const enabled = body.enabled;
  if (typeof enabled !== "boolean") {
    return jsonError(c, 400, "enabled must be a boolean");
  }

  const { data: before } = await supabaseAdmin
    .from("feature_flags")
    .select("key, enabled")
    .eq("key", key)
    .maybeSingle();
  if (!before) return jsonError(c, 404, "Unknown feature flag");

  const userId = c.get("userId");
  const { error } = await supabaseAdmin
    .from("feature_flags")
    .update({ enabled, updated_by: userId })
    .eq("key", key);
  if (error) return jsonError(c, 500, "Failed to update feature flag");

  // Instant on this replica; others within the cache TTL.
  clearFeatureFlagCache();

  await writeAuditLog(c, {
    action: "feature_flag.toggle",
    targetType: "feature_flag",
    targetId: key,
    before,
    after: { enabled },
  });

  return c.json({ ok: true, key, enabled });
});

// ── Validation for the targeting rule ──

interface ValidatedRule {
  enabled?: boolean;
  rollout_percentage?: number;
  plan_targets?: string[];
  user_allow?: string[];
  user_deny?: string[];
  starts_at?: string | null;
  ends_at?: string | null;
}

function validIso(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false };
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return { ok: false };
  return { ok: true, value: new Date(t).toISOString() };
}

function validIdList(v: unknown): { ok: true; value: string[] } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, value: [] };
  if (!Array.isArray(v)) return { ok: false };
  const seen = new Set<string>();
  for (const raw of v) {
    if (typeof raw !== "string" || !UUID_RE.test(raw.trim())) return { ok: false };
    seen.add(raw.trim().toLowerCase());
  }
  if (seen.size > MAX_OVERRIDES) return { ok: false };
  return { ok: true, value: [...seen] };
}

// Validate a proposed rule body. `partial` allows the PUT to omit fields (only
// the provided ones are updated); the preview always sends a full rule.
export function validateRuleBody(
  body: Record<string, unknown>,
): { ok: true; value: ValidatedRule } | { ok: false; error: string } {
  const out: ValidatedRule = {};

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return { ok: false, error: "enabled must be a boolean" };
    }
    out.enabled = body.enabled;
  }

  if (body.rollout_percentage !== undefined) {
    const n = typeof body.rollout_percentage === "number"
      ? body.rollout_percentage
      : Number(body.rollout_percentage);
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      return { ok: false, error: "rollout_percentage must be an integer 0–100" };
    }
    out.rollout_percentage = n;
  }

  if (body.plan_targets !== undefined) {
    if (!Array.isArray(body.plan_targets)) {
      return { ok: false, error: "plan_targets must be an array" };
    }
    const plans: string[] = [];
    for (const raw of body.plan_targets) {
      if (typeof raw !== "string") {
        return { ok: false, error: `Unknown plan target. Valid: ${[...VALID_PLANS].join(", ")}` };
      }
      const p = LEGACY_PLAN_ALIASES[raw] ?? raw;
      if (!VALID_PLANS.has(p)) {
        return { ok: false, error: `Unknown plan target. Valid: ${[...VALID_PLANS].join(", ")}` };
      }
      if (!plans.includes(p)) plans.push(p);
    }
    out.plan_targets = plans;
  }

  if (body.user_allow !== undefined) {
    const r = validIdList(body.user_allow);
    if (!r.ok) return { ok: false, error: `user_allow must be ≤${MAX_OVERRIDES} valid user ids` };
    out.user_allow = r.value;
  }
  if (body.user_deny !== undefined) {
    const r = validIdList(body.user_deny);
    if (!r.ok) return { ok: false, error: `user_deny must be ≤${MAX_OVERRIDES} valid user ids` };
    out.user_deny = r.value;
  }

  if (body.starts_at !== undefined) {
    const r = validIso(body.starts_at);
    if (!r.ok) return { ok: false, error: "starts_at must be an ISO timestamp or null" };
    out.starts_at = r.value;
  }
  if (body.ends_at !== undefined) {
    const r = validIso(body.ends_at);
    if (!r.ok) return { ok: false, error: "ends_at must be an ISO timestamp or null" };
    out.ends_at = r.value;
  }

  // If both ends of the window are set, ends_at must be after starts_at.
  if (out.starts_at && out.ends_at && Date.parse(out.ends_at) <= Date.parse(out.starts_at)) {
    return { ok: false, error: "ends_at must be after starts_at" };
  }

  return { ok: true, value: out };
}

// ── PUT /:key/rule — edit the targeting rule. super_admin + step-up; audited ──
adminFlagsRoutes.put("/:key/rule", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super admin required to edit targeting rules." }, 403);
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const key = c.req.param("key");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }

  const valid = validateRuleBody(body);
  if (!valid.ok) return jsonError(c, 400, valid.error);
  if (Object.keys(valid.value).length === 0) {
    return jsonError(c, 400, "No editable fields provided");
  }

  const { data: before } = await supabaseAdmin
    .from("feature_flags")
    .select(FLAG_SELECT)
    .eq("key", key)
    .maybeSingle();
  if (!before) return jsonError(c, 404, "Unknown feature flag");

  const userId = c.get("userId");
  const { data: after, error } = await supabaseAdmin
    .from("feature_flags")
    .update({ ...valid.value, updated_by: userId })
    .eq("key", key)
    .select(FLAG_SELECT)
    .maybeSingle();
  if (error) return jsonError(c, 500, "Failed to update targeting rule");

  // Instant on this replica; other replicas pick it up within the cache TTL.
  clearFeatureFlagCache();

  await writeAuditLog(c, {
    action: "feature_flag.rule_update",
    targetType: "feature_flag",
    targetId: key,
    before,
    after,
  });

  return c.json({ ok: true, flag: after });
});

// ── POST /preview — "who this resolves to" for a PROPOSED rule ──
// Body: { key?, enabled, rollout_percentage, plan_targets, user_allow,
//         user_deny, starts_at, ends_at }. Returns the count of users the rule
// resolves ON for, computed with the SAME resolver as production so the preview
// matches reality. Scans up to PREVIEW_SAMPLE_CAP users, then samples + scales.
adminFlagsRoutes.post("/preview", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }

  const valid = validateRuleBody(body);
  if (!valid.ok) return jsonError(c, 400, valid.error);

  const key = typeof body.key === "string" && body.key ? body.key : "preview";
  // Build a FULL rule from the proposed body (defaults match a fresh flag).
  const rule: FeatureFlagRule = {
    enabled: valid.value.enabled ?? true,
    rollout_percentage: valid.value.rollout_percentage ?? 100,
    plan_targets: valid.value.plan_targets ?? [],
    user_allow: valid.value.user_allow ?? [],
    user_deny: valid.value.user_deny ?? [],
    starts_at: valid.value.starts_at ?? null,
    ends_at: valid.value.ends_at ?? null,
  };

  // Total user count (exact, cheap head request).
  const { count: total, error: countErr } = await supabaseAdmin
    .from("users")
    .select("id", { count: "exact", head: true });
  if (countErr) return jsonError(c, 500, "Failed to count users");
  const totalUsers = total ?? 0;

  // Pull a bounded sample and resolve each. US-2398: sample the same column the
  // rule targets, or the preview reports a reach for a tier nobody is recorded
  // as holding. US-2406: resolve it the same WAY runtime does — effectivePlanFor
  // over the billing columns, not the raw tier. A preview that disagrees with
  // the behaviour is what let the runtime gap go unnoticed for as long as it
  // did, so the two now run the identical function over the identical inputs.
  const now = new Date();
  const { data: rows, error: rowsErr } = await supabaseAdmin
    .from("users")
    .select("id, flipdesk_plan, subscription_status, trial_ends_at, past_due_since")
    .limit(PREVIEW_SAMPLE_CAP);
  if (rowsErr) return jsonError(c, 500, "Failed to load users for preview");

  const sample = (rows ?? []) as Array<{
    id: string;
    flipdesk_plan: string | null;
    subscription_status: string | null;
    trial_ends_at: string | null;
    past_due_since: string | null;
  }>;
  let enabledInSample = 0;
  for (const u of sample) {
    const plan = effectivePlanFor(
      u.flipdesk_plan ?? "free",
      u.subscription_status,
      u.trial_ends_at,
      now,
      u.past_due_since,
    );
    if (resolveFlagRule(key, rule, { userId: u.id, plan })) {
      enabledInSample++;
    }
  }

  const sampled = totalUsers > sample.length;
  // Scale the sample count up to the full base when we couldn't scan everyone.
  const enabledCount = sampled && sample.length > 0
    ? Math.round((enabledInSample / sample.length) * totalUsers)
    : enabledInSample;

  return c.json({
    total_users: totalUsers,
    enabled_count: enabledCount,
    sample_size: sample.length,
    sampled,
  });
});
