// Worth My Time, R1 09/12 (US-3174): serve and update a seller's work plan.
//
//   POST /api/flipdesk/planner/sessions             start a session from a plan
//   GET  /api/flipdesk/planner/sessions/current     the live one, with its tasks
//   POST /api/flipdesk/planner/sessions/:id/:action pause | resume | complete | abandon
//   POST /api/flipdesk/planner/tasks/:id/:action    start | pause | complete | skip
//
// ── WHERE THE PLANNING HAPPENS, AND WHY IT IS NOT HERE ──────────────────────
// The pure pipeline -- candidates, durations, values, ranking, batching,
// scheduling -- lives in src/lib and runs in the SPA. That is not an accident
// and it is worth stating, because "the planner router" sounds like it should
// contain the planner.
//
// Two reasons. First, R1 is responsive FlipDesk web only (US-3166 AC1), and
// the candidate builder is built on src/lib/workflow.ts, whose nextAction the
// item grid already renders -- moving it would either duplicate that ladder or
// put the grid and the plan into disagreement, which US-3168 AC1 forbids.
// Second, the edge runs on Deno with its own import map and the SPA on Vite
// with the @/ alias; neither can import the other's modules, so "reuse" across
// the boundary means a second copy plus a parity test, per module.
//
// So this router owns what only a server can own: the session lifecycle, the
// ownership checks, and the staleness re-read. The plan itself arrives as
// data, and everything in it that MATTERS is verified here rather than
// trusted.
//
// ── A TIMER NEVER SHIPS ANYTHING (AC5) ──────────────────────────────────────
// Completing a task records that the seller says they did it. It does not
// publish, ship, reprice or change a grade, and it never will: those have
// their own routes, their own confirmations and their own failure modes.
// Where the workflow leaves durable proof -- a tracking number, a live listing
// -- that proof is read back and recorded separately from the seller's word.
//
// ── SECURITY (US-268) ───────────────────────────────────────────────────────
// The edge uses the service-role client, which BYPASSES RLS. Every id in a
// path or a body is resolved through an owner-verified parent before anything
// is read or written. A session id is matched against the workspace owner; a
// task id is matched through its session; an inventory item is matched through
// inventory_items.user_id.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe, jsonError } from "../lib/http-errors.ts";
import { refuseWhileImpersonating } from "../lib/destructive-guard.ts";
import {
  canTransitionSession,
  canTransitionTask,
  checkRevision,
  timingRetryKey,
  type SessionState,
  type TaskState,
  type TimingEventKind,
} from "../lib/work-sessions.ts";

export const flipdeskPlannerRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId: string };
}>();

/**
 * How many tasks one plan may carry.
 *
 * A 240-minute session cannot hold 50 tasks at any believable estimate, so a
 * body claiming to is either a bug or someone probing. Refused with a number
 * rather than truncated, because a silently shortened plan is one the seller
 * cannot reconcile with what they saw.
 */
export const MAX_PLAN_TASKS = 40;

export const MIN_BUDGET_MINUTES = 5;
export const MAX_BUDGET_MINUTES = 240;

interface PlanTaskBody {
  inventory_item_id?: unknown;
  item_title?: unknown;
  action_key?: unknown;
  prerequisite_keys?: unknown;
  bin?: unknown;
  estimate_minutes?: unknown;
  estimate_value_cents?: unknown;
  estimate_source?: unknown;
}

export interface ParsedPlanTask {
  inventoryItemId: string | null;
  itemTitle: string | null;
  actionKey: string;
  prerequisiteKeys: string[];
  bin: string | null;
  estimateMinutes: number | null;
  estimateValueCents: number | null;
  estimateSource: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function nonNegativeInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.round(v);
}

/**
 * Validate a plan off a request body. Pure, so the shape rules are testable
 * without a database.
 *
 * NOTHING HERE TRUSTS THE CLIENT'S ARITHMETIC. The estimates are snapshots for
 * the record -- what the plan was built on -- and are never used to decide
 * anything. What IS enforced is the shape, the budget window and the cap, plus
 * every item id being owned, which happens against the database below.
 */
export function parsePlanTasks(
  raw: unknown,
): { ok: true; tasks: ParsedPlanTask[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "tasks must be a list." };
  if (raw.length === 0) return { ok: false, error: "A plan needs at least one task." };
  if (raw.length > MAX_PLAN_TASKS) {
    return {
      ok: false,
      error: `A plan can hold at most ${MAX_PLAN_TASKS} tasks; this one had ${raw.length}.`,
    };
  }
  const tasks: ParsedPlanTask[] = [];
  for (const [i, entry] of (raw as PlanTaskBody[]).entries()) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, error: `Task ${i + 1} isn't an object.` };
    }
    const actionKey = str(entry.action_key);
    if (!actionKey) {
      return { ok: false, error: `Task ${i + 1} has no action.` };
    }
    const prereqs = Array.isArray(entry.prerequisite_keys)
      ? entry.prerequisite_keys.filter((k): k is string => typeof k === "string")
      : [];
    tasks.push({
      inventoryItemId: str(entry.inventory_item_id),
      // A snapshot of the title AS PLANNED. Never refreshed, so the seller's
      // record still names the garment after it is deleted.
      itemTitle: str(entry.item_title),
      actionKey,
      prerequisiteKeys: prereqs,
      bin: str(entry.bin),
      estimateMinutes: nonNegativeInt(entry.estimate_minutes),
      estimateValueCents: nonNegativeInt(entry.estimate_value_cents),
      estimateSource: str(entry.estimate_source),
    });
  }
  return { ok: true, tasks };
}

interface SessionRow {
  id: string;
  user_id: string;
  state: string;
  work_context: string;
  available_tools: string[] | null;
  budget_minutes: number;
  revision: number;
  started_at: string | null;
  ended_at: string | null;
}

interface TaskRow {
  id: string;
  session_id: string;
  user_id: string;
  inventory_item_id: string | null;
  item_title_snapshot: string | null;
  position: number;
  state: string;
  action_key: string;
  prerequisite_keys: string[] | null;
  bin_snapshot: string | null;
  estimate_minutes: number | null;
  estimate_value_cents: number | null;
  estimate_source: string | null;
  observed_minutes: number | null;
  confirmed_minutes: number | null;
  correction_minutes: number | null;
}

const SESSION_COLUMNS =
  "id, user_id, state, work_context, available_tools, budget_minutes, revision, started_at, ended_at";
const TASK_COLUMNS =
  "id, session_id, user_id, inventory_item_id, item_title_snapshot, position, state, action_key, prerequisite_keys, bin_snapshot, estimate_minutes, estimate_value_cents, estimate_source, observed_minutes, confirmed_minutes, correction_minutes";

/** A session the caller actually owns, or null. Never fetched by id alone. */
async function loadOwnedSession(
  ownerId: string,
  sessionId: string,
): Promise<SessionRow | null> {
  const { data } = await supabaseAdmin
    .from("flipdesk_work_sessions")
    .select(SESSION_COLUMNS)
    .eq("id", sessionId)
    .eq("user_id", ownerId) // US-268
    .maybeSingle();
  return (data as SessionRow | null) ?? null;
}

/**
 * A task the caller owns, WITH its session.
 *
 * Both predicates are applied. user_id alone would be enough today because the
 * column is denormalized, but a task is only meaningful inside its session and
 * a check that reads one without the other is a check somebody will later
 * relax.
 */
async function loadOwnedTask(
  ownerId: string,
  taskId: string,
): Promise<{ task: TaskRow; session: SessionRow } | null> {
  const { data } = await supabaseAdmin
    .from("flipdesk_work_session_tasks")
    .select(TASK_COLUMNS)
    .eq("id", taskId)
    .eq("user_id", ownerId) // US-268
    .maybeSingle();
  const task = (data as TaskRow | null) ?? null;
  if (!task) return null;
  const session = await loadOwnedSession(ownerId, task.session_id);
  if (!session) return null;
  return { task, session };
}

/**
 * The item facts a task depends on, re-read at the moment it matters (AC4).
 *
 * THE CASE THIS EXISTS FOR: a seller plans an evening, then sells a jacket on
 * their phone, then presses Start on measuring it. Nothing about the stored
 * plan knows. This reads the item back and says whether the work is still
 * real, and the answer is checked on START and on COMPLETE -- not only on
 * start, because a session can sit paused for an hour in between.
 */
async function itemStillWorkable(
  ownerId: string,
  itemId: string | null,
): Promise<{ workable: boolean; reason: string | null }> {
  // A task with no item is workable: the tombstone case is handled by the
  // caller, which knows whether the id was ever set.
  if (!itemId) return { workable: true, reason: null };
  const { data, error } = await supabaseAdmin
    .from("inventory_items")
    .select("id, status, user_id")
    .eq("id", itemId)
    .eq("user_id", ownerId) // US-268: and it proves the owner has not changed
    .maybeSingle();
  if (error) {
    // Fail CLOSED on a read failure. Letting the task through would record
    // work against an item nobody could confirm exists.
    return { workable: false, reason: "We couldn't check this item just now." };
  }
  const row = data as { status: string | null } | null;
  if (!row) {
    return { workable: false, reason: "This item is gone, or is no longer yours." };
  }
  const status = String(row.status ?? "");
  if (["sold", "shipped", "completed", "archived"].includes(status)) {
    return { workable: false, reason: `This item is already ${status}.` };
  }
  return { workable: true, reason: null };
}

/** Bump the session's revision as part of every write that changes it. */
async function bumpRevision(session: SessionRow): Promise<number> {
  const next = session.revision + 1;
  await supabaseAdmin
    .from("flipdesk_work_sessions")
    .update({ revision: next })
    .eq("id", session.id)
    .eq("user_id", session.user_id) // US-268 belt and braces
    .eq("revision", session.revision);
  return next;
}

function sessionBody(session: SessionRow, tasks: TaskRow[]) {
  return {
    session: {
      id: session.id,
      state: session.state,
      work_context: session.work_context,
      available_tools: session.available_tools ?? [],
      budget_minutes: session.budget_minutes,
      revision: session.revision,
      started_at: session.started_at,
      ended_at: session.ended_at,
    },
    tasks: tasks
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((t) => ({
        id: t.id,
        position: t.position,
        state: t.state,
        action_key: t.action_key,
        inventory_item_id: t.inventory_item_id,
        item_title: t.item_title_snapshot,
        prerequisite_keys: t.prerequisite_keys ?? [],
        bin: t.bin_snapshot,
        estimate_minutes: t.estimate_minutes,
        estimate_value_cents: t.estimate_value_cents,
        estimate_source: t.estimate_source,
        observed_minutes: t.observed_minutes,
        confirmed_minutes: t.confirmed_minutes,
        correction_minutes: t.correction_minutes,
        // A task whose item was deleted keeps its history and stops being
        // work. The null id is what says so (US-3167 AC4).
        actionable: t.inventory_item_id !== null &&
          !["completed", "skipped", "invalidated"].includes(t.state),
      })),
  };
}

async function loadTasks(sessionId: string, ownerId: string): Promise<TaskRow[]> {
  const { data } = await supabaseAdmin
    .from("flipdesk_work_session_tasks")
    .select(TASK_COLUMNS)
    .eq("session_id", sessionId)
    .eq("user_id", ownerId) // US-268
    .order("position", { ascending: true })
    .limit(MAX_PLAN_TASKS);
  return (data as TaskRow[] | null) ?? [];
}

// ── POST /sessions ────────────────────────────────────────────────

/**
 * The states a session is still the seller's to come back to.
 *
 * ONE LIST, READ BY BOTH the create guard and GET /sessions/current, because
 * US-3177 found what happens when they disagree. The guard checked `active`
 * alone while `current` read all three: a seller could pause, build a new
 * plan, and have their paused evening silently drop off the screen while
 * staying open in the database. Two sessions, one of them invisible, and no
 * error anywhere.
 */
const OPEN_SESSION_STATES = ["planned", "active", "paused"] as const;

flipdeskPlannerRoutes.post("/sessions", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }

  const budget = nonNegativeInt(body.budget_minutes);
  if (budget === null || budget < MIN_BUDGET_MINUTES || budget > MAX_BUDGET_MINUTES) {
    return jsonError(
      c,
      400,
      `budget_minutes must be between ${MIN_BUDGET_MINUTES} and ${MAX_BUDGET_MINUTES}.`,
    );
  }
  const workContext = str(body.work_context);
  if (workContext !== "home" && workContext !== "phone_only") {
    return jsonError(c, 400, "work_context must be home or phone_only.");
  }
  const tools = Array.isArray(body.available_tools)
    ? body.available_tools.filter((t): t is string => typeof t === "string")
    : [];

  const parsed = parsePlanTasks(body.tasks);
  if (!parsed.ok) return jsonError(c, 400, parsed.error);

  // EVERY ITEM ID IS OWNER-VERIFIED BEFORE ANYTHING IS WRITTEN (AC3), in ONE
  // bounded query rather than a loop (AC2). A foreign id does not 403 the
  // whole plan -- it is nulled, so the task lands as a tombstone and the plan
  // a seller built is not thrown away over one stale row.
  const itemIds = [...new Set(parsed.tasks.map((t) => t.inventoryItemId).filter(
    (id): id is string => id !== null,
  ))];
  const ownedIds = new Set<string>();
  if (itemIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("inventory_items")
      .select("id")
      .eq("user_id", ownerId) // US-268
      .in("id", itemIds)
      .limit(MAX_PLAN_TASKS);
    if (error) {
      return failSafe(c, 500, "Couldn't check your items.", error, "planner.items");
    }
    for (const row of (data as { id: string }[] | null) ?? []) ownedIds.add(row.id);
  }

  // ONE OPEN SESSION PER WORKSPACE. 00819's partial unique index is what
  // enforces it under two concurrent requests; this read only produces a
  // better message than a constraint violation.
  //
  // 00818's index covered `active` alone, which left `planned` and `paused`
  // unguarded -- and a session is CREATED planned, so the rule did not bind
  // until the seller started a task.
  const { data: existing } = await supabaseAdmin
    .from("flipdesk_work_sessions")
    .select("id, state")
    .eq("user_id", ownerId) // US-268
    .in("state", OPEN_SESSION_STATES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) {
    const open = existing as { id: string; state: string };
    return c.json({
      error: open.state === "paused"
        ? "You have a paused session waiting. Pick it up or finish it first."
        : "You already have a session running. Finish or abandon it first.",
      code: "session_already_active",
      session_id: open.id,
    }, 409);
  }

  const { data: created, error: insertErr } = await supabaseAdmin
    .from("flipdesk_work_sessions")
    .insert({
      user_id: ownerId, // US-268: from the context, never from the body
      state: "planned",
      work_context: workContext,
      available_tools: tools,
      budget_minutes: budget,
    })
    .select(SESSION_COLUMNS)
    .single();
  if (insertErr || !created) {
    return failSafe(
      c,
      500,
      "Couldn't start that session.",
      insertErr,
      "planner.session.insert",
    );
  }
  const session = created as SessionRow;

  // AN UNOWNED ID DROPS ITS WHOLE TASK, rather than keeping the task with a
  // null item (US-3177).
  //
  // Nulling the id alone left a row in the seller's session carrying a title
  // THE CALLER CHOSE, pointing at nothing, and `actionable: false`. Nothing
  // of the other tenant's row leaked -- the title is the caller's own string
  // and the id never survived -- but the null is not free: it is how a
  // DELETED item is recorded (the FK is ON DELETE SET NULL, and isActionable
  // reads the null that way), so this manufactured a "your item was deleted"
  // row for an item that was never theirs. Two very different facts sharing
  // one representation is how a screen ends up explaining the wrong thing.
  //
  // A task with no item id at all is still allowed through: the planner can
  // legitimately schedule work that is not about one garment.
  const keptTasks = parsed.tasks.filter(
    (t) => t.inventoryItemId === null || ownedIds.has(t.inventoryItemId),
  );
  if (keptTasks.length === 0) {
    await supabaseAdmin
      .from("flipdesk_work_sessions")
      .update({ state: "abandoned", ended_at: new Date().toISOString() })
      .eq("id", session.id)
      .eq("user_id", ownerId); // US-268
    return c.json({
      error: "None of those items are yours to work on.",
      code: "no_owned_tasks",
      dropped_item_ids: itemIds.filter((id) => !ownedIds.has(id)),
    }, 400);
  }

  const rows = keptTasks.map((t, i) => ({
    session_id: session.id,
    user_id: ownerId, // US-268
    inventory_item_id: t.inventoryItemId,
    item_title_snapshot: t.itemTitle,
    position: i + 1,
    state: "pending",
    action_key: t.actionKey,
    prerequisite_keys: t.prerequisiteKeys,
    bin_snapshot: t.bin,
    estimate_minutes: t.estimateMinutes,
    estimate_value_cents: t.estimateValueCents,
    estimate_source: t.estimateSource,
    estimate_taken_at: new Date().toISOString(),
  }));
  const { error: taskErr } = await supabaseAdmin
    .from("flipdesk_work_session_tasks")
    .insert(rows);
  if (taskErr) {
    // The session exists with no tasks, which is useless. Abandon it rather
    // than leaving a shell the seller has to clear by hand.
    await supabaseAdmin
      .from("flipdesk_work_sessions")
      .update({ state: "abandoned", ended_at: new Date().toISOString() })
      .eq("id", session.id)
      .eq("user_id", ownerId);
    return failSafe(c, 500, "Couldn't save that plan.", taskErr, "planner.tasks.insert");
  }

  const tasks = await loadTasks(session.id, ownerId);
  return c.json({
    ...sessionBody(session, tasks),
    // AC2: say so when a task's item did not survive the ownership check,
    // rather than letting the seller wonder why a row is greyed out.
    dropped_item_ids: itemIds.filter((id) => !ownedIds.has(id)),
  }, 201);
});

// ── GET /sessions/current ─────────────────────────────────────────

// ── Overrides and suppressions (R2 05/06, US-3182) ────────────────

const OVERRIDE_KINDS = ["task_minutes", "value_range", "remaining_cost"] as const;
const SUPPRESSION_KINDS = ["skip_session", "snooze", "dismiss"] as const;

/** Bounded like every other list read here. */
const MAX_OVERRIDE_ROWS = 500;

const OVERRIDE_COLUMNS =
  "id, inventory_item_id, action_key, kind, amount_minutes, amount_cents, low_cents, high_cents, original_json, source, updated_at";
const SUPPRESSION_COLUMNS =
  "id, inventory_item_id, action_key, kind, session_id, until, created_at";

/**
 * The item is the seller's, or nothing happens.
 *
 * ⚠ THE ONE CHECK THIS WHOLE FEATURE TURNS ON (US-268). Every override and
 * every suppression names an inventory item id that came out of a request
 * body. Without this, a caller could suppress another tenant's shipping
 * obligation -- a row that makes somebody else miss a deadline -- or write a
 * planner number against a garment they have never seen.
 */
async function ownsItem(ownerId: string, itemId: string): Promise<boolean> {
  if (!itemId) return false;
  const { data } = await supabaseAdmin
    .from("inventory_items")
    .select("id")
    .eq("id", itemId)
    .eq("user_id", ownerId) // US-268
    .maybeSingle();
  return data !== null;
}

/** Everything the seller has corrected or set aside. */
flipdeskPlannerRoutes.get("/overrides", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const [ovr, sup] = await Promise.all([
    supabaseAdmin
      .from("flipdesk_work_overrides")
      .select(OVERRIDE_COLUMNS)
      .eq("owner_user_id", ownerId) // US-268
      .limit(MAX_OVERRIDE_ROWS),
    supabaseAdmin
      .from("flipdesk_work_suppressions")
      .select(SUPPRESSION_COLUMNS)
      .eq("owner_user_id", ownerId) // US-268
      .limit(MAX_OVERRIDE_ROWS),
  ]);
  if (ovr.error || sup.error) {
    return failSafe(
      c, 500, "Couldn't read your corrections.",
      ovr.error ?? sup.error, "planner.overrides.read",
    );
  }
  return c.json({
    overrides: ovr.data ?? [],
    suppressions: sup.data ?? [],
    // Server time, so the client's snooze arithmetic is not done against a
    // clock the seller could be a day wrong about.
    now: new Date().toISOString(),
  });
});

/**
 * Record a correction.
 *
 * ⚠ IT WRITES TO flipdesk_work_overrides AND TO NOTHING ELSE. A seller saying
 * "this is worth $40 for planning" must never touch
 * inventory_items.target_price, a grade report or anything the books read
 * (AC1). Those have their own screens and their own consequences.
 */
flipdeskPlannerRoutes.put("/overrides", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(c, 400, "That correction wasn't readable.");
  }

  const itemId = str(body.inventory_item_id);
  const kind = str(body.kind);
  if (!itemId) return jsonError(c, 400, "A correction needs an item.");
  if (!kind || !(OVERRIDE_KINDS as readonly string[]).includes(kind)) {
    return jsonError(c, 400, `Unknown correction: ${String(body.kind)}.`);
  }
  if (!(await ownsItem(ownerId, itemId))) {
    // 404 rather than 403: a caller probing another tenant's ids learns
    // nothing from "not found" that they did not already know.
    return jsonError(c, 404, "Item not found.");
  }

  const minutes = nonNegativeInt(body.amount_minutes);
  const cents = nonNegativeInt(body.amount_cents);
  const low = nonNegativeInt(body.low_cents);
  const high = nonNegativeInt(body.high_cents);

  // The SHAPE is checked here and again by 00820's CHECK constraint. Two
  // layers guarding one rule is fine; this one produces a sentence a seller
  // can read, and the constraint is what holds under a caller that is not
  // this route.
  if (kind === "task_minutes" && (minutes === null || minutes <= 0)) {
    return jsonError(c, 400, "Tell us how many minutes, as a whole number above zero.");
  }
  if (kind === "remaining_cost" && cents === null) {
    return jsonError(c, 400, "Tell us the cost in cents, or zero if there is none.");
  }
  if (kind === "value_range" && (low === null || high === null || low > high)) {
    return jsonError(c, 400, "A range needs a low and a high, with the low first.");
  }

  const row = {
    inventory_item_id: itemId,
    action_key: str(body.action_key),
    kind,
    amount_minutes: kind === "task_minutes" ? minutes : null,
    amount_cents: kind === "remaining_cost" ? cents : null,
    low_cents: kind === "value_range" ? low : null,
    high_cents: kind === "value_range" ? high : null,
    // WHAT IT REPLACED (AC2). Without it "reset to our estimate" has nothing
    // to reset to, and a seller who corrected a number in March has no way
    // back. Stored as the client saw it, because that is what they overrode.
    original_json: body.original ?? null,
    source: "seller",
  };

  const { data, error } = await supabaseAdmin
    .from("flipdesk_work_overrides")
    // US-268: the owner is written AT THE CALL, from the request context and
    // never from the body. Inline rather than folded into `row` so the
    // predicate is where a reader -- and the source guard in
    // flipdesk-planner_test.ts -- looks for it.
    .upsert({ owner_user_id: ownerId, ...row }, {
      onConflict: "owner_user_id,inventory_item_id,action_key,kind",
    })
    .select(OVERRIDE_COLUMNS)
    .maybeSingle();
  if (error) {
    return failSafe(c, 500, "Couldn't save that correction.", error, "planner.overrides.write");
  }
  return c.json({ override: data });
});

/** Reset to our estimate (AC1). Deletes the correction, keeps nothing behind. */
flipdeskPlannerRoutes.post("/overrides/reset", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(c, 400, "That reset wasn't readable.");
  }
  const itemId = str(body.inventory_item_id);
  const kind = str(body.kind);
  if (!itemId || !kind) return jsonError(c, 400, "A reset needs an item and a kind.");
  if (!(await ownsItem(ownerId, itemId))) return jsonError(c, 404, "Item not found.");

  // US-1552: no .or() on a mutation. The self-hosted PostgREST rejects
  // logical operators on an UPDATE or DELETE with a 42703 that names the
  // update-CTE alias, while the newer local stack accepts them -- so CI
  // cannot catch it. Sequential equality predicates instead.
  const action = str(body.action_key);
  let q = supabaseAdmin
    .from("flipdesk_work_overrides")
    .delete()
    .eq("owner_user_id", ownerId) // US-268
    .eq("inventory_item_id", itemId)
    .eq("kind", kind);
  q = action === null ? q.is("action_key", null) : q.eq("action_key", action);
  const { error } = await q;
  if (error) {
    return failSafe(c, 500, "Couldn't reset that.", error, "planner.overrides.reset");
  }
  return c.json({ ok: true });
});

/** Set a task aside: skip this session, snooze it, or dismiss it (AC3). */
flipdeskPlannerRoutes.post("/suppressions", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(c, 400, "That wasn't readable.");
  }
  const itemId = str(body.inventory_item_id);
  const kind = str(body.kind);
  if (!itemId) return jsonError(c, 400, "This needs an item.");
  if (!kind || !(SUPPRESSION_KINDS as readonly string[]).includes(kind)) {
    return jsonError(c, 400, `Unknown action: ${String(body.kind)}.`);
  }
  if (!(await ownsItem(ownerId, itemId))) return jsonError(c, 404, "Item not found.");

  let sessionId: string | null = null;
  if (kind === "skip_session") {
    sessionId = str(body.session_id);
    if (!sessionId) return jsonError(c, 400, "A skip needs the session it applies to.");
    // The session must be the seller's too. A skip against somebody else's
    // session id would be a row nobody could explain.
    const owned = await loadOwnedSession(ownerId, sessionId);
    if (!owned) return jsonError(c, 404, "Session not found.");
  }

  // THE SNOOZE CLOCK IS THE SERVER'S. A client-supplied `until` is a client
  // choosing how long it is snoozed for, which is a nine-year snooze away
  // from being a dismissal nobody asked for.
  const until = kind === "snooze"
    ? new Date(Date.now() + 7 * 86_400_000).toISOString()
    : null;

  const { data, error } = await supabaseAdmin
    .from("flipdesk_work_suppressions")
    .upsert({
      owner_user_id: ownerId, // US-268
      inventory_item_id: itemId,
      action_key: str(body.action_key),
      kind,
      session_id: sessionId,
      until,
    }, { onConflict: "owner_user_id,inventory_item_id,action_key,kind,session_id" })
    .select(SUPPRESSION_COLUMNS)
    .maybeSingle();
  if (error) {
    return failSafe(c, 500, "Couldn't save that.", error, "planner.suppressions.write");
  }
  return c.json({ suppression: data });
});

/** Undo a skip, snooze or dismissal. */
flipdeskPlannerRoutes.post("/suppressions/reset", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(c, 400, "That wasn't readable.");
  }
  const itemId = str(body.inventory_item_id);
  if (!itemId) return jsonError(c, 400, "This needs an item.");
  if (!(await ownsItem(ownerId, itemId))) return jsonError(c, 404, "Item not found.");

  // US-1552 again: equality predicates only, never .or() on a delete.
  const kind = str(body.kind);
  let q = supabaseAdmin
    .from("flipdesk_work_suppressions")
    .delete()
    .eq("owner_user_id", ownerId) // US-268
    .eq("inventory_item_id", itemId);
  if (kind !== null) q = q.eq("kind", kind);
  const { error } = await q;
  if (error) {
    return failSafe(c, 500, "Couldn't undo that.", error, "planner.suppressions.reset");
  }
  return c.json({ ok: true });
});

// ── GET /outcomes ─────────────────────────────────────────────────

/** Bounded like every other list read here (US-3179 AC5). */
const MAX_OUTCOME_ITEMS = 300;

// Declared as constants the way TASK_COLUMNS above is. A select built by
// concatenation inside the call loses PostgREST's row typing entirely and the
// cast then has to go through `unknown`, which is a cast that checks nothing.
const OUTCOME_TASK_COLUMNS =
  "id, session_id, inventory_item_id, item_title_snapshot, action_key, state, estimate_value_cents, estimate_source, estimate_taken_at, confirmed_minutes, correction_minutes";
const OUTCOME_SALE_COLUMNS =
  "id, inventory_item_id, listing_id, status, cancelled_at, sold_at, sale_date, sale_price, shipping_collected, platform_fees, payment_processing_fees, shipping_cost, grading_cost, other_costs, tax";

/**
 * What the planner estimated, and what the books recorded (US-3179).
 *
 * THREE READS AND NO ARITHMETIC. The comparison itself is
 * src/lib/work-outcomes.ts, which reuses saleNetCents -- the same term-for-term
 * pnl_net the finances dashboard uses. Computing a net here would be the
 * second financial ledger AC1 forbids, and it would drift from the books
 * within a quarter with nothing to say which number is the real one.
 *
 * What the SERVER owns is the owner predicate, on every one of the three.
 */
flipdeskPlannerRoutes.get("/outcomes", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  // Only tasks that carry an estimate snapshot: a task with none was never a
  // prediction and there is nothing to score it against.
  const { data: taskData, error: taskErr } = await supabaseAdmin
    .from("flipdesk_work_session_tasks")
    .select(OUTCOME_TASK_COLUMNS)
    .eq("user_id", ownerId) // US-268
    .not("estimate_value_cents", "is", null)
    .order("estimate_taken_at", { ascending: false })
    .limit(MAX_OUTCOME_ITEMS);
  if (taskErr) {
    return failSafe(c, 500, "Couldn't read your planning history.", taskErr, "planner.outcomes");
  }
  const tasks = (taskData ?? []) as {
    id: string;
    session_id: string;
    inventory_item_id: string | null;
    item_title_snapshot: string | null;
    action_key: string;
    state: string;
    estimate_value_cents: number | null;
    estimate_source: string | null;
    estimate_taken_at: string | null;
    confirmed_minutes: number | null;
    correction_minutes: number | null;
  }[];

  // The session states the tasks belong to, so the pure layer can exclude an
  // abandoned plan without a second round trip.
  const sessionIds = [...new Set(tasks.map((t) => t.session_id))];
  const sessionState = new Map<string, string>();
  if (sessionIds.length > 0) {
    const { data: sessionData } = await supabaseAdmin
      .from("flipdesk_work_sessions")
      .select("id, state")
      .eq("user_id", ownerId) // US-268
      .in("id", sessionIds);
    for (const row of (sessionData ?? []) as { id: string; state: string }[]) {
      sessionState.set(row.id, row.state);
    }
  }

  const itemIds = [...new Set(
    tasks.map((t) => t.inventory_item_id).filter((id): id is string => id !== null),
  )];
  if (itemIds.length === 0) {
    return c.json({ tasks: [], sales: [], items: [], now: new Date().toISOString() });
  }

  const [itemRes, saleRes] = await Promise.all([
    supabaseAdmin
      .from("inventory_items")
      .select("id, created_at, acquired_price")
      .eq("user_id", ownerId) // US-268
      .in("id", itemIds),
    supabaseAdmin
      .from("sales")
      .select(OUTCOME_SALE_COLUMNS)
      .eq("user_id", ownerId) // US-268
      .in("inventory_item_id", itemIds),
  ]);
  if (itemRes.error || saleRes.error) {
    return failSafe(
      c,
      500,
      "Couldn't read your sales.",
      itemRes.error ?? saleRes.error,
      "planner.outcomes",
    );
  }
  const items = (itemRes.data ?? []) as {
    id: string;
    created_at: string | null;
    acquired_price: number | string | null;
  }[];
  const sales = (saleRes.data ?? []) as Record<string, unknown>[];
  const basisById = new Map(items.map((i) => [i.id, i.acquired_price]));

  // The marketplace comes off the LISTING, because a sale row does not carry
  // one. Absent is absent: it is reported as null rather than guessed at from
  // an order reference.
  const listingIds = [...new Set(
    sales.map((s) => s.listing_id).filter((id): id is string => typeof id === "string"),
  )];
  const platformByListing = new Map<string, string | null>();
  if (listingIds.length > 0) {
    const { data: listingData } = await supabaseAdmin
      .from("listings")
      .select("id, platform")
      .eq("user_id", ownerId) // US-268
      .in("id", listingIds);
    for (const row of (listingData ?? []) as { id: string; platform: string | null }[]) {
      platformByListing.set(row.id, row.platform);
    }
  }

  return c.json({
    tasks: tasks.map((t) => ({
      task_id: t.id,
      session_id: t.session_id,
      inventory_item_id: t.inventory_item_id,
      item_title_snapshot: t.item_title_snapshot,
      action_key: t.action_key,
      task_state: t.state,
      session_state: sessionState.get(t.session_id) ?? "unknown",
      estimate_value_cents: t.estimate_value_cents,
      estimate_source: t.estimate_source,
      estimate_taken_at: t.estimate_taken_at,
      confirmed_minutes: t.confirmed_minutes,
      correction_minutes: t.correction_minutes,
    })),
    sales: sales.map((s) => ({
      sale_id: s.id,
      inventory_item_id: s.inventory_item_id,
      status: s.status,
      cancelled_at: s.cancelled_at,
      sold_at: s.sold_at ?? s.sale_date ?? null,
      marketplace: typeof s.listing_id === "string"
        ? platformByListing.get(s.listing_id) ?? null
        : null,
      acquired_price: typeof s.inventory_item_id === "string"
        ? basisById.get(s.inventory_item_id) ?? null
        : null,
      money: {
        sale_price: s.sale_price,
        shipping_collected: s.shipping_collected,
        platform_fees: s.platform_fees,
        payment_processing_fees: s.payment_processing_fees,
        shipping_cost: s.shipping_cost,
        grading_cost: s.grading_cost,
        other_costs: s.other_costs,
        tax: s.tax,
      },
    })),
    items: items.map((i) => ({ inventory_item_id: i.id, created_at: i.created_at })),
    // SERVER TIME, so the horizon call is not made against a client clock a
    // seller could be wrong about by a day.
    now: new Date().toISOString(),
  });
});

// ── GET /observations ─────────────────────────────────────────────

/**
 * How far back the learning read looks.
 *
 * Bounded like every other list read here. The window that matters is 20
 * samples per pool (US-3178), and eight pools times twenty is 160 -- so 400
 * rows covers a seller who works every pool, while a seller with one busy
 * family is covered many times over. A seller past this simply learns from
 * their most recent work, which is what the window wants anyway.
 */
const MAX_OBSERVATION_ROWS = 400;

/**
 * The seller's own completed work, for R2's duration learning (US-3178).
 *
 * RAW ROWS, NOT A COMPUTED ANSWER, and that is deliberate. The learning maths
 * lives in src/lib/work-duration-learning.ts beside the rest of the pipeline,
 * because the estimator it feeds is the one the item grid and the planner both
 * use, and the two runtimes cannot import each other. Computing the median
 * here would mean a second copy of the rules in Deno, which is the drift this
 * repo keeps paying for. What the SERVER owns is the thing only a server can:
 * the owner predicate. No other seller's history can reach the caller because
 * no other seller's row leaves this query.
 */
flipdeskPlannerRoutes.get("/observations", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  // Only COMPLETED sessions. An abandoned one is excluded in the pure layer
  // too, and it is filtered here as well so the wire carries less rather than
  // relying on the client to throw it away.
  const { data: sessions, error: sessionErr } = await supabaseAdmin
    .from("flipdesk_work_sessions")
    .select("id, work_context, state, ended_at")
    .eq("user_id", ownerId) // US-268
    .eq("state", "completed")
    .order("ended_at", { ascending: false })
    .limit(MAX_OBSERVATION_ROWS);
  if (sessionErr) {
    return failSafe(c, 500, "Couldn't read your work history.", sessionErr, "planner.observations");
  }
  const rows = (sessions ?? []) as {
    id: string;
    work_context: string;
    state: string;
    ended_at: string | null;
  }[];
  if (rows.length === 0) return c.json({ observations: [], truncated: false });

  const byId = new Map(rows.map((r) => [r.id, r]));
  const { data: tasks, error: taskErr } = await supabaseAdmin
    .from("flipdesk_work_session_tasks")
    .select(
      "id, session_id, position, state, action_key, confirmed_minutes, correction_minutes",
    )
    .eq("user_id", ownerId) // US-268
    .in("session_id", [...byId.keys()])
    .eq("state", "completed")
    .limit(MAX_OBSERVATION_ROWS);
  if (taskErr) {
    return failSafe(c, 500, "Couldn't read your work history.", taskErr, "planner.observations");
  }
  const taskRows = (tasks ?? []) as {
    id: string;
    session_id: string;
    position: number;
    state: string;
    action_key: string;
    confirmed_minutes: number | null;
    correction_minutes: number | null;
  }[];

  return c.json({
    observations: taskRows.map((t) => {
      const session = byId.get(t.session_id)!;
      return {
        task_id: t.id,
        session_id: t.session_id,
        position: t.position,
        action_key: t.action_key,
        task_state: t.state,
        session_state: session.state,
        work_context: session.work_context,
        confirmed_minutes: t.confirmed_minutes,
        correction_minutes: t.correction_minutes,
        ended_at: session.ended_at,
      };
    }),
    // Said rather than hidden, the same way the plan read reports a capped
    // catalog: a learner that quietly saw only part of the history would be
    // wrong with nothing to point at.
    truncated: taskRows.length >= MAX_OBSERVATION_ROWS,
  });
});

flipdeskPlannerRoutes.get("/sessions/current", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("flipdesk_work_sessions")
    .select(SESSION_COLUMNS)
    .eq("user_id", ownerId) // US-268
    // THE SAME LIST the create guard uses. See OPEN_SESSION_STATES.
    .in("state", OPEN_SESSION_STATES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    return failSafe(c, 500, "Couldn't read your session.", error, "planner.current");
  }
  const session = (data as SessionRow | null) ?? null;
  if (!session) return c.json({ session: null, tasks: [] });
  const tasks = await loadTasks(session.id, ownerId);
  return c.json(sessionBody(session, tasks));
});

// ── POST /sessions/:id/:action ────────────────────────────────────

const SESSION_ACTIONS: Record<string, SessionState> = {
  start: "active",
  pause: "paused",
  resume: "active",
  complete: "completed",
  abandon: "abandoned",
};

flipdeskPlannerRoutes.post("/sessions/:id/:action", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const sessionId = c.req.param("id");
  const action = c.req.param("action");
  const target = SESSION_ACTIONS[action];
  if (!target) return jsonError(c, 404, `Unknown session action: ${action}.`);

  // US-2351: an admin acting as a customer may not abandon their work. The
  // other four are recoverable; abandoning is not.
  if (action === "abandon") {
    const refusal = await refuseWhileImpersonating(c, "abandon a work session");
    if (refusal) return refusal;
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    // A lifecycle action with no body is fine; only the revision is optional
    // and its absence is caught below.
  }

  const session = await loadOwnedSession(ownerId, sessionId);
  if (!session) return jsonError(c, 404, "Session not found.");

  const rev = checkRevision(body.revision, session.revision);
  if (!rev.ok) {
    // AC4: return enough state for the UI to recover WITHOUT replaying the
    // action. A client that had to re-POST to find out what happened would
    // double-apply whichever action did land.
    const tasks = await loadTasks(session.id, ownerId);
    return c.json({
      error: rev.refusal.message,
      code: rev.refusal.code,
      ...sessionBody(session, tasks),
    }, 409);
  }

  const move = canTransitionSession(session.state, target);
  if (!move.ok) {
    // OUR sentence, not a database one: every TransitionRefusal.message is
    // built in canTransitionSession / canTransitionTask from our own state
    // names ("A session can't go from planned to paused."), and nothing
    // from PostgREST or Postgres reaches this line.
    return c.json({ error: move.refusal.message, code: move.refusal.code }, 409); // safe-raw-error: our own transition copy, never a DB message
  }

  const patch: Record<string, unknown> = { state: target, revision: session.revision + 1 };
  if (target === "active" && !session.started_at) {
    patch.started_at = new Date().toISOString();
  }
  if (target === "completed" || target === "abandoned") {
    patch.ended_at = new Date().toISOString();
    // A session that ends releases its active task rather than leaving one
    // running forever. `pending` and not `skipped`: the seller did not choose
    // to skip it, they stopped working.
    await supabaseAdmin
      .from("flipdesk_work_session_tasks")
      .update({ state: "pending" })
      .eq("session_id", session.id)
      .eq("user_id", ownerId) // US-268
      .eq("state", "active");
  }

  const { error } = await supabaseAdmin
    .from("flipdesk_work_sessions")
    .update(patch)
    .eq("id", session.id)
    .eq("user_id", ownerId) // US-268
    // THE REVISION IS IN THE PREDICATE, not only in the check above. A check
    // followed by an unguarded write is two tabs both passing and the second
    // one winning silently.
    .eq("revision", session.revision);
  if (error) {
    return failSafe(c, 500, "Couldn't update that session.", error, "planner.session");
  }

  const fresh = await loadOwnedSession(ownerId, sessionId);
  const tasks = await loadTasks(sessionId, ownerId);
  return c.json(sessionBody(fresh ?? session, tasks));
});

// ── POST /tasks/:id/:action ───────────────────────────────────────

const TASK_ACTIONS: Record<string, { state: TaskState; event: TimingEventKind | null }> = {
  start: { state: "active", event: "task_started" },
  pause: { state: "pending", event: "task_paused" },
  complete: { state: "completed", event: "task_completed" },
  skip: { state: "skipped", event: null },
};

flipdeskPlannerRoutes.post("/tasks/:id/:action", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const taskId = c.req.param("id");
  const action = c.req.param("action");
  const spec = TASK_ACTIONS[action];
  if (!spec) return jsonError(c, 404, `Unknown task action: ${action}.`);

  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    // Same as the session actions: an absent body is caught by the revision
    // check below rather than here.
  }

  const owned = await loadOwnedTask(ownerId, taskId);
  if (!owned) return jsonError(c, 404, "Task not found.");
  const { task, session } = owned;

  const rev = checkRevision(body.revision, session.revision);
  if (!rev.ok) {
    const tasks = await loadTasks(session.id, ownerId);
    return c.json({
      error: rev.refusal.message,
      code: rev.refusal.code,
      ...sessionBody(session, tasks),
    }, 409);
  }

  const move = canTransitionTask(task.state, spec.state);
  if (!move.ok) {
    // OUR sentence, not a database one: every TransitionRefusal.message is
    // built in canTransitionSession / canTransitionTask from our own state
    // names ("A session can't go from planned to paused."), and nothing
    // from PostgREST or Postgres reaches this line.
    return c.json({ error: move.refusal.message, code: move.refusal.code }, 409); // safe-raw-error: our own transition copy, never a DB message
  }

  // AC4: re-read the item on START and on COMPLETE. Not only on start -- a
  // session can sit paused for an hour in between, and the jacket can sell on
  // a phone while it does.
  if (action === "start" || action === "complete") {
    if (task.inventory_item_id === null && task.item_title_snapshot !== null) {
      // The item was deleted after planning. The row stays as history and
      // stops being work (US-3167 AC4).
      await invalidate(task, ownerId);
      const tasks = await loadTasks(session.id, ownerId);
      return c.json({
        error: "That item has been deleted, so this task has been closed.",
        code: "task_invalidated",
        ...sessionBody(session, tasks),
      }, 409);
    }
    const check = await itemStillWorkable(ownerId, task.inventory_item_id);
    if (!check.workable) {
      await invalidate(task, ownerId);
      const tasks = await loadTasks(session.id, ownerId);
      return c.json({
        error: check.reason,
        code: "task_invalidated",
        ...sessionBody(session, tasks),
      }, 409);
    }
  }

  const patch: Record<string, unknown> = { state: spec.state };
  if (action === "complete") {
    // AC5: this records that the SELLER says they did it. It publishes
    // nothing, ships nothing, reprices nothing and changes no grade. Those
    // have their own routes, their own confirmations and their own failures.
    const confirmed = nonNegativeInt(body.confirmed_minutes);
    if (confirmed !== null) patch.confirmed_minutes = confirmed;
  }

  const { error } = await supabaseAdmin
    .from("flipdesk_work_session_tasks")
    .update(patch)
    .eq("id", task.id)
    .eq("user_id", ownerId) // US-268
    .eq("state", task.state); // and the state we read, so a race loses
  if (error) {
    return failSafe(c, 500, "Couldn't update that task.", error, "planner.task");
  }

  // US-3177: STARTING A TASK STARTS THE SESSION. A session is created
  // `planned` and only `planned -> active` is legal, so without this a seller
  // who began working still had a planned session and every pause was refused
  // with "a session can't go from planned to paused" -- a refusal about an
  // internal state they never saw and could do nothing about. The server owns
  // the invariant because the server is what knows a task started; making the
  // client send a second POST would be asking it to maintain a state machine
  // it does not own. Found by the end-to-end run, not by any unit test: every
  // route test set the session up in the state it wanted.
  if (action === "start" && session.state === "planned") {
    await supabaseAdmin
      .from("flipdesk_work_sessions")
      .update({ state: "active", started_at: session.started_at ?? new Date().toISOString() })
      .eq("id", session.id)
      .eq("user_id", ownerId) // US-268
      .eq("state", "planned"); // and only from planned, so a race loses
  }

  if (spec.event) {
    // The retry key makes a repeated request a no-op rather than double-
    // counted time (US-3167 AC3). The attempt number comes from the client's
    // count of how many times this task has entered this state; absent, it is
    // 1, so a retry of a first start still collides.
    const attempt = nonNegativeInt(body.attempt) ?? 1;
    await supabaseAdmin
      .from("flipdesk_work_timing_events")
      .upsert({
        task_id: task.id,
        user_id: ownerId, // US-268
        kind: spec.event,
        retry_key: timingRetryKey(task.id, spec.event, Math.max(1, attempt)),
      }, { onConflict: "task_id,retry_key", ignoreDuplicates: true });
  }

  await bumpRevision(session);
  // RE-READ rather than patching the row we loaded. The start above can have
  // moved the session from planned to active, and a spread of the stale row
  // would answer `planned` to a client that just started work -- which is how
  // the UI ended up offering a Pause the server then refused.
  const fresh = await loadOwnedSession(ownerId, session.id);
  const tasks = await loadTasks(session.id, ownerId);
  return c.json(sessionBody(fresh ?? session, tasks));
});

async function invalidate(task: TaskRow, ownerId: string): Promise<void> {
  await supabaseAdmin
    .from("flipdesk_work_session_tasks")
    .update({ state: "invalidated" })
    .eq("id", task.id)
    .eq("user_id", ownerId) // US-268
    .eq("state", task.state);
}
