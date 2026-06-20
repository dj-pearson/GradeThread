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
  /**
   * US-942: campaign-level conversion incentive. OFF by default. References an
   * existing Stripe coupon (admin coupons system) + a shared, time-boxed promo
   * code that the engine surfaces ONLY on eligible win-back (post-trial) steps
   * whose own `incentiveEnabled` is set. Resolved against the live Stripe coupon
   * at send time (lib/drip-incentive.ts) into a RenderableIncentive — that is
   * what renderStep injects for the {{incentive}} token. Optional; absent or
   * `{enabled:false}` means the {{incentive}} token always renders empty (the
   * value-only email variant).
   */
  incentive?: DripIncentive;
}

/**
 * US-942: campaign-level conversion incentive config (off by default). The
 * discount itself lives in Stripe (referenced by `couponId`); `maxPercentOff`
 * is a server-side guardrail re-checked at send time against the live coupon,
 * and `expiryHours` time-boxes the surfaced offer from the moment it is shown.
 */
export interface DripIncentive {
  enabled: boolean;
  /** Existing Stripe coupon id (admin coupons system). */
  couponId: string;
  /** Shared, user-facing promo code mapped to the coupon. */
  promoCode: string;
  /** Guardrail: refuse a coupon discounting more than this percent (1–100). */
  maxPercentOff: number;
  /** Time-box: hours the surfaced offer remains valid from when it's shown. */
  expiryHours: number;
}

/**
 * The offer resolved for rendering, built from a DripIncentive + the live Stripe
 * coupon at send time. Pure data so renderStep stays env/Stripe-free.
 */
export interface RenderableIncentive {
  promoCode: string;
  /** Human label for the discount, e.g. "20% off your first month". */
  label: string;
  /** ISO expiry for the time-box, or null when open-ended. */
  expiresAt: string | null;
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

function validateIncentive(raw: unknown, errors: string[]): void {
  if (typeof raw !== "object" || raw === null) {
    errors.push("incentive must be an object");
    return;
  }
  const inc = raw as Partial<DripIncentive>;
  if (typeof inc.enabled !== "boolean") {
    errors.push("incentive.enabled must be a boolean");
  }
  // The discount references are only required once the incentive is enabled.
  if (inc.enabled === true) {
    if (typeof inc.couponId !== "string" || !inc.couponId.trim()) {
      errors.push("incentive.couponId is required when the incentive is enabled");
    }
    if (typeof inc.promoCode !== "string" || !inc.promoCode.trim()) {
      errors.push("incentive.promoCode is required when the incentive is enabled");
    }
    if (
      typeof inc.maxPercentOff !== "number" ||
      !Number.isFinite(inc.maxPercentOff) ||
      inc.maxPercentOff <= 0 ||
      inc.maxPercentOff > 100
    ) {
      errors.push("incentive.maxPercentOff must be a number between 1 and 100");
    }
    if (
      typeof inc.expiryHours !== "number" ||
      !Number.isFinite(inc.expiryHours) ||
      inc.expiryHours <= 0
    ) {
      errors.push("incentive.expiryHours must be a positive number");
    }
  }
}

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

  // US-942: campaign-level incentive (optional). Only enforce the full shape
  // when it's enabled — a disabled/absent incentive is always valid.
  if (g.incentive !== undefined && g.incentive !== null) {
    validateIncentive(g.incentive, errors);
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
  // US-939: whole days since the user's most recent real activity (latest
  // grade/listing/sale). Drives the Phase-1 inactivity-nudge branch
  // (`daysSinceActive gte 3`). For a never-active trialist the engine anchors
  // this to signup, so it grows with the trial. Defaults to 0 (treated as
  // "active today") when unknown, so the nudge never fires on missing data.
  daysSinceActive?: number;
  // US-940: real per-user activity for the mid-trial recap (the "personalization
  // layer" numbers). All-time counts so the recap reflects everything they've
  // done in the trial; `totalActivity` is their sum and drives the
  // zero-activity → re-activation branch (`totalActivity is_false`).
  gradesCount?: number;
  listingsCount?: number;
  salesCount?: number;
  certificatesCount?: number;
  totalActivity?: number;
  /** Deep-link to the subscribe / add-a-card flow for the recommended plan. */
  checkoutUrl?: string;
  /** Recommended plan label (e.g. "Pro") for copy. */
  recommendedPlan?: string;
  /** Pre-rendered HTML list of Pro features paused on downgrade (AC5). */
  lostFeatures?: string;
}

/** Minimal HTML-escape for values interpolated into the incentive block. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&"
      ? "&amp;"
      : ch === "<"
      ? "&lt;"
      : ch === ">"
      ? "&gt;"
      : ch === '"'
      ? "&quot;"
      : "&#39;");
}

/**
 * US-942: render the {{incentive}} block from a resolved offer. No hardcoded
 * code/discount — everything comes from the resolved RenderableIncentive (which
 * the engine builds from the live Stripe coupon), so a code is never leaked.
 */
export function buildIncentiveHtml(inc: RenderableIncentive): string {
  const expiry = inc.expiresAt
    ? '<br><span style="color:#888;font-size:12px">Offer expires ' +
      escapeHtml(
        new Date(inc.expiresAt).toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
        }),
      ) +
      ".</span>"
    : "";
  return (
    '<p style="margin:16px 0;padding:12px;border:1px dashed #E94560;border-radius:8px">' +
    `🎁 Use code <strong>${escapeHtml(inc.promoCode)}</strong> for ${escapeHtml(inc.label)}.` +
    expiry +
    "</p>"
  );
}

function tokenValues(
  user: DripUserState,
  incentive: RenderableIncentive | null,
): Record<string, string> {
  return {
    firstName: (user.firstName ?? "there").toString(),
    trialEndsAt: user.trialEndsAt
      ? new Date(user.trialEndsAt).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
      })
      : "soon",
    incentive: incentive ? buildIncentiveHtml(incentive) : "",
    // US-940 recap personalization tokens — real per-user numbers, surfaced in
    // the day-7 recap copy. Counts default to "0" so a missing count never leaks
    // an empty token into the sentence.
    gradesCount: String(user.gradesCount ?? 0),
    listingsCount: String(user.listingsCount ?? 0),
    salesCount: String(user.salesCount ?? 0),
    certificatesCount: String(user.certificatesCount ?? 0),
    trialDaysRemaining: String(user.trialDaysRemaining ?? 0),
    checkoutUrl: user.checkoutUrl ?? "https://gradethread.com/dashboard/billing?upgrade=pro",
    recommendedPlan: user.recommendedPlan ?? "Pro",
    lostFeatures: user.lostFeatures ?? "",
  };
}

// ── Pro-feature loss copy (US-940, grounded in plan-gate entitlements) ──

/**
 * Human labels for the gated Pro capabilities (mirrors `GateFlags` keys in
 * pricing-config.ts) + the headline metered caps. The engine reads the live
 * plan matrix and calls `lostProFeatures` / `buildLostFeaturesHtml` so the
 * "what you lose on downgrade" copy stays grounded in the actual entitlements
 * rather than a hand-maintained marketing list. Pure (no env/Stripe) so it's
 * unit-testable.
 */
export const PRO_FEATURE_LABELS: Record<string, string> = {
  bulkActions: "Bulk listing actions",
  scheduledActions: "Scheduled actions",
  compPulls: "Sold-comp pricing research",
  autoRelist: "Automatic relisting",
  subAccounts: "Team sub-accounts",
  apiAccess: "API access",
  reconciliation: "Payout reconciliation",
  prioritySupport: "Priority support",
  autolister: "AI AutoLister (photos → listings)",
};

/**
 * The Pro capabilities a trialist loses when they drop to Free: every gate that
 * Pro enables and Free does not, in `PRO_FEATURE_LABELS` order. Extra free-form
 * lines (e.g. the metered grade/listing caps) can be appended by the caller.
 */
export function lostProFeatures(
  proFlags: Record<string, boolean>,
  freeFlags: Record<string, boolean>,
): string[] {
  return Object.keys(PRO_FEATURE_LABELS)
    .filter((k) => proFlags[k] === true && freeFlags[k] !== true)
    .map((k) => PRO_FEATURE_LABELS[k]!);
}

/** Render a `<ul>` of paused-on-downgrade items for the {{lostFeatures}} token. */
export function buildLostFeaturesHtml(labels: string[]): string {
  if (labels.length === 0) return "";
  const items = labels.map((l) => `<li>${escapeHtml(l)}</li>`).join("");
  return `<ul style="margin:12px 0;padding-left:20px">${items}</ul>`;
}

/**
 * US-911 marketing consent: the drip is marketing mail, so a recipient who has
 * opted out of marketing email must not enter or receive it. Mirrors
 * `marketingOptedOut` in admin-growth.ts (notification_preferences.marketing.email
 * === false). Pure (prefs blob in → boolean out) so both the engine (entry filter
 * + dispatch exit, routes/drip.ts) and its tests can use it without supabase/env.
 */
export function marketingOptedOutEmail(
  prefs: Record<string, unknown> | null | undefined,
): boolean {
  if (!prefs) return false;
  const m = prefs["marketing"];
  if (!m || typeof m !== "object") return false;
  return (m as Record<string, unknown>)["email"] === false;
}

// ── Per-send dispatch gate (US-938) ──
//
// The pure decision the engine makes for ONE due step before it sends: honor
// marketing consent (US-911), a missing address, hard-bounce/complaint
// suppression (US-914), a frequency cap, and the QA gate (US-924). Pure so the
// engine (routes/drip.ts) and its test share one source of truth — the engine
// supplies the (already-resolved) booleans; this maps them to send/skip/exit +
// the recorded reason, and which terminal exit a hard stop triggers.

export type SendGateAction = "send" | "skip" | "exit";

export interface SendGateInput {
  /** notification_preferences.marketing.email === false (US-911). */
  optedOut: boolean;
  /** No deliverable email address on file. */
  noAddress: boolean;
  /** On the bounce/complaint suppression list (US-914). */
  suppressed: boolean;
  /** A marketing email already went out inside the min-gap window. */
  frequencyCapped: boolean;
  /** The rendered email passed the pre-send QA gate (US-924). */
  qaOk: boolean;
}

export interface SendGateDecision {
  action: SendGateAction;
  /** Recorded on drip_sends.skip_reason (or the enrollment exit) for analytics. */
  reason: string | null;
  /** Set when the decision is a TERMINAL exit (hand the user back to the
   * standard cadence) rather than a retry-later skip. */
  exitReason?: "unsubscribed" | "suppressed";
}

/**
 * Decide whether a due step is sent, skipped (retry later), or exits the
 * journey. Order matters: a permanent stop (opt-out, no address, suppression)
 * exits the journey; a transient block (frequency cap, QA failure) only skips
 * this tick and is re-evaluated on the next one.
 */
export function evaluateSendGate(i: SendGateInput): SendGateDecision {
  if (i.optedOut) return { action: "exit", reason: "opted_out", exitReason: "unsubscribed" };
  if (i.noAddress) return { action: "exit", reason: "no_address", exitReason: "suppressed" };
  if (i.suppressed) return { action: "exit", reason: "suppressed", exitReason: "suppressed" };
  if (i.frequencyCapped) return { action: "skip", reason: "frequency_capped" };
  if (!i.qaOk) return { action: "skip", reason: "qa_failed" };
  return { action: "send", reason: null };
}

/**
 * US-941: may this user ENTER (or remain in) the post-trial win-back? Gated on
 * NOT converted and NOT marketing-opted-out — a converted trialist never enters
 * win-back, and an opted-out recipient receives none. Suppression (hard bounce /
 * complaint) is enforced separately by deliverEmail at send time (US-914).
 */
export function isWinBackEligible(
  user: Pick<DripUserState, "converted">,
  prefs: Record<string, unknown> | null | undefined,
): boolean {
  return user.converted !== true && !marketingOptedOutEmail(prefs);
}

/**
 * US-942: server-side eligibility for surfacing the incentive on a given
 * step+user. Win-back (post-trial) phase only — never in-trial, never to an
 * already-paid user — so a code is never exposed outside the win-back.
 */
export function isIncentiveEligible(
  step: Pick<DripStep, "phase" | "incentiveEnabled">,
  user: Pick<DripUserState, "converted">,
): boolean {
  return step.incentiveEnabled === true &&
    step.phase === "win_back" &&
    user.converted !== true;
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
 * Render a step's chosen variant for a sample user (preview / test-send / live
 * send). When `variantId` is omitted the first variant is used. The {{incentive}}
 * token only renders when the step has `incentiveEnabled` AND a resolved
 * `incentive` is supplied (US-942) — otherwise it collapses to empty, giving the
 * value-only variant. The caller (engine / preview) is responsible for passing a
 * resolved incentive ONLY for eligible recipients (see `isIncentiveEligible`).
 */
export function renderStep(
  step: Pick<DripStep, "variants" | "incentiveEnabled">,
  user: DripUserState = {},
  variantId?: string,
  incentive?: RenderableIncentive | null,
): RenderedStep | null {
  const variants = Array.isArray(step.variants) ? step.variants : [];
  if (variants.length === 0) return null;
  const variant = (variantId && variants.find((v) => v.id === variantId)) ||
    variants[0]!;
  const values = tokenValues(user, step.incentiveEnabled ? (incentive ?? null) : null);
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
    // US-939 Phase-1 inactivity-nudge branch field.
    case "daysSinceActive":
      return user.daysSinceActive ?? 0;
    // US-940 recap branch fields.
    case "gradesCount":
      return user.gradesCount ?? 0;
    case "listingsCount":
      return user.listingsCount ?? 0;
    case "salesCount":
      return user.salesCount ?? 0;
    case "certificatesCount":
      return user.certificatesCount ?? 0;
    case "totalActivity":
      return user.totalActivity ?? 0;
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

// ── Conversion attribution (US-937) ──
//
// When a trialist converts (customer.subscription.created), the engine resolves
// which drip step/email drove it. PURE so the webhook (lib/drip-conversion.ts)
// and its test share one source of truth: feed it the (enrollment, step) send
// ledger + the conversion timing, get back first/last-touch attribution.
//
// Model:
//   • last-touch  → the LAST drip email the user opened/clicked before
//     converting. This is the canonical `step` (matches the US-946 funnel which
//     groups conversions by step).
//   • first-touch → the FIRST drip email they engaged with (for the same-row
//     first/last comparison).
//   • organic     → they converted without engaging ANY drip email (AC4). We
//     still record the last step actually SENT before conversion (so the row
//     names which message was in flight), with model = 'organic' and no
//     first/last-touch step.

export interface DripSendRecord {
  /** 1-based step ordinal (drip_sends.step). */
  ordinal: number;
  phase: DripPhase;
  variant: string | null;
  /** Epoch ms the email was actually sent, or null if never sent (skip row). */
  sentAtMs: number | null;
  /** Epoch ms of the open pixel hit (US-913), or null. */
  openedAtMs: number | null;
  /** Epoch ms of the first tracked click (US-913), or null. */
  clickedAtMs: number | null;
}

export type AttributionModel = "last_touch" | "first_touch" | "organic";

export interface ConversionAttribution {
  model: AttributionModel;
  /** Canonical attributed step: the last-touch step, or (organic) the last step
   * sent before conversion, or null when nothing was sent. */
  step: number | null;
  phase: DripPhase;
  variant: string | null;
  /** First drip email engaged before conversion (null when organic). */
  firstTouchStep: number | null;
  /** Last drip email engaged before conversion (null when organic). */
  lastTouchStep: number | null;
  /** Engagement time of the last-touch email (ms epoch), or null when organic. */
  lastTouchAtMs: number | null;
  /** Days from the trial clock start to conversion (fractional, ≥ 0). */
  daysToConvert: number;
}

/** Latest open/click of a send that happened at-or-before conversion, else null. */
function engagementMs(s: DripSendRecord, convertedAtMs: number): number | null {
  const times = [s.openedAtMs, s.clickedAtMs].filter(
    (t): t is number => t != null && t <= convertedAtMs,
  );
  return times.length ? Math.max(...times) : null;
}

export function computeConversionAttribution(
  sends: DripSendRecord[],
  clockStartMs: number,
  convertedAtMs: number,
): ConversionAttribution {
  const daysToConvert = Math.max(
    0,
    Math.round(((convertedAtMs - clockStartMs) / DAY_MS) * 100) / 100,
  );

  // Only steps actually sent at-or-before the conversion can be credited.
  const sentBefore = sends.filter(
    (s) => s.sentAtMs != null && s.sentAtMs <= convertedAtMs,
  );

  // Engaged = opened or clicked before converting.
  const engaged = sentBefore
    .map((s) => ({ s, eng: engagementMs(s, convertedAtMs) }))
    .filter((x): x is { s: DripSendRecord; eng: number } => x.eng != null)
    .sort((a, b) => a.eng - b.eng);

  if (engaged.length > 0) {
    const first = engaged[0]!;
    const last = engaged[engaged.length - 1]!;
    return {
      model: "last_touch",
      step: last.s.ordinal,
      phase: last.s.phase,
      variant: last.s.variant,
      firstTouchStep: first.s.ordinal,
      lastTouchStep: last.s.ordinal,
      lastTouchAtMs: last.eng,
      daysToConvert,
    };
  }

  // Organic: converted without engaging any drip email. Still name the last step
  // that was in flight (greatest sent time) so the row isn't blind.
  const lastSent = sentBefore.reduce<DripSendRecord | null>(
    (acc, s) => (acc == null || (s.sentAtMs ?? 0) > (acc.sentAtMs ?? 0) ? s : acc),
    null,
  );
  return {
    model: "organic",
    step: lastSent?.ordinal ?? null,
    phase: lastSent?.phase ?? "in_trial",
    variant: lastSent?.variant ?? null,
    firstTouchStep: null,
    lastTouchStep: null,
    lastTouchAtMs: null,
    daysToConvert,
  };
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
