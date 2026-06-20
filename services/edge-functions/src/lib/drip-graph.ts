// US-945: drip campaign step-graph — shared types, validation, dry-run
// evaluator, and copy rendering.
//
// PURE module: no supabase / network / env imports, so it's safe to unit-test
// directly (see drip-graph_test.ts) and cheap to import anywhere. The admin
// builder edits a `DripGraph`; the edge handler validates it here before any
// write (no loops/orphans), renders step copy for preview/test-send, and runs
// `simulateJourney()` for the "simulate for this user" dry-run.

// ── Types ──

export type DripPhase = "in_trial" | "win_back";

/** Where a step's timer is anchored; delayHours is an offset from it. */
export type DripAnchor = "enrollment" | "previous" | "trial_end";

/** Operators for send-gating conditions + branch predicates. */
export type DripConditionOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "is_true"
  | "is_false";

export interface DripCondition {
  field: string;
  op: DripConditionOp;
  value?: string | number | boolean | null;
}

export interface DripVariant {
  id: string;
  /** Relative A/B weight (0–100). */
  weight: number;
  subject: string;
  html: string;
}

export interface DripBranch {
  /** ALL conditions must pass for the branch to be taken. */
  conditions: DripCondition[];
  targetStepId: string;
}

export interface DripStep {
  id: string;
  label: string;
  phase: DripPhase;
  /** Free-text trigger label (documentation only; the anchor drives timing). */
  trigger: string;
  anchor: DripAnchor;
  /** Offset from the anchor, in hours. May be negative (e.g. -72 = 3d before). */
  delayHours: number;
  /** Send-gating conditions — if any fails the step is SKIPPED (not the journey). */
  conditions: DripCondition[];
  /** Operator brief that drives copy regeneration. */
  brief: string;
  incentiveEnabled: boolean;
  /** Conditional jumps, evaluated in order before falling through to `next`. */
  branches: DripBranch[];
  /** Default next step id, or null to exit the journey. */
  next: string | null;
  /** Terminal step (must have next === null). */
  exit: boolean;
  variants: DripVariant[];
}

export interface DripGraph {
  entryStepId: string | null;
  steps: DripStep[];
  /**
   * US-944: when true, the engine autonomously re-tunes per-step variant
   * weights from recorded conversions each optimizer run (still visible +
   * overridable in the builder). Optional; defaults to off. Ignored by
   * validateGraph/simulateJourney — it only gates self-tuning.
   */
  autotuneEnabled?: boolean;
}

// ── Validation ──

export interface GraphValidation {
  ok: boolean;
  errors: string[];
}

const VALID_ANCHORS = new Set<DripAnchor>(["enrollment", "previous", "trial_end"]);
const VALID_PHASES = new Set<DripPhase>(["in_trial", "win_back"]);
const VALID_OPS = new Set<DripConditionOp>([
  "eq", "neq", "gt", "gte", "lt", "lte", "is_true", "is_false",
]);
const STEP_ID_RE = /^[a-z0-9_]{1,64}$/i;

function validateConditions(
  conds: unknown,
  ctx: string,
  errors: string[],
): void {
  if (!Array.isArray(conds)) {
    errors.push(`${ctx}: conditions must be an array`);
    return;
  }
  for (const [i, raw] of conds.entries()) {
    const c = raw as Partial<DripCondition>;
    if (!c || typeof c.field !== "string" || !c.field.trim()) {
      errors.push(`${ctx}: condition ${i} is missing a field`);
    }
    if (typeof c?.op !== "string" || !VALID_OPS.has(c.op as DripConditionOp)) {
      errors.push(`${ctx}: condition ${i} has an invalid operator`);
    }
  }
}

/**
 * Validate a drip graph: unique step ids, a resolvable entry, every
 * next/branch target existing, exit steps with no `next`, ≥1 variant per step,
 * NO orphans (every step reachable from entry) and NO loops (the next/branch
 * edges form a DAG). Returns all problems found, not just the first.
 */
export function validateGraph(graph: unknown): GraphValidation {
  const errors: string[] = [];
  const g = graph as Partial<DripGraph> | null;

  if (!g || typeof g !== "object" || !Array.isArray(g.steps)) {
    return { ok: false, errors: ["Graph must be an object with a steps array"] };
  }

  const steps = g.steps as DripStep[];
  const ids = new Set<string>();
  for (const step of steps) {
    if (!step || typeof step.id !== "string" || !STEP_ID_RE.test(step.id)) {
      errors.push(`Step has an invalid id: ${JSON.stringify(step?.id)}`);
      continue;
    }
    if (ids.has(step.id)) errors.push(`Duplicate step id: ${step.id}`);
    ids.add(step.id);
  }

  // Per-step field checks.
  for (const step of steps) {
    if (typeof step?.id !== "string" || !ids.has(step.id)) continue;
    const ctx = `Step '${step.id}'`;
    if (!VALID_PHASES.has(step.phase)) errors.push(`${ctx}: invalid phase`);
    if (!VALID_ANCHORS.has(step.anchor)) errors.push(`${ctx}: invalid anchor`);
    if (typeof step.delayHours !== "number" || !Number.isFinite(step.delayHours)) {
      errors.push(`${ctx}: delayHours must be a finite number`);
    }
    if (!Array.isArray(step.variants) || step.variants.length === 0) {
      errors.push(`${ctx}: needs at least one variant`);
    } else {
      for (const [i, v] of step.variants.entries()) {
        if (!v || typeof v.subject !== "string" || !v.subject.trim()) {
          errors.push(`${ctx}: variant ${i} needs a subject`);
        }
        if (!v || typeof v.html !== "string" || !v.html.trim()) {
          errors.push(`${ctx}: variant ${i} needs HTML`);
        }
        if (!v || typeof v.weight !== "number" || v.weight < 0) {
          errors.push(`${ctx}: variant ${i} needs a non-negative weight`);
        }
      }
    }
    validateConditions(step.conditions, ctx, errors);

    // next / exit consistency.
    if (step.exit) {
      if (step.next !== null && step.next !== undefined) {
        errors.push(`${ctx}: an exit step must have next = null`);
      }
    } else if (step.next != null && !ids.has(step.next)) {
      errors.push(`${ctx}: next points to unknown step '${step.next}'`);
    }

    // Branch targets.
    if (!Array.isArray(step.branches)) {
      errors.push(`${ctx}: branches must be an array`);
    } else {
      for (const [i, b] of step.branches.entries()) {
        if (!b || typeof b.targetStepId !== "string" || !ids.has(b.targetStepId)) {
          errors.push(`${ctx}: branch ${i} targets unknown step '${b?.targetStepId}'`);
        }
        validateConditions(b?.conditions, `${ctx} branch ${i}`, errors);
      }
    }
  }

  // Entry must resolve (when there are steps).
  if (steps.length > 0) {
    if (typeof g.entryStepId !== "string" || !ids.has(g.entryStepId)) {
      errors.push("entryStepId must reference an existing step");
    }
  }

  // Reachability + cycle detection only when the skeleton is sound.
  if (errors.length === 0 && typeof g.entryStepId === "string") {
    const byId = new Map(steps.map((s) => [s.id, s]));
    const edges = (s: DripStep): string[] => {
      const out: string[] = [];
      for (const b of s.branches) out.push(b.targetStepId);
      if (s.next) out.push(s.next);
      return out;
    };

    // Reachable set (orphan detection).
    const reachable = new Set<string>();
    const queue = [g.entryStepId];
    while (queue.length) {
      const id = queue.shift()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      const s = byId.get(id);
      if (s) for (const t of edges(s)) queue.push(t);
    }
    for (const s of steps) {
      if (!reachable.has(s.id)) {
        errors.push(`Step '${s.id}' is unreachable from the entry (orphan)`);
      }
    }

    // Cycle detection (DFS colors).
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>(steps.map((s) => [s.id, WHITE]));
    const stack: Array<{ id: string; ei: number }> = [];
    let cycle = false;
    for (const start of steps) {
      if (color.get(start.id) !== WHITE) continue;
      stack.push({ id: start.id, ei: 0 });
      color.set(start.id, GRAY);
      while (stack.length) {
        const frame = stack[stack.length - 1]!;
        const s = byId.get(frame.id)!;
        const outs = edges(s);
        if (frame.ei < outs.length) {
          const next = outs[frame.ei++]!;
          const cstate = color.get(next);
          if (cstate === GRAY) {
            cycle = true;
            break;
          }
          if (cstate === WHITE) {
            color.set(next, GRAY);
            stack.push({ id: next, ei: 0 });
          }
        } else {
          color.set(frame.id, BLACK);
          stack.pop();
        }
      }
      if (cycle) break;
    }
    if (cycle) errors.push("Graph contains a loop (the step edges must be acyclic)");
  }

  return { ok: errors.length === 0, errors };
}

// ── Copy rendering ──

/** User context used for personalization tokens + condition evaluation. */
export interface DripUserState {
  firstName?: string | null;
  trialEndsAt?: string | null;
  converted?: boolean;
  plan?: string | null;
  subscriptionStatus?: string | null;
  gradesUsed?: number;
  trialDaysRemaining?: number;
  daysSinceSignup?: number;
}

const INCENTIVE_HTML =
  '<p style="margin:16px 0;padding:12px;border:1px dashed #E94560;border-radius:8px">' +
  "🎁 Use code <strong>TRIAL20</strong> for 20% off your first month." +
  "</p>";

function tokenValues(
  user: DripUserState,
  incentiveEnabled: boolean,
): Record<string, string> {
  return {
    firstName: (user.firstName ?? "there").toString(),
    trialEndsAt: user.trialEndsAt
      ? new Date(user.trialEndsAt).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
      })
      : "soon",
    incentive: incentiveEnabled ? INCENTIVE_HTML : "",
  };
}

/** Replace `{{token}}` placeholders. Unknown tokens collapse to empty string. */
export function applyTokens(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : "");
}

export interface RenderedStep {
  variantId: string;
  subject: string;
  html: string;
}

/**
 * Render a step's chosen variant for a sample user (preview / test-send). When
 * `variantId` is omitted the first variant is used.
 */
export function renderStep(
  step: Pick<DripStep, "variants" | "incentiveEnabled">,
  user: DripUserState = {},
  variantId?: string,
): RenderedStep | null {
  const variants = Array.isArray(step.variants) ? step.variants : [];
  if (variants.length === 0) return null;
  const variant = (variantId && variants.find((v) => v.id === variantId)) ||
    variants[0]!;
  const values = tokenValues(user, !!step.incentiveEnabled);
  return {
    variantId: variant.id,
    subject: applyTokens(variant.subject ?? "", values),
    html: applyTokens(variant.html ?? "", values),
  };
}

// ── Condition evaluation ──

function fieldValue(field: string, user: DripUserState): unknown {
  switch (field) {
    case "converted":
      return !!user.converted;
    case "plan":
      return user.plan ?? null;
    case "subscriptionStatus":
      return user.subscriptionStatus ?? null;
    case "gradesUsed":
      return user.gradesUsed ?? 0;
    case "trialDaysRemaining":
      return user.trialDaysRemaining ?? 0;
    case "daysSinceSignup":
      return user.daysSinceSignup ?? 0;
    default:
      return undefined;
  }
}

export function evaluateCondition(c: DripCondition, user: DripUserState): boolean {
  const actual = fieldValue(c.field, user);
  switch (c.op) {
    case "is_true":
      return actual === true;
    case "is_false":
      return actual === false || actual === 0 || actual == null;
    case "eq":
      return actual === c.value;
    case "neq":
      return actual !== c.value;
    case "gt":
      return typeof actual === "number" && typeof c.value === "number" && actual > c.value;
    case "gte":
      return typeof actual === "number" && typeof c.value === "number" && actual >= c.value;
    case "lt":
      return typeof actual === "number" && typeof c.value === "number" && actual < c.value;
    case "lte":
      return typeof actual === "number" && typeof c.value === "number" && actual <= c.value;
    default:
      return false;
  }
}

export function evaluateAll(conds: DripCondition[], user: DripUserState): boolean {
  return conds.every((c) => evaluateCondition(c, user));
}

// ── Deterministic A/B bucketing (matches a stable per-user split) ──

/** FNV-1a → [0,100). Stable for a given (userId, stepId) pair. */
export function variantBucket(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 100;
}

export function pickVariant(step: DripStep, userId: string): DripVariant {
  const variants = step.variants;
  const total = variants.reduce((s, v) => s + Math.max(0, v.weight), 0);
  if (total <= 0) return variants[0]!;
  const bucket = (variantBucket(`${userId}:${step.id}`) / 100) * total;
  let acc = 0;
  for (const v of variants) {
    acc += Math.max(0, v.weight);
    if (bucket < acc) return v;
  }
  return variants[variants.length - 1]!;
}

// ── Dry-run journey simulation ──

export interface SimulatedSend {
  stepId: string;
  label: string;
  phase: DripPhase;
  variantId: string;
  scheduledAt: string;
  willSend: boolean;
  reason: string;
}

export interface SimulationResult {
  campaignWouldEnroll: boolean;
  sends: SimulatedSend[];
  exitReason: string | null;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function anchorTime(
  anchor: DripAnchor,
  enrolledMs: number,
  prevMs: number,
  trialEndMs: number | null,
): number {
  switch (anchor) {
    case "enrollment":
      return enrolledMs;
    case "previous":
      return prevMs;
    case "trial_end":
      return trialEndMs ?? enrolledMs + 14 * DAY_MS;
  }
}

/**
 * Dry-run: walk the graph for one user WITHOUT sending, returning the projected
 * timeline (which steps would fire, when, which variant, and whether the
 * send-gating conditions pass). The walk is bounded by `steps.length` hops so a
 * (validation-rejected) cycle can never loop forever. `nowMs` lets callers mark
 * which projected sends are already in the past.
 */
export function simulateJourney(
  graph: DripGraph,
  user: DripUserState & { userId: string; enrolledAtMs: number },
  nowMs: number,
): SimulationResult {
  const byId = new Map(graph.steps.map((s) => [s.id, s]));
  const sends: SimulatedSend[] = [];

  if (user.converted) {
    return {
      campaignWouldEnroll: false,
      sends: [],
      exitReason: "Already converted — would exit immediately",
    };
  }
  if (!graph.entryStepId || !byId.has(graph.entryStepId)) {
    return { campaignWouldEnroll: false, sends: [], exitReason: "No entry step" };
  }

  const trialEndMs = user.trialEndsAt ? Date.parse(user.trialEndsAt) : null;
  let currentId: string | null = graph.entryStepId;
  let prevMs = user.enrolledAtMs;
  let exitReason: string | null = null;
  const hops = graph.steps.length + 1;

  for (let i = 0; i < hops && currentId; i++) {
    const step: DripStep | undefined = byId.get(currentId);
    if (!step) break;

    const scheduledMs = anchorTime(step.anchor, user.enrolledAtMs, prevMs, trialEndMs) +
      step.delayHours * HOUR_MS;
    const willSend = evaluateAll(step.conditions, user);
    sends.push({
      stepId: step.id,
      label: step.label,
      phase: step.phase,
      variantId: pickVariant(step, user.userId).id,
      scheduledAt: new Date(scheduledMs).toISOString(),
      willSend,
      reason: willSend
        ? (scheduledMs <= nowMs ? "Conditions met (already due)" : "Conditions met (scheduled)")
        : "Skipped — send conditions not met",
    });
    prevMs = scheduledMs;

    if (step.exit) {
      exitReason = "Reached terminal step";
      break;
    }

    // Branch first, then fall through to next.
    let nextId: string | null = step.next;
    for (const b of step.branches) {
      if (evaluateAll(b.conditions, user)) {
        nextId = b.targetStepId;
        break;
      }
    }
    if (!nextId) {
      exitReason = "Reached end of journey";
      break;
    }
    currentId = nextId;
  }

  return { campaignWouldEnroll: true, sends, exitReason };
}

/** Next scheduled engine tick — top of the next hour from `nowMs`. */
export function nextTickIso(nowMs: number): string {
  return new Date(Math.ceil((nowMs + 1) / HOUR_MS) * HOUR_MS).toISOString();
}

// ── Autonomous tick planner (US-943) ──

export interface PlannedSend {
  stepId: string;
  /** 1-based index of the step in graph.steps — matches drip_sends.step (the
   * ordinal the optimizer keys on). NOT the path position. */
  ordinal: number;
  phase: DripPhase;
  variantId: string;
  /** When this step became due (anchor + delay), ms epoch. */
  scheduledMs: number;
}

export interface TickPlan {
  /** send: one step is due now; wait: nothing due yet; complete: journey done. */
  status: "send" | "wait" | "complete";
  send: PlannedSend | null;
  /** When the enrollment should next be evaluated (ms epoch), or null when the
   * journey is complete. The engine stores this in next_evaluation_at. */
  nextEvaluationMs: number | null;
  /** Ordinals of due steps skipped because their send-gating conditions failed
   * (skips the step, NOT the journey — mirrors simulateJourney). */
  skipped: number[];
}

/**
 * Decide what the autonomous tick should do for ONE enrollment, given the set of
 * step ordinals already sent. Walks the graph from the entry exactly like
 * `simulateJourney`, but stops at the FIRST unsent step and returns a single
 * decision so the engine sends at most one email per enrollment per tick (so a
 * long downtime catch-up trickles, not floods):
 *
 *   • A step already sent (its ordinal in `sentOrdinals`) is stepped over, with
 *     its scheduled time threaded forward so `previous`-anchored steps still
 *     compute correctly.
 *   • The first unsent step NOT yet due → status "wait" with nextEvaluationMs set
 *     to its scheduled time (the tick self-gates on this).
 *   • The first unsent step that IS due and whose conditions pass → status
 *     "send".
 *   • A due step whose send-gating conditions fail is skipped (recorded in
 *     `skipped`) and the walk continues — the journey is not aborted.
 *   • Reaching a terminal/dead-end step → status "complete".
 *
 * Pure: callers handle conversion-exit (which short-circuits the whole journey)
 * before calling this — a converted user should exit, not be planned.
 */
export function planTick(
  graph: DripGraph,
  user: DripUserState & { userId: string; enrolledAtMs: number },
  sentOrdinals: Set<number>,
  nowMs: number,
): TickPlan {
  const byId = new Map(graph.steps.map((s) => [s.id, s]));
  const ordinalById = new Map(graph.steps.map((s, i) => [s.id, i + 1]));
  const skipped: number[] = [];

  if (!graph.entryStepId || !byId.has(graph.entryStepId)) {
    return { status: "complete", send: null, nextEvaluationMs: null, skipped };
  }

  const trialEndMs = user.trialEndsAt ? Date.parse(user.trialEndsAt) : null;
  let currentId: string | null = graph.entryStepId;
  let prevMs = user.enrolledAtMs;
  const hops = graph.steps.length + 1;

  for (let i = 0; i < hops && currentId; i++) {
    const step: DripStep | undefined = byId.get(currentId);
    if (!step) break;
    const ordinal = ordinalById.get(step.id)!;
    const scheduledMs =
      anchorTime(step.anchor, user.enrolledAtMs, prevMs, trialEndMs) +
      step.delayHours * HOUR_MS;

    if (!sentOrdinals.has(ordinal)) {
      if (scheduledMs > nowMs) {
        return { status: "wait", send: null, nextEvaluationMs: scheduledMs, skipped };
      }
      if (evaluateAll(step.conditions, user)) {
        return {
          status: "send",
          send: {
            stepId: step.id,
            ordinal,
            phase: step.phase,
            variantId: pickVariant(step, user.userId).id,
            scheduledMs,
          },
          nextEvaluationMs: scheduledMs,
          skipped,
        };
      }
      // Due but gated — skip this step, keep walking.
      skipped.push(ordinal);
    }
    prevMs = scheduledMs;

    if (step.exit) {
      return { status: "complete", send: null, nextEvaluationMs: null, skipped };
    }
    let nextId: string | null = step.next;
    for (const b of step.branches) {
      if (evaluateAll(b.conditions, user)) {
        nextId = b.targetStepId;
        break;
      }
    }
    if (!nextId) {
      return { status: "complete", send: null, nextEvaluationMs: null, skipped };
    }
    currentId = nextId;
  }

  return { status: "complete", send: null, nextEvaluationMs: null, skipped };
}
