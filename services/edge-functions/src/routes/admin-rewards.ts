// US-1852: quest/challenge administration.
//
//   GET    /api/admin/rewards/quests      list every definition (enabled or not)
//   POST   /api/admin/rewards/quests      create
//   PATCH  /api/admin/rewards/quests/:id  edit — including the `enabled` switch
//   DELETE /api/admin/rewards/quests/:id  delete a quest nobody has finished
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
import { QUEST_METRICS, isQuestMetric } from "../lib/rewards-quests.ts";
import { QUEST_XP_MAX } from "../lib/rewards-engine.ts";

type AdminRewardsEnv = { Variables: { userId: string } };

export const adminRewardsRoutes = new Hono<AdminRewardsEnv>();

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
    if (err instanceof QuestInputError) return c.json({ error: err.message }, 400);
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
    if (err instanceof QuestInputError) return c.json({ error: err.message }, 400);
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
