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
import { QUEST_METRICS, isQuestMetric } from "../lib/rewards-quests.ts";
import { QUEST_XP_MAX } from "../lib/rewards-engine.ts";
import { BADGE_CATALOG } from "../lib/rewards-badges.ts";
import { SEASON_GOALS } from "../lib/rewards-seasons.ts";

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

  // ── Cross-field rules (mirrors the CHECKs in 00540) ───────────────────────
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
const TRIGGER_TYPES = ["xp_threshold", "badge", "season_goal"] as const;
const BADGE_KEYS = BADGE_CATALOG.map((b) => b.key);
const SEASON_GOAL_KEYS = SEASON_GOALS.map((g) => g.key);

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

  // ── Cross-field rules (mirrors the CHECKs in 00541, plus the catalog ones) ──
  if (out.trigger_type === "xp_threshold") {
    if (out.xp_threshold === null) {
      throw new MilestoneInputError("An XP milestone needs an XP threshold.");
    }
    out.trigger_key = null;
  } else {
    const known = out.trigger_type === "badge" ? BADGE_KEYS : SEASON_GOAL_KEYS;
    if (!out.trigger_key || !known.includes(out.trigger_key)) {
      throw new MilestoneInputError(
        `${out.trigger_type === "badge" ? "Badge" : "Season goal"} must be one of: ${
          known.join(", ")
        }.`,
      );
    }
    out.xp_threshold = null;
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
