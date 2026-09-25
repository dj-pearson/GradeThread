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

import { useCallback } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { getFreshAccessToken } from "@/lib/auth-token";
import { edgeApiUrl } from "@/lib/edge-api";
import { useAuthStore } from "@/stores/auth-store";
import { supabase } from "@/lib/supabase";
import { ITEM_LIST_SELECT, type ItemListRow } from "@/lib/item-list-columns";
import {
  candidatesFor,
  candidatesWithGates,
  EXCLUDED_STATUSES,
  type GatedWork,
  type SaleFacts,
  type WorkCandidate,
} from "@/lib/work-candidates";
import { estimateDuration, isUnestimated } from "@/lib/work-duration";
import {
  learnDurations,
  learnedFor,
  type LearningResult,
  type RawObservation,
  type WorkContext,
} from "@/lib/work-duration-learning";
import {
  estimateWorkValue,
  type PriceEvidence,
  type ValueInput,
  type ValueResult,
} from "@/lib/work-value";
import { adviseOnItem, type AdviceResult } from "@/lib/work-advice";
import {
  isOwedParcel,
  rankWork,
  URGENT_WINDOW_HOURS,
  type RankedTask,
} from "@/lib/work-ranker";
import {
  compareOutcomes,
  type Outcome,
  type PlannedTask,
} from "@/lib/work-outcomes";
import {
  costOverrideFor,
  emptyBook,
  minutesOverrideFor,
  suppressionVerdictFor,
  valueOverrideFor,
  type OverrideBook,
  type OverrideKind,
  type StoredOverride,
  type StoredSuppression,
  type SuppressionKind,
} from "@/lib/work-overrides";
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


// ── Corrections and set-asides (R2 05/06, US-3182) ──────────────────

interface OverrideRow {
  id: string;
  inventory_item_id: string;
  action_key: string | null;
  kind: string;
  amount_minutes: number | null;
  amount_cents: number | null;
  low_cents: number | null;
  high_cents: number | null;
  original_json: unknown;
  source: string;
  updated_at: string;
}

interface SuppressionRow {
  id: string;
  inventory_item_id: string;
  action_key: string | null;
  kind: string;
  session_id: string | null;
  until: string | null;
  created_at: string;
}

const OVERRIDE_KIND_SET = new Set(["task_minutes", "value_range", "remaining_cost"]);
const SUPPRESSION_KIND_SET = new Set(["skip_session", "snooze", "dismiss"]);

/**
 * The server's rows, in the shape work-overrides.ts reads.
 *
 * A ROW WITH A KIND WE DO NOT KNOW IS DROPPED rather than carried through as
 * a string. An unknown suppression kind that reached isSuppressed would fall
 * through every branch and silently not suppress, which is the direction that
 * shows a seller a task they dismissed.
 */
export function toOverrideBook(json: {
  overrides?: OverrideRow[];
  suppressions?: SuppressionRow[];
  now?: string;
}): OverrideBook {
  const overrides: StoredOverride[] = [];
  for (const r of json.overrides ?? []) {
    if (!OVERRIDE_KIND_SET.has(r.kind)) continue;
    overrides.push({
      inventoryItemId: r.inventory_item_id,
      actionKey: r.action_key,
      kind: r.kind as OverrideKind,
      value: {
        amount: r.amount_minutes ?? r.amount_cents ?? null,
        lowCents: r.low_cents,
        highCents: r.high_cents,
      },
      originalValue: (r.original_json ?? null) as StoredOverride["originalValue"],
      source: "seller",
      updatedAt: r.updated_at,
    });
  }
  const suppressions: StoredSuppression[] = [];
  for (const r of json.suppressions ?? []) {
    if (!SUPPRESSION_KIND_SET.has(r.kind)) continue;
    suppressions.push({
      inventoryItemId: r.inventory_item_id,
      actionKey: r.action_key,
      kind: r.kind as SuppressionKind,
      sessionId: r.session_id,
      until: r.until,
      createdAt: r.created_at,
    });
  }
  return {
    overrides,
    suppressions,
    // The server's clock, not the laptop's: a snooze that expired according
    // to a machine a day out expired for nobody else.
    now: typeof json.now === "string" ? json.now : new Date().toISOString(),
  };
}

async function fetchOverrides(): Promise<OverrideBook> {
  return toOverrideBook(await edgeJson("/api/flipdesk/planner/overrides"));
}

export function useWorkOverrides(enabled = true) {
  return useQuery<OverrideBook>({
    queryKey: ["planner_overrides"],
    enabled,
    staleTime: 60 * 1000,
    queryFn: fetchOverrides,
  });
}

export interface SaveOverrideArgs {
  inventoryItemId: string;
  actionKey?: string | null;
  kind: OverrideKind;
  amountMinutes?: number;
  amountCents?: number;
  lowCents?: number;
  highCents?: number;
  /** What the planner said before this. Kept so reset has something to say. */
  original?: unknown;
}

export function useSaveOverride() {
  const qc = useQueryClient();
  return useMutation<unknown, PlannerError, SaveOverrideArgs>({
    mutationFn: (a) =>
      edgeJson("/api/flipdesk/planner/overrides", {
        method: "PUT",
        body: JSON.stringify({
          inventory_item_id: a.inventoryItemId,
          action_key: a.actionKey ?? null,
          kind: a.kind,
          // != null, NEVER a truthiness check. A seller's recorded zero cost
          // is a real answer and `a.amountCents ? ... : {}` would drop it.
          ...(a.amountMinutes != null ? { amount_minutes: a.amountMinutes } : {}),
          ...(a.amountCents != null ? { amount_cents: a.amountCents } : {}),
          ...(a.lowCents != null ? { low_cents: a.lowCents } : {}),
          ...(a.highCents != null ? { high_cents: a.highCents } : {}),
          ...(a.original !== undefined ? { original: a.original } : {}),
        }),
      }),
    // Refetch rather than patch the cache: the server owns updated_at and the
    // original it kept, and a hand-patched row would drift from both.
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["planner_overrides"] }),
  });
}

export function useResetOverride() {
  const qc = useQueryClient();
  return useMutation<
    unknown,
    PlannerError,
    { inventoryItemId: string; actionKey?: string | null; kind: OverrideKind }
  >({
    mutationFn: (a) =>
      edgeJson("/api/flipdesk/planner/overrides/reset", {
        method: "POST",
        body: JSON.stringify({
          inventory_item_id: a.inventoryItemId,
          action_key: a.actionKey ?? null,
          kind: a.kind,
        }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["planner_overrides"] }),
  });
}

export function useSuppress() {
  const qc = useQueryClient();
  return useMutation<
    unknown,
    PlannerError,
    {
      inventoryItemId: string;
      actionKey?: string | null;
      kind: SuppressionKind;
      sessionId?: string | null;
    }
  >({
    mutationFn: (a) =>
      edgeJson("/api/flipdesk/planner/suppressions", {
        method: "POST",
        body: JSON.stringify({
          inventory_item_id: a.inventoryItemId,
          action_key: a.actionKey ?? null,
          kind: a.kind,
          ...(a.sessionId ? { session_id: a.sessionId } : {}),
          // ⚠ NO EXPIRY IS SENT, deliberately. The snooze clock is the
          // server's; a client choosing its own length is a nine-year snooze
          // away from a dismissal nobody asked for, and no screen would show
          // the difference. use-planner-overrides.test.ts holds this line.
        }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["planner_overrides"] }),
  });
}

export function useResetSuppression() {
  const qc = useQueryClient();
  return useMutation<
    unknown,
    PlannerError,
    {
      inventoryItemId: string;
      kind?: SuppressionKind;
      /**
       * WMT-02: which set-aside to undo. Null is a real value (the item-wide
       * row, or no session) and is sent as null; undefined is left out.
       * Without these the server deleted every set-aside on the item.
       */
      actionKey?: string | null;
      sessionId?: string | null;
    }
  >({
    mutationFn: (a) =>
      edgeJson("/api/flipdesk/planner/suppressions/reset", {
        method: "POST",
        body: JSON.stringify({
          inventory_item_id: a.inventoryItemId,
          ...(a.kind ? { kind: a.kind } : {}),
          ...(a.actionKey !== undefined ? { action_key: a.actionKey } : {}),
          ...(a.sessionId !== undefined ? { session_id: a.sessionId } : {}),
        }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["planner_overrides"] }),
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
  /**
   * When this plan was built (US-3181 AC5).
   *
   * The explanation panel renders from THIS snapshot, so it has to be able to
   * say what the numbers are from. Without it a plan reopened the next day
   * would explain a world that had moved on -- the price changed, the photos
   * landed, the garment sold -- under yesterday's ranking.
   */
  takenAt: string;
  /** What the seller set aside, so the page can say so rather than just omit. */
  suppressed: PlanSuppressionNote[];
  /** The corrections this plan was built with (US-3182). */
  book: OverrideBook;
  /**
   * Work held back only by the seller's setup (WMT-06), so the page can say
   * "9 jobs need a tape measure" instead of showing a short plan with no
   * reason.
   */
  gated: GatedWork[];
  /** Sold parcels due within a day, soonest first (WMT-13). */
  shipToday: ShipTodayEntry[];
}

/** One parcel for the "Ship today" strip (WMT-13). */
export interface ShipTodayEntry {
  key: string;
  itemId: string;
  itemTitle: string | null;
  /** The deadline, ISO. */
  at: string;
  /** Whether the marketplace named it or it was worked out from handling days. */
  confidence: WorkCandidate["shipBy"]["confidence"];
}

export interface BuildPlanArgs {
  budgetMinutes: number;
  workContext: "home" | "phone_only";
  availableTools: string[];
  hourlyTargetCents: number | null;
  now?: string;
  /**
   * The seller's corrections and set-asides (US-3182).
   *
   * Passed in rather than read here so buildPlan stays a function of its
   * arguments: the same stock and the same book plan the same way, which is
   * what makes "regenerate and see the difference" a thing a seller can
   * trust.
   */
  book?: OverrideBook;
  /** The seller's own finished-job history (US-3178). */
  learned?: LearningResult | null;
  /** The open session, so a skip applies to this sitting and no other. */
  sessionId?: string | null;
}

/**
 * What a correction did to the plan, for the row that carries it.
 *
 * Reported rather than applied quietly (AC2). A plan that quietly shrinks is
 * a plan a seller thinks is broken.
 */
export interface PlanSuppressionNote {
  itemId: string;
  /** So the set-aside list can name the garment (WMT-12). */
  itemTitle: string | null;
  actionKey: string;
  reason: "skip_session" | "snooze" | "dismiss";
}

/**
 * Read the seller's stock and run the pipeline over it.
 *
 * ONE READ, EXPLICITLY PROJECTED. ITEM_LIST_SELECT is the same projection the
 * item grid uses and it deliberately excludes descriptions, comp blobs and
 * photos -- pulling those for four hundred items to build a thirty-minute plan
 * would be several megabytes to decide what to do first.
 */
export async function buildPlan(
  args: BuildPlanArgs,
  qc?: QueryClient,
): Promise<PreparedPlan> {
  const { activeWorkspaceOwnerId, user } = useAuthStore.getState();
  const ownerId = activeWorkspaceOwnerId ?? user?.id ?? null;
  // WMT-07: no owner is a signed-out seller, not an empty stock. `?? ""` used
  // to run the read against no one and show "no unfinished work".
  if (!ownerId) throw new Error("You must be signed in.");

  // WMT-07: every input read at once. The page used to wait for the
  // overrides refetch before the item read even started.
  const [itemsRead, freshBook, freshLearned, salesRead] = await Promise.all([
    supabase
      .from("items_full")
      .select(ITEM_LIST_SELECT)
      .eq("user_id", ownerId)
      // Only rows that can be work. Without this, listed and archived stock
      // filled the 400-row window before any sourced item was read.
      .not("status", "in", `(${[...EXCLUDED_STATUSES].join(",")})`)
      // Oldest first, so unfinished work that has waited longest is read
      // before this week's.
      .order("updated_at", { ascending: true })
      .limit(PLAN_ITEM_LIMIT),
    // A corrections read that FAILS rejects the build. Falling back to an
    // empty book would bring back every job the seller dismissed.
    args.book !== undefined || !qc
      ? Promise.resolve(args.book)
      : qc.fetchQuery({
        queryKey: ["planner_overrides"],
        queryFn: fetchOverrides,
        staleTime: 0,
      }),
    // Learned pace is an improvement, not a safety net: without it every
    // estimate is the labelled default, so a failed read degrades rather
    // than refuses.
    args.learned !== undefined || !qc
      ? Promise.resolve(args.learned ?? null)
      : qc.ensureQueryData({
        queryKey: ["planner_learned_durations"],
        queryFn: fetchLearned,
        staleTime: LEARNED_STALE_MS,
      }).catch(() => null),
    // WMT-13: the ship-by facts live on the SALE row (00768), not the item,
    // so without this every parcel's deadline read as unknown. RLS-scoped
    // with the anon client, and owner-filtered as well.
    supabase
      .from("sales")
      .select("inventory_item_id,ship_by,handling_days,sold_at")
      .eq("user_id", ownerId)
      .is("shipped_at", null),
  ]);
  const { data, error } = itemsRead;
  if (error) throw new Error(error.message);
  const items = (data ?? []) as unknown as ItemListRow[];

  const now = args.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const book = freshBook ?? emptyBook(now);
  const learnedResult = freshLearned ?? null;

  // A failed sales read degrades to unknown deadlines rather than refusing
  // the plan: every unshipped sale still goes first (isOwedParcel), it just
  // cannot say by when.
  const saleFacts: SaleFacts = {};
  for (const row of (salesRead.error ? [] : salesRead.data ?? []) as {
    inventory_item_id: string | null;
    ship_by: string | null;
    handling_days: number | null;
    sold_at: string | null;
  }[]) {
    if (!row.inventory_item_id) continue;
    saleFacts[row.inventory_item_id] = {
      shipByDate: row.ship_by,
      handlingDays: row.handling_days,
      soldAt: row.sold_at,
    };
  }

  const { candidates: allCandidates, gated } = candidatesWithGates(items, {
    workContext: args.workContext,
    availableTools: args.availableTools as never,
    saleFacts,
  });

  // ── what the seller set aside (AC3) ───────────────────────────────
  // ⚠ isOwedParcel is the RANKER'S own test, imported rather than
  // rewritten. Two implementations of "urgent" would eventually disagree
  // about one parcel on one evening, and that is the evening it matters.
  const suppressed: PlanSuppressionNote[] = [];
  const candidates = allCandidates.filter((c) => {
    const verdict = suppressionVerdictFor(book, {
      itemId: c.itemId,
      actionKey: c.action,
      sessionId: args.sessionId ?? null,
      // WMT-13: a set-aside never hides a parcel somebody paid for, however
      // far off (or unknown) its deadline.
      urgentShipping: isOwedParcel(c),
    });
    if (!verdict.suppressed) return true;
    suppressed.push({
      itemId: c.itemId,
      itemTitle: c.itemTitle ?? null,
      actionKey: c.action,
      reason: verdict.reason,
    });
    return false;
  });

  const byId = new Map(items.map((i) => [i.id, i]));
  const ranked = rankWork({
    now,
    budgetMinutes: args.budgetMinutes,
    workContext: args.workContext,
    availableTools: args.availableTools as never,
    hourlyTargetCents: args.hourlyTargetCents,
    // Override, then learned, then default -- estimateDuration already
    // implements that order, so the precedence lives in ONE place (AC4).
    durationFor: ({ action, itemId }) =>
      estimateDuration({
        action,
        overrideTypicalMinutes: minutesOverrideFor(book, itemId, String(action)),
        learned: learnedTypicalFor(
          learnedResult ?? undefined,
          String(action),
          args.workContext,
        ) ?? null,
      }),
    tasks: candidates.map((c) => {
      const item = byId.get(c.itemId);
      const corrected = valueOverrideFor(book, c.itemId);
      // WMT-14: ONE builder for the value inputs, shared with the runner's
      // advice, so the two can never value the same garment differently.
      const value: ValueResult = item
        ? estimateWorkValue(valueInputFor(item, book, now))
        : estimateWorkValue({ marketplace: null, evidence: null });
      return {
        candidate: c,
        value,
        // WMT-05: the whole chain to sale-ready, not just this step.
        remainingActions: c.remainingActions,
        unfinishedSince: item?.created_at ?? null,
        valueFromOverride: corrected != null,
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
    now,
    budgetMinutes: args.budgetMinutes,
    ranked: batched.ordered,
  });

  // WMT-13: parcels due within a day (or already late), soonest first, for
  // the "Ship today" strip above the plan.
  const shipToday: ShipTodayEntry[] = candidates
    .filter((c) => {
      if (!isOwedParcel(c) || !c.shipBy.at) return false;
      const due = Date.parse(c.shipBy.at);
      return Number.isFinite(due) && Number.isFinite(nowMs) &&
        due - nowMs <= URGENT_WINDOW_HOURS * 3_600_000;
    })
    .map((c) => ({
      key: c.key,
      itemId: c.itemId,
      itemTitle: c.itemTitle ?? null,
      at: c.shipBy.at!,
      confidence: c.shipBy.confidence,
    }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  return {
    plan,
    ranked: batched.ordered,
    candidates,
    shipToday,
    groups: batched.groups,
    pullList: batched.pullList,
    budgetMinutes: args.budgetMinutes,
    takenAt: now,
    itemsRead: items.length,
    truncated: items.length >= PLAN_ITEM_LIMIT,
    suppressed,
    book,
    gated,
  };
}

// ── Learned durations (R2 01/06, US-3178) ───────────────────────────

interface ObservationRow {
  task_id: string;
  session_id: string;
  position: number;
  action_key: string;
  task_state: string;
  session_state: string;
  work_context: string;
  confirmed_minutes: number | null;
  correction_minutes: number | null;
  ended_at: string | null;
}

/**
 * The seller's own history, turned into what the learner reads.
 *
 * The FAMILY is derived through estimateDuration rather than stored, so the
 * learner and the scheduler can never disagree about which tasks batch
 * together -- the run detection in work-duration-learning.ts only means
 * anything if its idea of a family is the same one the scheduler charges setup
 * for. An action with no duration model has no family and is dropped.
 */
function toObservations(rows: readonly ObservationRow[]): RawObservation[] {
  const out: RawObservation[] = [];
  for (const r of rows) {
    const d = estimateDuration({ action: r.action_key });
    if (isUnestimated(d)) continue;
    out.push({
      taskId: r.task_id,
      sessionId: r.session_id,
      position: r.position,
      family: d.family,
      context: r.work_context === "phone_only" ? "phone_only" : "home",
      taskState: r.task_state,
      sessionState: r.session_state,
      confirmedMinutes: r.confirmed_minutes,
      correctionMinutes: r.correction_minutes,
      endedAt: r.ended_at,
    });
  }
  return out;
}

async function fetchLearned(): Promise<LearningResult> {
  const body = await edgeJson<{ observations: ObservationRow[] }>(
    "/api/flipdesk/planner/observations",
  );
  return learnDurations(toObservations(body.observations ?? []));
}

// Longer than the session read: a median over twenty samples does not move
// between two clicks of the picker, and re-reading the whole history on every
// plan would be paying for an answer that cannot have changed.
const LEARNED_STALE_MS = 10 * 60 * 1000;

export function useLearnedDurations(enabled = true) {
  return useQuery<LearningResult>({
    queryKey: ["planner_learned_durations"],
    enabled,
    staleTime: LEARNED_STALE_MS,
    queryFn: fetchLearned,
  });
}

/**
 * What the estimator should be told for one action, given what the seller's
 * history says.
 *
 * Returns undefined rather than null when there is nothing, so a caller can
 * spread it into EstimateInput and get the default path unchanged.
 */
export function learnedTypicalFor(
  result: LearningResult | undefined,
  action: string,
  context: WorkContext,
) {
  if (!result) return undefined;
  const d = estimateDuration({ action });
  if (isUnestimated(d)) return undefined;
  const learned = learnedFor(result, d.family, context);
  if (!learned) return undefined;
  return {
    typicalMinutes: learned.typicalMinutes,
    sampleCount: learned.sampleCount,
    observedLowMinutes: learned.observedLowMinutes,
    observedHighMinutes: learned.observedHighMinutes,
    allocation: learned.allocation,
  };
}

// ── Outcomes and the scorecard (R2 02/06 + 06/06) ───────────────────

interface OutcomeTaskRow {
  task_id: string;
  session_id: string;
  inventory_item_id: string | null;
  item_title_snapshot: string | null;
  action_key: string;
  task_state: string;
  session_state: string;
  estimate_value_cents: number | null;
  estimate_source: string | null;
  estimate_taken_at: string | null;
  confirmed_minutes: number | null;
  correction_minutes: number | null;
}

interface OutcomeSaleRow {
  sale_id: string;
  inventory_item_id: string | null;
  status: string;
  cancelled_at: string | null;
  sold_at: string | null;
  marketplace: string | null;
  acquired_price: number | string | null;
  money: Record<string, unknown>;
}

export interface OutcomeBook {
  outcomes: Outcome[];
  tasks: PlannedTask[];
  /** Server time, so the 30-day horizon is not judged by a laptop's clock. */
  now: string;
}

/**
 * The planner's history, compared against the books.
 *
 * THE COMPARISON RUNS HERE, not on the server, for the same reason the plan
 * does: compareOutcomes reuses saleNetCents, which is the finances
 * dashboard's own pnl_net, and the edge cannot import it. What the server
 * owns is the owner predicate on all four reads.
 */
export function useWorkOutcomes(enabled = true) {
  return useQuery<OutcomeBook>({
    queryKey: ["planner_outcomes"],
    enabled,
    // Longer than the session read. A scorecard over a month does not change
    // between two clicks of a date range, and re-reading four tables to
    // redraw the same figures is paying for an answer that cannot have moved.
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const body = await edgeJson<{
        tasks?: OutcomeTaskRow[];
        sales?: OutcomeSaleRow[];
        items?: { inventory_item_id: string; created_at: string | null }[];
        now?: string;
      }>("/api/flipdesk/planner/outcomes");
      const now = typeof body.now === "string" ? body.now : new Date().toISOString();
      const tasks: PlannedTask[] = (body.tasks ?? []).map((t) => ({
        taskId: t.task_id,
        sessionId: t.session_id,
        inventoryItemId: t.inventory_item_id,
        itemTitleSnapshot: t.item_title_snapshot,
        actionKey: t.action_key,
        taskState: t.task_state,
        sessionState: t.session_state,
        estimateValueCents: t.estimate_value_cents,
        estimateSource: t.estimate_source,
        estimateTakenAt: t.estimate_taken_at,
        confirmedMinutes: t.confirmed_minutes,
        correctionMinutes: t.correction_minutes,
      }));
      const { outcomes } = compareOutcomes({
        tasks,
        sales: (body.sales ?? []).map((s) => ({
          saleId: s.sale_id,
          inventoryItemId: s.inventory_item_id,
          status: s.status,
          cancelledAt: s.cancelled_at,
          soldAt: s.sold_at,
          money: s.money as never,
          acquiredPrice: s.acquired_price,
          // The legacy shipping total is not on this projection, and absent
          // is absent: saleNetCents treats null as "not recorded" rather
          // than as zero, which is the whole point of that column.
          legacyShipTotal: null,
          marketplace: s.marketplace,
        })),
        items: (body.items ?? []).map((i) => ({
          inventoryItemId: i.inventory_item_id,
          createdAt: i.created_at,
        })),
        now,
      });
      return { outcomes, tasks, now };
    },
  });
}

export function useBuildPlan() {
  const qc = useQueryClient();
  return useMutation<PreparedPlan, Error, BuildPlanArgs>({
    mutationFn: (args) => buildPlan(args, qc),
  });
}

// ── The built plan, kept across "Open item" round trips (WMT-11) ────────

/** A plan older than this is flagged as possibly out of date. */
export const PLAN_STALE_MS = 15 * 60 * 1000;

const planKey = (ownerId: string | null) => ["planner_plan", ownerId] as const;
const planStorageKey = (ownerId: string) => `wmt-plan:${ownerId}`;

function currentOwnerId(): string | null {
  const { activeWorkspaceOwnerId, user } = useAuthStore.getState();
  return activeWorkspaceOwnerId ?? user?.id ?? null;
}

/**
 * The plan saved for this owner in this tab, or null.
 *
 * sessionStorage, not localStorage: a plan is about this sitting, and one
 * left for tomorrow would describe a stock that has moved. Every access is
 * wrapped, because storage throws in private windows and blocked-site modes.
 */
export function readStoredPlan(ownerId: string | null): PreparedPlan | null {
  if (!ownerId) return null;
  try {
    const raw = sessionStorage.getItem(planStorageKey(ownerId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PreparedPlan;
    // The shape check that matters: a plan the page cannot render is worse
    // than no plan.
    if (
      typeof parsed?.takenAt !== "string" ||
      !Array.isArray(parsed?.plan?.tasks) ||
      !Array.isArray(parsed?.ranked) ||
      !Array.isArray(parsed?.candidates)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredPlan(ownerId: string | null, plan: PreparedPlan | null): void {
  if (!ownerId) return;
  try {
    if (plan) sessionStorage.setItem(planStorageKey(ownerId), JSON.stringify(plan));
    else sessionStorage.removeItem(planStorageKey(ownerId));
  } catch {
    // A plan that cannot be remembered is still a plan on screen.
  }
}

/** Forget the built plan for one owner, in memory and in the tab. */
export function clearPlannerPlan(qc: QueryClient, ownerId: string | null): void {
  qc.removeQueries({ queryKey: planKey(ownerId), exact: true });
  writeStoredPlan(ownerId, null);
}

/**
 * The plan on screen, keyed by workspace owner (WMT-11).
 *
 * Every row links out to its item, and coming back used to remount the page
 * with no plan. Keyed by OWNER so another workspace's plan never shows, and
 * restored from sessionStorage when the in-memory copy is gone.
 */
export function usePlannerPlan() {
  const qc = useQueryClient();
  const ownerId = useAuthStore((s) => s.activeWorkspaceOwnerId ?? s.user?.id ?? null);
  const query = useQuery<PreparedPlan | null>({
    queryKey: planKey(ownerId),
    // Restored synchronously as initial data, never fetched: a queryFn that
    // resolved after a build would overwrite the fresh plan with the stored
    // one. With initial data and staleTime Infinity it does not run.
    initialData: () => readStoredPlan(ownerId),
    queryFn: () => readStoredPlan(ownerId),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  const setPlan = useCallback(
    (plan: PreparedPlan) => {
      qc.setQueryData(planKey(ownerId), plan);
      writeStoredPlan(ownerId, plan);
    },
    [qc, ownerId],
  );
  const clear = useCallback(() => clearPlannerPlan(qc, ownerId), [qc, ownerId]);
  return { plan: query.data ?? null, ownerId, setPlan, clear };
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
  /**
   * When the running task started, by the server's clock (WMT-09). Only the
   * active task carries it; a reload reads it back instead of losing it.
   */
  started_at?: string | null;
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
    onSuccess: (next) => {
      qc.setQueryData(["planner_session"], next);
      // WMT-11: the plan became the session. Keeping it would leave the old
      // list under the runner, where it reads as a second to-do list.
      clearPlannerPlan(qc, currentOwnerId());
    },
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
    return {
      inventory_item_id: r?.itemId ?? null,
      item_title: c?.itemTitle ?? null,
      action_key: r?.action ?? null,
      prerequisite_keys: r?.prerequisiteKeys ?? [],
      bin: c?.bin?.value ?? null,
      // WMT-04: the ranker's resolved minutes, so a seller's correction or
      // learned pace is what the session records, not the bare default.
      estimate_minutes: r?.duration?.typical ?? null,
      estimate_value_cents: r?.conservativeCents ?? null,
      // WMT-05: where the PRICE came from (sold_comp, seller_estimate,
      // active_asking), which is what the scorecard groups on. This used to
      // send the rank tier, which no scorecard source matches, so every
      // session read "unknown".
      estimate_source: r?.valueSource ?? null,
    };
  });
}

// ── The value inputs for one garment (WMT-14) ───────────────────────

/** A dollars column as whole cents, or null when absent or not positive. */
function dollarsCents(v: number | null | undefined): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return Math.round(v * 100);
}

/**
 * What estimateWorkValue is told about one item.
 *
 * FEES. An item with no marketplace yet is almost always headed for eBay, and
 * refusing to value it left measure, photograph and price jobs -- most of a
 * plan -- ranked as "can't estimate". So eBay's schedule is ASSUMED, and
 * `fee_schedule_assumed` lands in `missing` so "Why this one?" says so. An
 * item that names another marketplace is still refused: that is a known fee
 * schedule this code does not model, not an unknown one.
 *
 * EVIDENCE, strongest first: the seller's own corrected range; the price a
 * SOLD item actually went for; the seller's target price; and last the list
 * price, which is an asking price and enters discounted.
 */
export function valueInputFor(
  item: ItemListRow,
  book: OverrideBook | null,
  now: string,
): ValueInput {
  const corrected = book ? valueOverrideFor(book, item.id) : null;
  const sold = item.status === "sold" || item.status === "shipped";
  const salePrice = dollarsCents(item.sale_price);
  const target = dollarsCents(item.target_price);
  const listed = dollarsCents(item.list_price);

  let evidence: PriceEvidence | null = null;
  if (corrected) {
    // The seller's range, as a range: both ends, no extra band.
    evidence = {
      amountCents: corrected.lowCents,
      highAmountCents: corrected.highCents,
      source: "seller_estimate",
      observedAt: now,
    };
  } else if (sold && salePrice !== null) {
    evidence = { amountCents: salePrice, source: "sold_comp", observedAt: item.updated_at ?? null };
  } else if (target !== null) {
    evidence = { amountCents: target, source: "seller_estimate", observedAt: item.updated_at ?? null };
  } else if (listed !== null) {
    evidence = { amountCents: listed, source: "active_asking", observedAt: item.updated_at ?? null };
  }

  const platform = item.listing_platform ?? null;
  return {
    marketplace: platform ?? "ebay",
    feeScheduleAssumed: platform === null,
    evidence,
    purchaseCents: item.purchase_price != null && Number.isFinite(item.purchase_price)
      ? Math.round(item.purchase_price * 100)
      : null,
    // Recorded postage where the row has it. A zero is the column default,
    // not a free parcel, so it falls through to the labelled fallback.
    shippingCents: dollarsCents(item.shipping_cost),
    // "What is still left to spend on this", as the seller corrected it. A
    // FUTURE cost, so it moves the rank.
    futureCostCents: book ? costOverrideFor(book, item.id) : null,
  };
}

// ── Advice for the task in hand (R2 03/06, US-3180) ─────────────────

/**
 * Should the seller keep working on this garment?
 *
 * Built from the item ROW the runner already has, so the advice costs no
 * extra read. The value estimate is the same estimateWorkValue call the plan
 * pipeline makes, from the same columns -- restating those inputs differently
 * here would give the runner a different answer from the plan the seller was
 * shown, for the same garment, on the same screen.
 */
export function adviseOnCurrentItem(args: {
  item: ItemListRow | null | undefined;
  action: string;
  hourlyTargetCents: number | null;
  eligibleBundleItemCount?: number;
}): AdviceResult | null {
  if (!args.item) return null;
  const item = args.item;

  // AC4: a sold or committed garment is not the seller's to reconsider.
  const soldOrCommitted = ["sold", "shipped", "completed", "archived"].includes(
    String(item.status ?? ""),
  );

  const value = estimateWorkValue(valueInputFor(item, null, new Date().toISOString()));

  // The minutes still ahead on the prep ladder, from the same candidate
  // builder the plan uses.
  // Every tool assumed available, because this is NOT the planner deciding
  // what fits an evening -- it is asking what work the garment still needs at
  // all. Filtering by tools here would report a tool-gated step as finished.
  const candidates = candidatesFor([item], {
    workContext: "home",
    availableTools: ["camera", "measuring_tape", "steamer", "packing_supplies"],
  });
  const mine = candidates.find((c) => c.itemId === item.id) ?? null;
  const remaining = mine ? mine.remainingActions : [];
  const remainingMinutes = remaining.reduce((sum, a) => {
    const d = estimateDuration({ action: a });
    return sum + (isUnestimated(d) ? 0 : d.typical);
  }, 0);

  return adviseOnItem({
    value,
    remainingMinutes,
    // Prep itself costs nothing beyond time today. Postage and supplies are
    // already inside the value estimate, so charging them again here would
    // deduct them twice.
    remainingCostCents: 0,
    hourlyTargetCents: args.hourlyTargetCents,
    eligibleBundleItemCount: args.eligibleBundleItemCount ?? 0,
    soldOrCommitted,
    listAsIsHref: `/dashboard/flipdesk/items/${item.id}`,
    bundleHref: "/dashboard/flipdesk/inventory",
    donationHref: `/dashboard/flipdesk/items/${item.id}`,
  });
}

