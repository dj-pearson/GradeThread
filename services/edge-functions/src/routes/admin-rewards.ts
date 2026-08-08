// US-1852: quest/challenge administration.
// US-1853: milestone-reward (tangible) catalog administration.
//
//   GET    /api/admin/rewards/quests      list every definition (enabled or not)
//   POST   /api/admin/rewards/quests      create
//   PATCH  /api/admin/rewards/quests/:id  edit — including the `enabled` switch
//   DELETE /api/admin/rewards/quests/:id  delete a quest nobody has finished
//
//   GET    /api/admin/rewards/milestones      the tangible catalog + its options
//   POST   /api/admin/rewards/milestones      create
//   PATCH  /api/admin/rewards/milestones/:id  edit (the key is frozen once paid)
//   DELETE /api/admin/rewards/milestones/:id  delete one nothing has been paid on
//
// PLATFORM-level, not tenant-scoped: gated by the /api/admin/* auth + admin
// middleware in main.ts, and every mutation is audit-logged.
//
// Two things this route refuses on purpose, because the DB CHECKs alone would
// give an operator a 500 instead of a sentence:
//   • a metric outside QUEST_METRICS — notably `quest_completed`, which would let
//     two cheap quests bootstrap each other into an XP loop;
//   • an XP reward above QUEST_XP_MAX — an operator-editable number that mints XP
//     is a faucet, and it is capped in the DB, in the scorer, and here.
//
// DELETE is narrow by design. A quest people have already completed is history,
// and deleting it would cascade their completion rows away while the ledger rows
// that paid them survive — so the two would disagree. Retire it with
// `enabled: false` instead; that is what the column is for.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireScope } from "../lib/scope-guard.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { QUEST_METRICS, isQuestMetric } from "../lib/rewards-quests.ts";
import { QUEST_XP_MAX } from "../lib/rewards-engine.ts";
import { BADGE_CATALOG } from "../lib/rewards-badges.ts";
import { SEASON_GOALS } from "../lib/rewards-seasons.ts";
import { bustSettingCache, getSetting } from "../lib/system-settings.ts";
import { clearFeatureFlagCache } from "../lib/feature-flags.ts";
import { getStripe } from "../lib/stripe-client.ts";
import {
  DEFAULT_REWARD_BUDGET,
  monthStartIso,
  normalizeRewardBudget,
  REWARD_BUDGET_SETTING_KEY,
} from "../lib/rewards-tangible.ts";
import type { RewardBudget } from "../lib/rewards-tangible.ts";
import {
  NUDGE_CONFIG_KEY,
  normalizeNudgeConfig,
  summarizeLift,
} from "../lib/rewards-nudges.ts";
import {
  DEFAULT_REWARD_GUARDRAILS,
  guardrailsToSetting,
  normalizeRewardGuardrails,
  reconcileGrants,
  REWARD_GUARDRAILS_SETTING_KEY,
  summarizeRoi,
} from "../lib/rewards-economics.ts";
import type {
  CreditLedgerRow,
  GrantLedgerRow,
  RewardGuardrails,
} from "../lib/rewards-economics.ts";

type AdminRewardsEnv = { Variables: { userId: string } };

export const adminRewardsRoutes = new Hono<AdminRewardsEnv>();

// US-1560 RBAC: router-wide, because every route here edits the engagement
// economy and the reads exist to serve those edits — the whole surface should
// close together when growth:write is revoked. Safe as a use("*") wildcard: this
// router owns its mount prefix (/api/admin/rewards), so the US-2377 parent-router
// leak doesn't apply. Classified in lib/admin-scope-map.ts.
adminRewardsRoutes.use("*", requireScope("growth:write"));

const QUEST_COLUMNS =
  "id, key, name, description, quest_type, metric, target, cadence, starts_at, ends_at, xp_reward, icon, enabled, sort_order, created_at, updated_at";

const QUEST_TYPES = new Set(["personal", "community"]);
const CADENCES = new Set(["weekly", "monthly", "fixed"]);
const KEY_RE = /^[a-z0-9][a-z0-9_]{1,48}[a-z0-9]$/;

interface QuestPayload {
  key: string;
  name: string;
  description: string;
  quest_type: string;
  metric: string;
  target: number;
  cadence: string;
  starts_at: string | null;
  ends_at: string | null;
  xp_reward: number;
  icon: string;
  enabled: boolean;
  sort_order: number;
}

class QuestInputError extends Error {}

function optionalIso(raw: unknown, label: string): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string") throw new QuestInputError(`${label} must be a date.`);
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) throw new QuestInputError(`${label} is not a valid date.`);
  return new Date(t).toISOString();
}

/**
 * Validate a create/patch body into the columns. `partial` allows a PATCH to
 * send only what it changes; the cross-field rules below still run over the
 * MERGED row so a patch can't leave a community challenge without a window.
 */
function parseQuest(body: Record<string, unknown>, existing?: QuestPayload): QuestPayload {
  const base: QuestPayload = existing ?? {
    key: "",
    name: "",
    description: "",
    quest_type: "personal",
    metric: "coverage_completed",
    target: 1,
    cadence: "weekly",
    starts_at: null,
    ends_at: null,
    xp_reward: 0,
    icon: "Target",
    enabled: true,
    sort_order: 100,
  };
  const out: QuestPayload = { ...base };

  if (body.key !== undefined || !existing) {
    const key = typeof body.key === "string" ? body.key.trim().toLowerCase() : "";
    if (!KEY_RE.test(key)) {
      throw new QuestInputError(
        "Key must be 3–50 characters of lowercase letters, numbers and underscores.",
      );
    }
    out.key = key;
  }
  if (body.name !== undefined || !existing) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new QuestInputError("Name is required.");
    out.name = name.slice(0, 120);
  }
  if (body.description !== undefined) {
    out.description = typeof body.description === "string"
      ? body.description.trim().slice(0, 400)
      : "";
  }
  if (body.quest_type !== undefined) {
    if (typeof body.quest_type !== "string" || !QUEST_TYPES.has(body.quest_type)) {
      throw new QuestInputError("Type must be personal or community.");
    }
    out.quest_type = body.quest_type;
  }
  if (body.metric !== undefined || !existing) {
    if (!isQuestMetric(body.metric)) {
      throw new QuestInputError(`Metric must be one of: ${QUEST_METRICS.join(", ")}.`);
    }
    out.metric = body.metric;
  }
  if (body.target !== undefined || !existing) {
    const target = Math.floor(Number(body.target));
    if (!Number.isFinite(target) || target < 1) {
      throw new QuestInputError("Target must be a whole number of 1 or more.");
    }
    out.target = target;
  }
  if (body.cadence !== undefined) {
    if (typeof body.cadence !== "string" || !CADENCES.has(body.cadence)) {
      throw new QuestInputError("Cadence must be weekly, monthly or fixed.");
    }
    out.cadence = body.cadence;
  }
  if (body.starts_at !== undefined) out.starts_at = optionalIso(body.starts_at, "Start");
  if (body.ends_at !== undefined) out.ends_at = optionalIso(body.ends_at, "End");
  if (body.xp_reward !== undefined) {
    const xp = Math.floor(Number(body.xp_reward));
    if (!Number.isFinite(xp) || xp < 0 || xp > QUEST_XP_MAX) {
      throw new QuestInputError(`XP reward must be between 0 and ${QUEST_XP_MAX}.`);
    }
    out.xp_reward = xp;
  }
  if (body.icon !== undefined && typeof body.icon === "string" && body.icon.trim()) {
    out.icon = body.icon.trim().slice(0, 40);
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw new QuestInputError("Enabled must be true/false.");
    out.enabled = body.enabled;
  }
  if (body.sort_order !== undefined) {
    const n = Math.floor(Number(body.sort_order));
    out.sort_order = Number.isFinite(n) ? n : 100;
  }

  // ── Cross-field rules (mirrors the CHECKs in 00543) ───────────────────────
  if (out.cadence === "fixed" && (!out.starts_at || !out.ends_at)) {
    throw new QuestInputError("A fixed-window quest needs both a start and an end.");
  }
  if (out.quest_type === "community" && out.cadence !== "fixed") {
    throw new QuestInputError(
      "A community challenge must be time-boxed — give it a fixed start and end.",
    );
  }
  if (out.starts_at && out.ends_at && Date.parse(out.ends_at) <= Date.parse(out.starts_at)) {
    throw new QuestInputError("The end must be after the start.");
  }
  // An `xp` community challenge would have to scan every reward type across all
  // users to rank anyone, so loadChallengeStandings returns an empty board for
  // it. Refuse it here rather than ship a challenge whose leaderboard is always
  // blank.
  if (out.quest_type === "community" && out.metric === "xp") {
    throw new QuestInputError("A community challenge must count an action, not raw XP.");
  }
  return out;
}

adminRewardsRoutes.get("/quests", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("reward_quests")
    .select(QUEST_COLUMNS)
    .order("quest_type", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("key", { ascending: true });
  if (error) {
    return failSafe(c, 500, "Couldn't load the quests.", error, "admin.rewards.quests.list");
  }
  return c.json({ quests: data ?? [], metrics: QUEST_METRICS, xp_max: QUEST_XP_MAX });
});

adminRewardsRoutes.post("/quests", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  let payload: QuestPayload;
  try {
    payload = parseQuest(body);
  } catch (err) {
    if (err instanceof QuestInputError) {
      return c.json({ error: err.message }, 400); // safe-raw-error: typed validation copy
    }
    throw err;
  }

  const { data, error } = await supabaseAdmin
    .from("reward_quests")
    .insert({ ...payload, created_by: c.get("userId") } as never)
    .select(QUEST_COLUMNS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return c.json({ error: "A quest with that key already exists." }, 409);
    }
    return failSafe(c, 500, "Couldn't create the quest.", error, "admin.rewards.quests.create");
  }

  await writeAuditLog(c, {
    action: "rewards.quest.create",
    targetType: "reward_quest",
    targetId: (data as { id: string }).id,
    details: { key: payload.key, metric: payload.metric, xp_reward: payload.xp_reward },
  });
  return c.json({ quest: data });
});

adminRewardsRoutes.patch("/quests/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { data: current, error: loadErr } = await supabaseAdmin
    .from("reward_quests")
    .select(QUEST_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (loadErr) {
    return failSafe(c, 500, "Couldn't load the quest.", loadErr, "admin.rewards.quests.load");
  }
  if (!current) return c.json({ error: "Quest not found." }, 404);

  let payload: QuestPayload;
  try {
    payload = parseQuest(body, current as unknown as QuestPayload);
  } catch (err) {
    if (err instanceof QuestInputError) {
      return c.json({ error: err.message }, 400); // safe-raw-error: typed validation copy
    }
    throw err;
  }

  const { data, error } = await supabaseAdmin
    .from("reward_quests")
    .update(payload as never)
    .eq("id", id)
    .select(QUEST_COLUMNS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return c.json({ error: "A quest with that key already exists." }, 409);
    }
    return failSafe(c, 500, "Couldn't update the quest.", error, "admin.rewards.quests.update");
  }

  await writeAuditLog(c, {
    action: "rewards.quest.update",
    targetType: "reward_quest",
    targetId: id,
    details: { key: payload.key, enabled: payload.enabled, xp_reward: payload.xp_reward },
  });
  return c.json({ quest: data });
});

adminRewardsRoutes.delete("/quests/:id", async (c) => {
  const id = c.req.param("id");

  // Refuse to delete a quest anyone has finished — the completion rows would
  // cascade away while the ledger rows that paid them survive, and the two would
  // then disagree about what happened. Disable it instead.
  const { count, error: countErr } = await supabaseAdmin
    .from("user_quest_progress")
    .select("id", { count: "exact", head: true })
    .eq("quest_id", id)
    .not("completed_at", "is", null);
  if (countErr) {
    return failSafe(c, 500, "Couldn't check the quest.", countErr, "admin.rewards.quests.check");
  }
  if ((count ?? 0) > 0) {
    return c.json({
      error:
        "People have already completed this quest. Turn it off instead — deleting it would erase their completions.",
    }, 409);
  }

  const { error } = await supabaseAdmin.from("reward_quests").delete().eq("id", id);
  if (error) {
    return failSafe(c, 500, "Couldn't delete the quest.", error, "admin.rewards.quests.delete");
  }
  await writeAuditLog(c, {
    action: "rewards.quest.delete",
    targetType: "reward_quest",
    targetId: id,
  });
  return c.json({ ok: true });
});

// ─── US-1853: the tangible milestone catalog ────────────────────────────────
//
// Everything here mints REAL value — grade credits, a Stripe coupon — so the
// validation is deliberately stricter than the DB CHECKs alone. Three refusals
// exist only at this layer, because the database cannot see what they protect:
//
//   • a badge / season-goal trigger whose key is not in the shipped catalog. The
//     DB only knows the key is non-empty, so a typo would create a rung nobody
//     can ever reach — and it would look live in the table forever.
//   • renaming the KEY of a milestone somebody has already been paid. The key is
//     the idempotency handle on the grant ledger; change it and every holder is
//     eligible again under the new name, which is exactly the double-issue the
//     UNIQUE index exists to make impossible.
//   • deleting a milestone with grants against it. Same reason as the quests
//     above: the ledger rows that paid people survive, and the catalog would then
//     disagree with them about what was given. Switch it off instead.

const MILESTONE_COLUMNS =
  "id, key, label, description, reward_type, trigger_type, xp_threshold, trigger_key, reward_value, cost_usd, discount_duration_months, discount_valid_days, monthly_grant_cap, lifetime_grant_cap, enabled, sort_order, created_at, updated_at";

const REWARD_TYPES = ["free_grade_credits", "subscription_discount", "per_grade_discount"] as const;
const TRIGGER_TYPES = ["xp_threshold", "badge", "season_goal", "anniversary"] as const;
const BADGE_KEYS = BADGE_CATALOG.map((b) => b.key);
const SEASON_GOAL_KEYS = SEASON_GOALS.map((g) => g.key);
/**
 * US-1914: the only trigger key an anniversary milestone can carry.
 *
 * A closed set rather than free text for the same reason the badge and season
 * keys are closed: a typo here would create a rung nobody can ever reach and it
 * would look live in the table forever. There is exactly one thing an
 * anniversary can be about — the account — and the engine keys the GRANT by
 * year, not by this.
 */
const ANNIVERSARY_KEYS = ["account"];

interface MilestonePayload {
  key: string;
  label: string;
  description: string;
  reward_type: string;
  trigger_type: string;
  xp_threshold: number | null;
  trigger_key: string | null;
  reward_value: number;
  cost_usd: number;
  discount_duration_months: number | null;
  discount_valid_days: number | null;
  monthly_grant_cap: number | null;
  lifetime_grant_cap: number | null;
  enabled: boolean;
  sort_order: number;
}

class MilestoneInputError extends Error {}

/** A nullable positive whole number within a band, or throws. */
function optionalBoundedInt(
  raw: unknown,
  label: string,
  min: number,
  max: number,
): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new MilestoneInputError(`${label} must be between ${min} and ${max}, or left blank.`);
  }
  return n;
}

function parseMilestone(
  body: Record<string, unknown>,
  existing?: MilestonePayload,
): MilestonePayload {
  const base: MilestonePayload = existing ?? {
    key: "",
    label: "",
    description: "",
    reward_type: "free_grade_credits",
    trigger_type: "xp_threshold",
    xp_threshold: null,
    trigger_key: null,
    reward_value: 1,
    cost_usd: 0,
    discount_duration_months: null,
    discount_valid_days: null,
    monthly_grant_cap: null,
    lifetime_grant_cap: null,
    enabled: false,
    sort_order: 100,
  };
  const out: MilestonePayload = { ...base };

  if (body.key !== undefined || !existing) {
    const key = typeof body.key === "string" ? body.key.trim().toLowerCase() : "";
    if (!KEY_RE.test(key)) {
      throw new MilestoneInputError(
        "Key must be 3–50 characters of lowercase letters, numbers and underscores.",
      );
    }
    out.key = key;
  }
  if (body.label !== undefined || !existing) {
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label) throw new MilestoneInputError("Label is required.");
    out.label = label.slice(0, 120);
  }
  if (body.description !== undefined) {
    out.description = typeof body.description === "string"
      ? body.description.trim().slice(0, 400)
      : "";
  }
  if (body.reward_type !== undefined || !existing) {
    if (
      typeof body.reward_type !== "string" ||
      !(REWARD_TYPES as readonly string[]).includes(body.reward_type)
    ) {
      throw new MilestoneInputError(`Reward must be one of: ${REWARD_TYPES.join(", ")}.`);
    }
    out.reward_type = body.reward_type;
  }
  if (body.trigger_type !== undefined || !existing) {
    if (
      typeof body.trigger_type !== "string" ||
      !(TRIGGER_TYPES as readonly string[]).includes(body.trigger_type)
    ) {
      throw new MilestoneInputError(`Trigger must be one of: ${TRIGGER_TYPES.join(", ")}.`);
    }
    out.trigger_type = body.trigger_type;
  }
  if (body.xp_threshold !== undefined) {
    out.xp_threshold = optionalBoundedInt(body.xp_threshold, "XP threshold", 0, 10_000_000);
  }
  if (body.trigger_key !== undefined) {
    out.trigger_key = typeof body.trigger_key === "string" && body.trigger_key.trim()
      ? body.trigger_key.trim()
      : null;
  }
  if (body.reward_value !== undefined || !existing) {
    const v = Number(body.reward_value);
    if (!Number.isFinite(v) || v <= 0) {
      throw new MilestoneInputError("Reward value must be greater than zero.");
    }
    out.reward_value = Math.round(v * 100) / 100;
  }
  if (body.cost_usd !== undefined) {
    const v = Number(body.cost_usd);
    if (!Number.isFinite(v) || v < 0) {
      throw new MilestoneInputError("Cost must be zero or more.");
    }
    out.cost_usd = Math.round(v * 100) / 100;
  }
  if (body.discount_duration_months !== undefined) {
    out.discount_duration_months = optionalBoundedInt(
      body.discount_duration_months,
      "Discount duration (months)",
      1,
      12,
    );
  }
  if (body.discount_valid_days !== undefined) {
    out.discount_valid_days = optionalBoundedInt(
      body.discount_valid_days,
      "Discount window (days)",
      1,
      730,
    );
  }
  if (body.monthly_grant_cap !== undefined) {
    out.monthly_grant_cap = optionalBoundedInt(body.monthly_grant_cap, "Monthly cap", 1, 1_000_000);
  }
  if (body.lifetime_grant_cap !== undefined) {
    out.lifetime_grant_cap = optionalBoundedInt(
      body.lifetime_grant_cap,
      "Lifetime cap",
      1,
      1_000_000,
    );
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      throw new MilestoneInputError("Enabled must be true/false.");
    }
    out.enabled = body.enabled;
  }
  if (body.sort_order !== undefined) {
    const n = Math.floor(Number(body.sort_order));
    out.sort_order = Number.isFinite(n) ? n : 100;
  }

  // ── Cross-field rules (mirrors the CHECKs in 00544, plus the catalog ones) ──
  if (out.trigger_type === "xp_threshold") {
    if (out.xp_threshold === null) {
      throw new MilestoneInputError("An XP milestone needs an XP threshold.");
    }
    out.trigger_key = null;
  } else {
    const known = out.trigger_type === "badge"
      ? BADGE_KEYS
      : out.trigger_type === "season_goal"
      ? SEASON_GOAL_KEYS
      : ANNIVERSARY_KEYS;
    const noun = out.trigger_type === "badge"
      ? "Badge"
      : out.trigger_type === "season_goal"
      ? "Season goal"
      : "Anniversary subject";
    if (!out.trigger_key || !known.includes(out.trigger_key)) {
      throw new MilestoneInputError(`${noun} must be one of: ${known.join(", ")}.`);
    }
    out.xp_threshold = null;
  }
  // US-1914: an anniversary is granted once a YEAR, per user, forever. A discount
  // that repeats annually is a standing price cut with a calendar in front of it,
  // and the cost_usd an operator entered for one issue would understate it by
  // however many years the customer stays. Credits are the only honest shape.
  if (out.trigger_type === "anniversary" && out.reward_type !== "free_grade_credits") {
    throw new MilestoneInputError(
      "An anniversary reward has to be free grade credits — it repeats every year, and a repeating discount is a permanent price cut.",
    );
  }
  if (out.reward_type === "free_grade_credits") {
    if (!Number.isInteger(out.reward_value)) {
      throw new MilestoneInputError("Free grades must be a whole number of credits.");
    }
    out.discount_duration_months = null;
    out.discount_valid_days = null;
  } else {
    if (out.reward_value > 100) {
      throw new MilestoneInputError("A discount can't be more than 100%.");
    }
    if (out.reward_type === "subscription_discount") out.discount_valid_days = null;
    else out.discount_duration_months = null;
  }
  if (
    out.monthly_grant_cap !== null && out.lifetime_grant_cap !== null &&
    out.monthly_grant_cap > out.lifetime_grant_cap
  ) {
    throw new MilestoneInputError("The monthly cap can't exceed the lifetime cap.");
  }
  return out;
}

/** How many grants exist against a milestone key. -1 signals a read failure. */
async function grantCountFor(key: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("reward_tangible_grants")
    .select("id", { count: "exact", head: true })
    .eq("milestone_key", key);
  if (error) return -1;
  return count ?? 0;
}

adminRewardsRoutes.get("/milestones", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("reward_milestones")
    .select(MILESTONE_COLUMNS)
    .order("sort_order", { ascending: true })
    .order("key", { ascending: true });
  if (error) {
    return failSafe(
      c,
      500,
      "Couldn't load the milestones.",
      error,
      "admin.rewards.milestones.list",
    );
  }
  return c.json({
    milestones: data ?? [],
    reward_types: REWARD_TYPES,
    trigger_types: TRIGGER_TYPES,
    badges: BADGE_CATALOG.map((b) => ({ key: b.key, name: b.name })),
    season_goals: SEASON_GOALS.map((g) => ({ key: g.key, name: g.name })),
    anniversary_keys: ANNIVERSARY_KEYS,
  });
});

adminRewardsRoutes.post("/milestones", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  let payload: MilestonePayload;
  try {
    payload = parseMilestone(body);
  } catch (err) {
    if (err instanceof MilestoneInputError) {
      return c.json({ error: err.message }, 400); // safe-raw-error: typed validation copy
    }
    throw err;
  }

  const { data, error } = await supabaseAdmin
    .from("reward_milestones")
    .insert({ ...payload, created_by: c.get("userId") } as never)
    .select(MILESTONE_COLUMNS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return c.json({ error: "A milestone with that key already exists." }, 409);
    }
    return failSafe(
      c,
      500,
      "Couldn't create the milestone.",
      error,
      "admin.rewards.milestones.create",
    );
  }

  await writeAuditLog(c, {
    action: "rewards.milestone.create",
    targetType: "reward_milestone",
    targetId: (data as { id: string }).id,
    details: {
      key: payload.key,
      reward_type: payload.reward_type,
      reward_value: payload.reward_value,
      cost_usd: payload.cost_usd,
      enabled: payload.enabled,
    },
  });
  return c.json({ milestone: data });
});

adminRewardsRoutes.patch("/milestones/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { data: current, error: loadErr } = await supabaseAdmin
    .from("reward_milestones")
    .select(MILESTONE_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (loadErr) {
    return failSafe(
      c,
      500,
      "Couldn't load the milestone.",
      loadErr,
      "admin.rewards.milestones.load",
    );
  }
  if (!current) return c.json({ error: "Milestone not found." }, 404);

  const existing = current as unknown as MilestonePayload;
  let payload: MilestonePayload;
  try {
    payload = parseMilestone(body, existing);
  } catch (err) {
    if (err instanceof MilestoneInputError) {
      return c.json({ error: err.message }, 400); // safe-raw-error: typed validation copy
    }
    throw err;
  }

  if (payload.key !== existing.key) {
    const granted = await grantCountFor(existing.key);
    if (granted !== 0) {
      return c.json({
        error: granted < 0
          ? "Couldn't check this milestone's grants, so the key can't be changed right now."
          : "This milestone has already been granted, so its key is fixed. The key is what stops it being paid twice.",
      }, 409);
    }
  }

  const { data, error } = await supabaseAdmin
    .from("reward_milestones")
    .update(payload as never)
    .eq("id", id)
    .select(MILESTONE_COLUMNS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return c.json({ error: "A milestone with that key already exists." }, 409);
    }
    return failSafe(
      c,
      500,
      "Couldn't update the milestone.",
      error,
      "admin.rewards.milestones.update",
    );
  }

  await writeAuditLog(c, {
    action: "rewards.milestone.update",
    targetType: "reward_milestone",
    targetId: id,
    details: {
      key: payload.key,
      reward_type: payload.reward_type,
      reward_value: payload.reward_value,
      cost_usd: payload.cost_usd,
      enabled: payload.enabled,
    },
  });
  return c.json({ milestone: data });
});

adminRewardsRoutes.delete("/milestones/:id", async (c) => {
  const id = c.req.param("id");

  const { data: current, error: loadErr } = await supabaseAdmin
    .from("reward_milestones")
    .select("id, key, label")
    .eq("id", id)
    .maybeSingle();
  if (loadErr) {
    return failSafe(
      c,
      500,
      "Couldn't load the milestone.",
      loadErr,
      "admin.rewards.milestones.load",
    );
  }
  if (!current) return c.json({ error: "Milestone not found." }, 404);

  const key = (current as { key: string }).key;
  const granted = await grantCountFor(key);
  if (granted !== 0) {
    return c.json({
      error: granted < 0
        ? "Couldn't check this milestone's grants, so it can't be deleted right now."
        : "People have already been paid this reward. Turn it off instead — deleting it would leave those grants describing a milestone that no longer exists.",
    }, 409);
  }

  const { error } = await supabaseAdmin.from("reward_milestones").delete().eq("id", id);
  if (error) {
    return failSafe(
      c,
      500,
      "Couldn't delete the milestone.",
      error,
      "admin.rewards.milestones.delete",
    );
  }
  await writeAuditLog(c, {
    action: "rewards.milestone.delete",
    targetType: "reward_milestone",
    targetId: id,
    details: { key },
  });
  return c.json({ ok: true });
});

// ─── US-1914: the tenure ladder ─────────────────────────────────────────────
//
// The milestone catalog above decides WHAT a reward is. This decides how much
// bigger it comes out for a long-standing customer, which is why it lives beside
// it rather than in a settings page somewhere: an operator reading a milestone's
// cost_usd needs the multiplier that can grow it in the same screen, or the
// budget arithmetic on the milestone table is quietly wrong.
//
// Two refusals exist only at this layer, and both are about the one promise this
// feature makes:
//   • the multiplier is floored at 1.00. The DB CHECK says the same thing; it is
//     restated here so the operator gets a sentence instead of a constraint name,
//     because "loyalty multiplier: 0.9" is a penalty someone would have typed by
//     accident and shipped by not reading the error.
//   • a tier's RANK is immutable once anyone holds it. Rank is what
//     user_loyalty_state.tier_rank_peak stores, so renumbering a live ladder
//     would re-point everybody's standing at a different tier — a demotion
//     performed by a config edit, which is exactly what "never decays" forbids.
//
// Deliberately absent: a delete. Standing that people hold cannot be deleted out
// from under them; DISABLE a tier instead and it stops being newly reachable
// while everyone who reached it keeps it.

const TENURE_COLUMNS =
  "id, key, label, blurb, tier_rank, min_months, min_paid_months, credit_multiplier, enabled, sort_order, created_at, updated_at";

interface TenurePayload {
  key: string;
  label: string;
  blurb: string;
  tier_rank: number;
  min_months: number;
  min_paid_months: number;
  credit_multiplier: number;
  enabled: boolean;
  sort_order: number;
}

class TenureInputError extends Error {}

function boundedInt(raw: unknown, label: string, min: number, max: number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new TenureInputError(`${label} must be a whole number between ${min} and ${max}.`);
  }
  return n;
}

function parseTenureTier(
  body: Record<string, unknown>,
  existing?: TenurePayload,
): TenurePayload {
  const base: TenurePayload = existing ?? {
    key: "",
    label: "",
    blurb: "",
    tier_rank: 0,
    min_months: 0,
    min_paid_months: 0,
    credit_multiplier: 1,
    enabled: false,
    sort_order: 100,
  };
  const out: TenurePayload = { ...base };

  if (body.key !== undefined || !existing) {
    const key = typeof body.key === "string" ? body.key.trim().toLowerCase() : "";
    if (!KEY_RE.test(key)) {
      throw new TenureInputError(
        "Key must be 3–50 characters of lowercase letters, numbers and underscores.",
      );
    }
    out.key = key;
  }
  if (body.label !== undefined || !existing) {
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label) throw new TenureInputError("Label is required.");
    out.label = label.slice(0, 120);
  }
  if (body.blurb !== undefined) {
    out.blurb = typeof body.blurb === "string" ? body.blurb.trim().slice(0, 400) : "";
  }
  if (body.tier_rank !== undefined || !existing) {
    out.tier_rank = boundedInt(body.tier_rank, "Rank", 0, 100);
  }
  if (body.min_months !== undefined || !existing) {
    out.min_months = boundedInt(body.min_months, "Months on the platform", 0, 600);
  }
  if (body.min_paid_months !== undefined) {
    out.min_paid_months = boundedInt(body.min_paid_months, "Paid months", 0, 600);
  }
  if (body.credit_multiplier !== undefined || !existing) {
    const v = Number(body.credit_multiplier);
    if (!Number.isFinite(v) || v < 1 || v > 5) {
      throw new TenureInputError(
        "The credit multiplier has to be between 1.00 and 5.00 — a loyalty multiplier below 1 would be a loyalty penalty.",
      );
    }
    out.credit_multiplier = Math.round(v * 100) / 100;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      throw new TenureInputError("Enabled must be true/false.");
    }
    out.enabled = body.enabled;
  }
  if (body.sort_order !== undefined) {
    const n = Math.floor(Number(body.sort_order));
    out.sort_order = Number.isFinite(n) ? n : 100;
  }
  return out;
}

/** How many accounts stand at or above a rank. -1 signals a read failure. */
async function holdersAtRank(rank: number): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("user_loyalty_state")
    .select("user_id", { count: "exact", head: true })
    .gte("tier_rank_peak", rank);
  if (error) return -1;
  return count ?? 0;
}

adminRewardsRoutes.get("/tenure-tiers", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("reward_tenure_tiers")
    .select(TENURE_COLUMNS)
    .order("tier_rank", { ascending: true });
  if (error) {
    return failSafe(c, 500, "Couldn't load the tenure tiers.", error, "admin.rewards.tenure.list");
  }
  return c.json({ tiers: data ?? [] });
});

adminRewardsRoutes.post("/tenure-tiers", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  let payload: TenurePayload;
  try {
    payload = parseTenureTier(body);
  } catch (err) {
    if (err instanceof TenureInputError) {
      return c.json({ error: err.message }, 400); // safe-raw-error: typed validation copy
    }
    throw err;
  }

  const { data, error } = await supabaseAdmin
    .from("reward_tenure_tiers")
    .insert(payload as never)
    .select(TENURE_COLUMNS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return c.json({ error: "A tier with that key or rank already exists." }, 409);
    }
    return failSafe(
      c,
      500,
      "Couldn't create the tenure tier.",
      error,
      "admin.rewards.tenure.create",
    );
  }

  await writeAuditLog(c, {
    action: "rewards.tenure_tier.create",
    targetType: "reward_tenure_tier",
    targetId: (data as { id: string }).id,
    details: {
      key: payload.key,
      tier_rank: payload.tier_rank,
      credit_multiplier: payload.credit_multiplier,
      enabled: payload.enabled,
    },
  });
  return c.json({ tier: data });
});

adminRewardsRoutes.patch("/tenure-tiers/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { data: current, error: loadErr } = await supabaseAdmin
    .from("reward_tenure_tiers")
    .select(TENURE_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (loadErr) {
    return failSafe(c, 500, "Couldn't load the tenure tier.", loadErr, "admin.rewards.tenure.load");
  }
  if (!current) return c.json({ error: "Tenure tier not found." }, 404);

  const existing = current as unknown as TenurePayload;
  let payload: TenurePayload;
  try {
    payload = parseTenureTier(body, existing);
  } catch (err) {
    if (err instanceof TenureInputError) {
      return c.json({ error: err.message }, 400); // safe-raw-error: typed validation copy
    }
    throw err;
  }

  if (payload.tier_rank !== existing.tier_rank) {
    const holders = await holdersAtRank(existing.tier_rank);
    if (holders !== 0) {
      return c.json({
        error: holders < 0
          ? "Couldn't check who holds this tier, so its rank can't be changed right now."
          : "People already stand at this tier, so its rank is fixed. Rank is what their standing is recorded against — renumbering it would move them.",
      }, 409);
    }
  }

  const { data, error } = await supabaseAdmin
    .from("reward_tenure_tiers")
    .update(payload as never)
    .eq("id", id)
    .select(TENURE_COLUMNS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return c.json({ error: "A tier with that key or rank already exists." }, 409);
    }
    return failSafe(
      c,
      500,
      "Couldn't update the tenure tier.",
      error,
      "admin.rewards.tenure.update",
    );
  }

  await writeAuditLog(c, {
    action: "rewards.tenure_tier.update",
    targetType: "reward_tenure_tier",
    targetId: id,
    details: {
      key: payload.key,
      tier_rank: payload.tier_rank,
      credit_multiplier: payload.credit_multiplier,
      enabled: payload.enabled,
    },
  });
  return c.json({ tier: data });
});

// ─── US-1858: economics guardrails, budget & anti-abuse ─────────────────────
//
// The catalog above decides what a milestone GIVES. This section is the other
// half an operator needs: what the whole rail is allowed to cost, whether it is
// currently paying at all, what refused a grant and when, whether the value that
// left actually arrived, and whether any of it bought a signup.
//
// Four things it deliberately does NOT do:
//   • meter cosmetic rewards. XP, levels, badges and streaks have no marginal
//     cost, so a budget on them would buy no margin and would let a billing
//     outage break the engagement loop.
//   • let an operator raise a cap without a second factor. Every number here
//     widens or narrows a money faucet, so the writes are step-up gated and
//     audited.
//   • repair anything it finds. Reconciliation REPORTS; a disagreement between
//     the grant ledger and the credit ledger is a fact to investigate, and a
//     console that silently "fixed" it would destroy the evidence of how it
//     happened.
//   • invent a second fraud queue. A tripped velocity limit raises a
//     `reward_farming` abuse signal, which lands in /admin/safety beside every
//     other signal an operator already triages.

const BREACH_PAGE_CAP = 50;
const RECONCILE_GRANT_CAP = 500;
const RECONCILE_COUPON_LOOKUP_CAP = 100;
const ROI_MAX_DAYS = 365;
const ROI_DEFAULT_DAYS = 30;
// US-1859: the nudge lift report reads raw send rows and folds them in memory —
// bounded so a wide window cannot pull an unbounded scan into one response.
const NUDGE_ROW_CAP = 20000;

class EconomicsInputError extends Error {}

function windowDays(raw: string | undefined, fallback = ROI_DEFAULT_DAYS): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(ROI_MAX_DAYS, n);
}

function sinceIso(days: number, nowMs: number): string {
  return new Date(nowMs - days * 86_400_000).toISOString();
}

/** The `rewards_tangible` kill-switch as the console shows it. */
async function loadKillSwitch(): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("feature_flags")
    .select("enabled")
    .eq("key", "rewards_tangible")
    .maybeSingle();
  // Absent reads as OFF — the engine reads this flag fail-CLOSED, so the console
  // must agree with it rather than show a rail that is not actually paying.
  return !!(data as { enabled?: boolean } | null)?.enabled;
}

function sumCost(rows: Array<{ cost_usd: number | string }> | null): number {
  return (rows ?? []).reduce((acc, r) => acc + (Number(r.cost_usd) || 0), 0);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Reward spend + the signups it can be credited with, over one window. */
async function loadRoi(days: number, nowMs: number) {
  const since = sinceIso(days, nowMs);
  const [grantsRes, referralsRes, sharesRes] = await Promise.all([
    supabaseAdmin
      .from("reward_tangible_grants")
      .select("cost_usd")
      .eq("status", "granted")
      .gte("granted_at", since),
    supabaseAdmin
      .from("referral_events")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since),
    supabaseAdmin
      .from("reputation_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "share_milestone")
      .like("reference_id", "%:signup")
      .gte("created_at", since),
  ]);

  return {
    window_days: days,
    since,
    ...summarizeRoi({
      rewardSpendUsd: round2(
        sumCost(grantsRes.data as Array<{ cost_usd: number | string }> | null),
      ),
      referralSignups: referralsRes.count ?? 0,
      shareSignups: sharesRes.count ?? 0,
    }),
  };
}

adminRewardsRoutes.get("/economics", async (c) => {
  const nowMs = Date.now();
  const monthStart = monthStartIso(nowMs);

  const [budgetRaw, guardrailsRaw, enabled, monthRes, lifetimeRes, breachRes, roi] = await Promise
    .all([
      getSetting<unknown>(REWARD_BUDGET_SETTING_KEY, DEFAULT_REWARD_BUDGET),
      getSetting<unknown>(REWARD_GUARDRAILS_SETTING_KEY, DEFAULT_REWARD_GUARDRAILS),
      loadKillSwitch(),
      supabaseAdmin
        .from("reward_tangible_grants")
        .select("cost_usd, user_id")
        .eq("status", "granted")
        .gte("granted_at", monthStart),
      supabaseAdmin
        .from("reward_tangible_grants")
        .select("cost_usd")
        .eq("status", "granted"),
      supabaseAdmin
        .from("reward_budget_breaches")
        .select(
          "id, scope, subject_user_id, limit_usd, spend_usd, milestone_key, killed, detail, created_at",
        )
        .is("resolved_at", null)
        .order("created_at", { ascending: false })
        .limit(BREACH_PAGE_CAP),
      loadRoi(ROI_DEFAULT_DAYS, nowMs),
    ]);

  if (monthRes.error || lifetimeRes.error || breachRes.error) {
    return failSafe(
      c,
      500,
      "Couldn't load the reward economics.",
      monthRes.error ?? lifetimeRes.error ?? breachRes.error,
      "admin.rewards.economics.load",
    );
  }

  const monthRows = (monthRes.data ?? []) as Array<{ cost_usd: number | string; user_id: string }>;

  return c.json({
    enabled,
    budget: normalizeRewardBudget(budgetRaw),
    guardrails: normalizeRewardGuardrails(guardrailsRaw),
    spend: {
      month_start: monthStart,
      month_usd: round2(sumCost(monthRows)),
      month_grants: monthRows.length,
      month_accounts: new Set(monthRows.map((r) => r.user_id)).size,
      lifetime_usd: round2(
        sumCost(lifetimeRes.data as Array<{ cost_usd: number | string }> | null),
      ),
    },
    open_breaches: breachRes.data ?? [],
    roi,
  });
});

/** Validate a budget/guardrails patch. Throws EconomicsInputError with copy. */
function parseEconomics(
  body: Record<string, unknown>,
  budget: RewardBudget,
  guardrails: RewardGuardrails,
): { budget: RewardBudget; guardrails: RewardGuardrails } {
  const nextBudget = { ...budget };
  const nextGuardrails = { ...guardrails };

  const money = (raw: unknown, label: string, max: number): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > max) {
      throw new EconomicsInputError(`${label} must be between 0 and ${max}.`);
    }
    return round2(n);
  };

  if (body.monthly_usd_cap !== undefined) {
    nextBudget.monthlyUsdCap = money(body.monthly_usd_cap, "The platform monthly cap", 1_000_000);
  }
  if (body.per_user_monthly_usd_cap !== undefined) {
    nextBudget.perUserMonthlyUsdCap = money(
      body.per_user_monthly_usd_cap,
      "The per-account monthly cap",
      100_000,
    );
  }
  if (body.per_user_lifetime_usd_cap !== undefined) {
    nextBudget.perUserLifetimeUsdCap = money(
      body.per_user_lifetime_usd_cap,
      "The per-account lifetime cap",
      100_000,
    );
  }
  if (body.margin_floor_pct !== undefined) {
    const n = Number(body.margin_floor_pct);
    if (!Number.isFinite(n) || n < 0 || n > 0.95) {
      throw new EconomicsInputError("The margin floor must be between 0 and 0.95 (0-95%).");
    }
    nextGuardrails.marginFloorPct = Math.round(n * 10_000) / 10_000;
  }
  if (body.free_tier_monthly_usd_cap !== undefined) {
    nextGuardrails.freeTierMonthlyUsdCap = money(
      body.free_tier_monthly_usd_cap,
      "The free-tier monthly allowance",
      1_000,
    );
  }
  if (body.per_user_daily_grant_cap !== undefined) {
    const n = Math.floor(Number(body.per_user_daily_grant_cap));
    if (!Number.isFinite(n) || n < 0 || n > 1_000) {
      throw new EconomicsInputError("The daily grant limit must be between 0 and 1000.");
    }
    nextGuardrails.perUserDailyGrantCap = n;
  }
  if (body.per_user_daily_usd_cap !== undefined) {
    nextGuardrails.perUserDailyUsdCap = money(
      body.per_user_daily_usd_cap,
      "The daily spend limit",
      10_000,
    );
  }
  if (body.auto_kill_on_global_breach !== undefined) {
    if (typeof body.auto_kill_on_global_breach !== "boolean") {
      throw new EconomicsInputError("Auto-pause must be true/false.");
    }
    nextGuardrails.autoKillOnGlobalBreach = body.auto_kill_on_global_breach;
  }
  if (body.fraud_hold_enabled !== undefined) {
    if (typeof body.fraud_hold_enabled !== "boolean") {
      throw new EconomicsInputError("The fraud hold must be true/false.");
    }
    nextGuardrails.fraudHoldEnabled = body.fraud_hold_enabled;
  }

  // Cross-field: a per-user monthly cap above the lifetime one is a cap that can
  // never bite, and one above the platform cap is the same mistake at the other
  // end. Both would read as "configured" while doing nothing.
  if (nextBudget.perUserMonthlyUsdCap > nextBudget.perUserLifetimeUsdCap) {
    throw new EconomicsInputError(
      "The per-account monthly cap can't be higher than the lifetime cap.",
    );
  }
  if (nextBudget.perUserMonthlyUsdCap > nextBudget.monthlyUsdCap) {
    throw new EconomicsInputError(
      "The per-account monthly cap can't be higher than the platform monthly cap.",
    );
  }
  return { budget: nextBudget, guardrails: nextGuardrails };
}

adminRewardsRoutes.patch("/economics", async (c) => {
  const blocked = requireStepUp(c);
  if (blocked) return blocked;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const currentBudget = normalizeRewardBudget(
    await getSetting<unknown>(REWARD_BUDGET_SETTING_KEY, DEFAULT_REWARD_BUDGET),
  );
  const currentGuardrails = normalizeRewardGuardrails(
    await getSetting<unknown>(REWARD_GUARDRAILS_SETTING_KEY, DEFAULT_REWARD_GUARDRAILS),
  );

  let next: { budget: RewardBudget; guardrails: RewardGuardrails };
  try {
    next = parseEconomics(body, currentBudget, currentGuardrails);
  } catch (err) {
    if (err instanceof EconomicsInputError) {
      return c.json({ error: err.message }, 400); // safe-raw-error: typed validation copy
    }
    throw err;
  }

  const budgetValue = {
    monthly_usd_cap: next.budget.monthlyUsdCap,
    per_user_monthly_usd_cap: next.budget.perUserMonthlyUsdCap,
    per_user_lifetime_usd_cap: next.budget.perUserLifetimeUsdCap,
  };
  const adminId = c.get("userId");

  const [budgetRes, guardrailsRes] = await Promise.all([
    supabaseAdmin
      .from("system_settings")
      .update({ value: budgetValue, updated_by: adminId } as never)
      .eq("key", REWARD_BUDGET_SETTING_KEY),
    supabaseAdmin
      .from("system_settings")
      .update({ value: guardrailsToSetting(next.guardrails), updated_by: adminId } as never)
      .eq("key", REWARD_GUARDRAILS_SETTING_KEY),
  ]);
  if (budgetRes.error || guardrailsRes.error) {
    return failSafe(
      c,
      500,
      "Couldn't save the reward economics.",
      budgetRes.error ?? guardrailsRes.error,
      "admin.rewards.economics.save",
    );
  }
  bustSettingCache(REWARD_BUDGET_SETTING_KEY);
  bustSettingCache(REWARD_GUARDRAILS_SETTING_KEY);

  await writeAuditLog(c, {
    action: "rewards.economics.update",
    targetType: "system_setting",
    targetId: REWARD_BUDGET_SETTING_KEY,
    before: { budget: currentBudget, guardrails: currentGuardrails },
    after: { budget: next.budget, guardrails: next.guardrails },
  });
  return c.json({ budget: next.budget, guardrails: next.guardrails });
});

adminRewardsRoutes.post("/economics/kill-switch", async (c) => {
  const blocked = requireStepUp(c);
  if (blocked) return blocked;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "Send enabled: true or false." }, 400); // safe-raw-error: typed copy
  }

  const { error } = await supabaseAdmin
    .from("feature_flags")
    .update({ enabled: body.enabled } as never)
    .eq("key", "rewards_tangible");
  if (error) {
    return failSafe(
      c,
      500,
      "Couldn't change the payout switch.",
      error,
      "admin.rewards.economics.killswitch",
    );
  }
  clearFeatureFlagCache();

  await writeAuditLog(c, {
    action: body.enabled ? "rewards.payouts.resume" : "rewards.payouts.pause",
    targetType: "feature_flag",
    targetId: "rewards_tangible",
    details: { enabled: body.enabled },
  });
  return c.json({ enabled: body.enabled });
});

adminRewardsRoutes.post("/economics/breaches/:id/resolve", async (c) => {
  const id = c.req.param("id");
  const { data, error } = await supabaseAdmin
    .from("reward_budget_breaches")
    .update({ resolved_at: new Date().toISOString(), resolved_by: c.get("userId") } as never)
    .eq("id", id)
    .is("resolved_at", null)
    .select("id, scope")
    .maybeSingle();
  if (error) {
    return failSafe(
      c,
      500,
      "Couldn't resolve the breach.",
      error,
      "admin.rewards.economics.breach.resolve",
    );
  }
  if (!data) return c.json({ error: "That breach is already resolved." }, 409);

  await writeAuditLog(c, {
    action: "rewards.economics.breach.resolve",
    targetType: "reward_budget_breach",
    targetId: id,
    details: { scope: (data as { scope: string }).scope },
  });
  return c.json({ ok: true });
});

adminRewardsRoutes.get("/economics/reconciliation", async (c) => {
  const nowMs = Date.now();
  const days = windowDays(c.req.query("days"));
  const since = sinceIso(days, nowMs);

  const { data: grantRows, error: grantErr } = await supabaseAdmin
    .from("reward_tangible_grants")
    .select("id, user_id, milestone_key, reward_type, reward_value, cost_usd, granted_at, metadata")
    .eq("status", "granted")
    .gte("granted_at", since)
    .order("granted_at", { ascending: false })
    .limit(RECONCILE_GRANT_CAP);
  if (grantErr) {
    return failSafe(
      c,
      500,
      "Couldn't load the grants to reconcile.",
      grantErr,
      "admin.rewards.economics.reconcile",
    );
  }

  const grants: GrantLedgerRow[] = ((grantRows ?? []) as unknown as GrantLedgerRow[]).map((g) => ({
    ...g,
    reward_value: Number(g.reward_value) || 0,
    cost_usd: Number(g.cost_usd) || 0,
  }));

  // The credit half: the grade-credit rows the affected accounts received inside
  // the window. `admin_grant` is the reason the milestone fulfiller writes.
  const userIds = [...new Set(grants.map((g) => g.user_id))];
  let creditRows: CreditLedgerRow[] = [];
  if (userIds.length > 0) {
    const { data } = await supabaseAdmin
      .from("grade_credit_transactions")
      .select("user_id, delta, notes, created_at")
      .in("user_id", userIds)
      .eq("reason", "admin_grant")
      .gte("created_at", since);
    creditRows = (data ?? []) as unknown as CreditLedgerRow[];
  }

  // The Stripe half. NULL (not an empty set) when Stripe is unreachable or the
  // lookup budget is exhausted, so an outage reports no missing coupons rather
  // than reporting every single one as missing.
  const couponIds = [
    ...new Set(
      grants
        .filter((g) => g.reward_type !== "free_grade_credits")
        .map((g) =>
          typeof g.metadata?.stripe_coupon_id === "string" ? g.metadata.stripe_coupon_id : ""
        )
        .filter(Boolean),
    ),
  ];
  const stripe = getStripe();
  let liveCouponIds: Set<string> | null = null;
  let stripeChecked = false;
  if (stripe && couponIds.length > 0 && couponIds.length <= RECONCILE_COUPON_LOOKUP_CAP) {
    const found = new Set<string>();
    let reachable = true;
    for (const couponId of couponIds) {
      try {
        const coupon = await stripe.coupons.retrieve(couponId);
        if (coupon && !(coupon as { deleted?: boolean }).deleted) found.add(couponId);
      } catch (err) {
        // A 404 is a genuine finding (the coupon is gone); anything else is an
        // outage, and one outage invalidates the whole Stripe half.
        const status = (err as { statusCode?: number }).statusCode;
        if (status !== 404) {
          reachable = false;
          break;
        }
      }
    }
    if (reachable) {
      liveCouponIds = found;
      stripeChecked = true;
    }
  }

  const result = reconcileGrants(grants, creditRows, liveCouponIds);
  return c.json({
    window_days: days,
    since,
    truncated: grants.length >= RECONCILE_GRANT_CAP,
    stripe_checked: stripeChecked,
    ...result,
  });
});

adminRewardsRoutes.get("/economics/roi", async (c) => {
  return c.json(await loadRoi(windowDays(c.req.query("days")), Date.now()));
});

// GET /api/admin/rewards/nudges — US-1859 re-engagement lift.
//
// Reports the two arms side by side, per nudge type: what the NUDGED users did,
// and what the deterministic HOLDOUT slice did over the same window. `lift_pp`
// is the difference in percentage points and is deliberately null when either
// arm is empty — a treated conversion rate reported as "lift" is the exact
// mistake the holdout exists to prevent, and a plausible number nobody can check
// is worse than an honest blank.
adminRewardsRoutes.get("/nudges", async (c) => {
  const nowMs = Date.now();
  const days = windowDays(c.req.query("days"));
  const since = sinceIso(days, nowMs);

  const [{ data, error }, configRaw] = await Promise.all([
    supabaseAdmin
      .from("reward_nudge_sends")
      .select("nudge_type, holdout, clicked_at, converted_at, sent_at")
      .gte("sent_at", since)
      .order("sent_at", { ascending: false })
      .limit(NUDGE_ROW_CAP),
    getSetting<unknown>(NUDGE_CONFIG_KEY, null),
  ]);
  if (error) {
    return failSafe(c, 500, "Couldn't load the nudge report.", error, "admin.rewards.nudges.load");
  }

  const rows = (data ?? []) as Array<{
    nudge_type: string;
    holdout: boolean;
    clicked_at: string | null;
    converted_at: string | null;
    sent_at: string;
  }>;

  return c.json({
    window_days: days,
    since,
    // Surfaced rather than silent: a truncated window makes every rate below a
    // sample of the newest sends, which is a different claim from "the window".
    truncated: rows.length >= NUDGE_ROW_CAP,
    config: normalizeNudgeConfig(configRaw),
    by_type: summarizeLift(rows),
    total_sends: rows.length,
  });
});
