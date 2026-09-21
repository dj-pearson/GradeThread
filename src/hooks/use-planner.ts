// Worth My Time, R1 10/12 (US-3175): the planner's server state.
//
// Three things live here: the seller's preferences (R1 01/12), the pure
// pipeline that turns their stock into a plan (R1 03/12 through 08/12), and
// the session lifecycle on the edge (R1 09/12).
//
// ── THE PLANNING RUNS IN THE BROWSER, THE SESSION LIVES ON THE SERVER ───────
// Deliberate, and explained at length in routes/flipdesk-planner.ts. The short
// version: the candidate builder is built on the same nextAction the item grid
// renders, so it has to be where that is, and the two runtimes cannot import
// each other. What the server owns is what only a server can own -- ownership,
// staleness and the session's state.
//
// ── A FAILED REQUEST MUST NOT ERASE A SAVED PLAN (AC5) ──────────────────────
// Every mutation here leaves the cached session alone on failure. TanStack
// Query's default is already this, and the reason it is written down is that
// an optimistic update would break it: a seller whose connection dropped
// mid-session would come back to an empty screen and assume their evening's
// work was gone.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getFreshAccessToken } from "@/lib/auth-token";
import { edgeApiUrl } from "@/lib/edge-api";
import { useAuthStore } from "@/stores/auth-store";
import { supabase } from "@/lib/supabase";
import { ITEM_LIST_SELECT, type ItemListRow } from "@/lib/item-list-columns";
import { candidatesFor, type WorkCandidate } from "@/lib/work-candidates";
import { estimateDuration, isUnestimated } from "@/lib/work-duration";
import { estimateWorkValue, type ValueResult } from "@/lib/work-value";
import { rankWork, remainingActionsFrom, type RankedTask } from "@/lib/work-ranker";
import { batchWork } from "@/lib/work-batching";
import { schedulePlan, type WorkPlan } from "@/lib/work-scheduler";

async function plannerHeaders(): Promise<Record<string, string>> {
  // getFreshAccessToken refreshes a near-expiry token before it is sent, so a
  // call made just past the one-hour boundary does not 401 into a spurious
  // "session expired" -- these fetch sites have no 401-retry backstop.
  const token = await getFreshAccessToken();
  if (!token) throw new Error("You must be signed in.");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const { activeWorkspaceOwnerId, user } = useAuthStore.getState();
  const ownerId = activeWorkspaceOwnerId ?? user?.id;
  if (ownerId) headers["X-Workspace-Owner"] = ownerId;
  return headers;
}

async function edgeJson<T>(
  path: string,
  init?: RequestInit & { body?: string },
): Promise<T> {
  const res = await fetch(`${edgeApiUrl()}${path}`, {
    ...init,
    headers: await plannerHeaders(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: PlannerError = new Error(
      json.error || json.detail || "That didn't work. Try again.",
    );
    err.status = res.status;
    err.code = json.code;
    // US-3176 AC4: a 409 from the planner carries the session as the SERVER
    // sees it, precisely so the client can recover without re-POSTing to find
    // out what happened. Replaying the action to learn the outcome is how one
    // of the two attempts gets applied twice.
    if (json && typeof json === "object" && "session" in json) {
      err.payload = json as PlannerSession;
    }
    throw err;
  }
  return json as T;
}

export interface PlannerError extends Error {
  status?: number;
  code?: string;
  /** The server's view of the session, when it sent one with the refusal. */
  payload?: PlannerSession;
}

/**
 * Take the server at its word after a refusal.
 *
 * Every conflict path writes the returned session straight into the cache, so
 * a seller who hit Done in two tabs sees the truth immediately rather than the
 * stale revision that was refused. It is NOT an error handler that hides the
 * error: the mutation still rejects and the caller still says what happened.
 */
function adoptConflictState(
  qc: ReturnType<typeof useQueryClient>,
  err: PlannerError,
): void {
  if (err.payload) qc.setQueryData(["planner_session"], err.payload);
}

// ── Preferences (R1 01/12) ──────────────────────────────────────────

export interface WorkPreferences {
  defaultSessionMinutes: number;
  workContext: "home" | "phone_only";
  availableTools: string[];
  hourlyTargetAmount: number | null;
  hourlyTargetSet: boolean;
  sessionMinutePresets: number[];
  minSessionMinutes: number;
  maxSessionMinutes: number;
  workTools: string[];
}

function toPreferences(json: Record<string, unknown>): WorkPreferences {
  return {
    defaultSessionMinutes: typeof json.default_session_minutes === "number"
      ? json.default_session_minutes
      : 30,
    workContext: json.work_context === "phone_only" ? "phone_only" : "home",
    availableTools: Array.isArray(json.available_tools)
      ? (json.available_tools as string[])
      : ["camera"],
    hourlyTargetAmount: typeof json.hourly_target_amount === "number"
      ? json.hourly_target_amount
      : null,
    // NOT a falsy check on the amount. A seller may deliberately set 0, and
    // reading that as "not set" would quietly discard their answer.
    hourlyTargetSet: json.hourly_target_set === true,
    sessionMinutePresets: Array.isArray(json.session_minute_presets)
      ? (json.session_minute_presets as number[])
      : [15, 30, 60],
    minSessionMinutes: typeof json.min_session_minutes === "number"
      ? json.min_session_minutes
      : 5,
    maxSessionMinutes: typeof json.max_session_minutes === "number"
      ? json.max_session_minutes
      : 240,
    workTools: Array.isArray(json.work_tools) ? (json.work_tools as string[]) : [],
  };
}

export function useWorkPreferences() {
  return useQuery({
    queryKey: ["work_preferences"],
    staleTime: 5 * 60 * 1000,
    queryFn: async () =>
      toPreferences(
        await edgeJson<Record<string, unknown>>("/api/flipdesk/work-preferences"),
      ),
  });
}

export function useSaveWorkPreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Record<string, unknown>) =>
      toPreferences(
        await edgeJson<Record<string, unknown>>("/api/flipdesk/work-preferences", {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
      ),
    onSuccess: (next) => qc.setQueryData(["work_preferences"], next),
  });
}

// ── The plan (R1 03/12 .. 08/12, in the browser) ────────────────────

/**
 * How many items are read to build a plan.
 *
 * Bounded on purpose (AC5 names candidate limits). A seller with 4,000 items
 * cannot fit more than a couple of hundred into 240 minutes, and the scheduler
 * caps again at 200 after ranking. The number is reported so a short plan can
 * be told from a truncated read.
 */
export const PLAN_ITEM_LIMIT = 400;

export interface PreparedPlan {
  plan: WorkPlan;
  ranked: RankedTask[];
  candidates: WorkCandidate[];
  groups: ReturnType<typeof batchWork>["groups"];
  pullList: ReturnType<typeof batchWork>["pullList"];
  /**
   * The window this plan was built for. Carried so a session records what the
   * seller agreed to, not what the plan happened to fill -- a 60-minute
   * session that only found 29 minutes of work is still a 60-minute session,
   * and reading the budget off plannedMinutes would lose that every time.
   */
  budgetMinutes: number;
  itemsRead: number;
  truncated: boolean;
}

export interface BuildPlanArgs {
  budgetMinutes: number;
  workContext: "home" | "phone_only";
  availableTools: string[];
  hourlyTargetCents: number | null;
  now?: string;
}

/**
 * Read the seller's stock and run the pipeline over it.
 *
 * ONE READ, EXPLICITLY PROJECTED. ITEM_LIST_SELECT is the same projection the
 * item grid uses and it deliberately excludes descriptions, comp blobs and
 * photos -- pulling those for four hundred items to build a thirty-minute plan
 * would be several megabytes to decide what to do first.
 */
export async function buildPlan(args: BuildPlanArgs): Promise<PreparedPlan> {
  const { activeWorkspaceOwnerId, user } = useAuthStore.getState();
  const ownerId = activeWorkspaceOwnerId ?? user?.id;
  const { data, error } = await supabase
    .from("items_full")
    .select(ITEM_LIST_SELECT)
    .eq("user_id", ownerId ?? "")
    .order("updated_at", { ascending: false })
    .limit(PLAN_ITEM_LIMIT);
  if (error) throw new Error(error.message);
  const items = (data ?? []) as unknown as ItemListRow[];

  const candidates = candidatesFor(items, {
    workContext: args.workContext,
    availableTools: args.availableTools as never,
  });

  const byId = new Map(items.map((i) => [i.id, i]));
  const ranked = rankWork({
    now: args.now ?? new Date().toISOString(),
    budgetMinutes: args.budgetMinutes,
    workContext: args.workContext,
    availableTools: args.availableTools as never,
    hourlyTargetCents: args.hourlyTargetCents,
    tasks: candidates.map((c) => {
      const item = byId.get(c.itemId);
      const value: ValueResult = estimateWorkValue({
        marketplace: item?.listing_platform ?? null,
        evidence: item?.target_price != null
          ? {
            amountCents: Math.round(item.target_price * 100),
            source: "seller_estimate",
            observedAt: item.updated_at ?? null,
          }
          : null,
        purchaseCents: item?.purchase_price != null
          ? Math.round(item.purchase_price * 100)
          : null,
      });
      return {
        candidate: c,
        value,
        remainingActions: remainingActionsFrom(c),
        unfinishedSince: item?.created_at ?? null,
      };
    }),
  });

  const batched = batchWork({
    ranked,
    binOf: Object.fromEntries(
      candidates.map((c) => [c.itemId, c.bin.value]),
    ),
  });

  const plan = schedulePlan({
    now: args.now ?? new Date().toISOString(),
    budgetMinutes: args.budgetMinutes,
    ranked: batched.ordered,
  });

  return {
    plan,
    ranked: batched.ordered,
    candidates,
    groups: batched.groups,
    pullList: batched.pullList,
    budgetMinutes: args.budgetMinutes,
    itemsRead: items.length,
    truncated: items.length >= PLAN_ITEM_LIMIT,
  };
}

export function useBuildPlan() {
  return useMutation<PreparedPlan, Error, BuildPlanArgs>({
    mutationFn: buildPlan,
  });
}

// ── The session (R1 09/12, on the edge) ─────────────────────────────

export interface PlannerSessionTask {
  id: string;
  position: number;
  state: string;
  action_key: string;
  inventory_item_id: string | null;
  item_title: string | null;
  bin: string | null;
  estimate_minutes: number | null;
  estimate_value_cents: number | null;
  // The three timings are separate fields on purpose and are never collapsed:
  // observed is the clock, confirmed is what the seller said, correction is a
  // later edit. lib/work-sessions.ts owns the precedence.
  observed_minutes?: number | null;
  confirmed_minutes?: number | null;
  correction_minutes?: number | null;
  actionable: boolean;
}

export interface PlannerSession {
  session: {
    id: string;
    state: string;
    budget_minutes: number;
    revision: number;
    started_at?: string | null;
    ended_at?: string | null;
  } | null;
  tasks: PlannerSessionTask[];
}

export function useCurrentSession(enabled = true) {
  return useQuery<PlannerSession>({
    queryKey: ["planner_session"],
    enabled,
    staleTime: 30 * 1000,
    queryFn: () => edgeJson<PlannerSession>("/api/flipdesk/planner/sessions/current"),
  });
}

export function useStartSession() {
  const qc = useQueryClient();
  return useMutation<PlannerSession, Error, Record<string, unknown>>({
    mutationFn: (body) =>
      edgeJson<PlannerSession>("/api/flipdesk/planner/sessions", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (next) => qc.setQueryData(["planner_session"], next),
    // No onError handler on purpose (AC5): a failure leaves the cached session
    // exactly as it was. Clearing it would show a seller whose connection
    // dropped an empty screen and let them assume the evening was lost.
  });
}

export function useSessionAction() {
  const qc = useQueryClient();
  return useMutation<
    PlannerSession,
    PlannerError,
    { sessionId: string; action: string; revision: number }
  >({
    mutationFn: ({ sessionId, action, revision }) =>
      edgeJson<PlannerSession>(
        `/api/flipdesk/planner/sessions/${encodeURIComponent(sessionId)}/${action}`,
        { method: "POST", body: JSON.stringify({ revision }) },
      ),
    onSuccess: (next) => qc.setQueryData(["planner_session"], next),
    onError: (err) => adoptConflictState(qc, err),
  });
}

export function useTaskAction() {
  const qc = useQueryClient();
  return useMutation<
    PlannerSession,
    PlannerError,
    {
      taskId: string;
      action: string;
      revision: number;
      confirmedMinutes?: number;
      /**
       * How many times this task has entered this state, NOT how many times
       * the request has been retried. The server derives its dedup key from
       * it, so a retry of the same intent must carry the SAME number or it
       * lands as a second timing event (lib/work-sessions.ts timingRetryKey).
       */
      attempt?: number;
    }
  >({
    mutationFn: ({ taskId, action, revision, confirmedMinutes, attempt }) =>
      edgeJson<PlannerSession>(
        `/api/flipdesk/planner/tasks/${encodeURIComponent(taskId)}/${action}`,
        {
          method: "POST",
          body: JSON.stringify({
            revision,
            ...(confirmedMinutes != null ? { confirmed_minutes: confirmedMinutes } : {}),
            ...(attempt != null ? { attempt } : {}),
          }),
        },
      ),
    onSuccess: (next) => qc.setQueryData(["planner_session"], next),
    onError: (err) => adoptConflictState(qc, err),
  });
}

/**
 * Turn a built plan into the body POST /sessions expects (US-3176 AC1).
 *
 * The estimates travel as SNAPSHOTS of what the plan was built on, and the
 * server says plainly that it does not trust the client's arithmetic -- it
 * re-checks ownership and keeps these only for the record. Sending them anyway
 * is what makes a session still readable after the item's price changes: the
 * row says what the seller was told when they agreed to the work.
 */
export function planToSessionTasks(plan: PreparedPlan): Record<string, unknown>[] {
  const ranked = new Map(plan.ranked.map((r) => [r.key, r]));
  const candidates = new Map(plan.candidates.map((c) => [c.itemId, c]));
  return plan.plan.tasks.map((t) => {
    const r = ranked.get(t.key);
    const c = r ? candidates.get(r.itemId) : undefined;
    const d = r ? estimateDuration({ action: r.action as never }) : null;
    return {
      inventory_item_id: r?.itemId ?? null,
      item_title: c?.itemTitle ?? null,
      action_key: r?.action ?? null,
      prerequisite_keys: r?.prerequisiteKeys ?? [],
      bin: c?.bin?.value ?? null,
      estimate_minutes: d && !isUnestimated(d) ? d.typical : null,
      estimate_value_cents: r?.conservativeCents ?? null,
      estimate_source: r?.tier ?? null,
    };
  });
}

/** Minutes a task is estimated at, for the row. Null when nobody knows. */
export function taskMinutes(action: string): number | null {
  const d = estimateDuration({ action: action as never });
  return isUnestimated(d) ? null : d.typical;
}
