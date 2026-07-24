// Pure helpers for the price-drop / promo scheduler (US-150): wire-shape
// validation for trigger/action/scope JSON, trigger + scope evaluation against
// listing facts, the cost-basis margin floor, and the per-listing action plan.
// No DB/network here so all of it is unit-tested directly
// (tests/automation-rules_test.ts).

export const AUTOMATION_NAME_MAX = 80;
export const MAX_PRICE_DROP_PCT = 90;
export const MAX_PROMO_RATE_PCT = 100;
export const DEFAULT_COOLDOWN_DAYS = 7;
export const DEFAULT_MARGIN_FLOOR_PCT = 10;
// US-1448: coupon discount bounds — mirror the shared markdown clamp
// (MIN/MAX_MARKDOWN_PCT in ebay-marketing.ts), duplicated here so this module
// stays pure (no network-touching imports).
export const MIN_COUPON_PCT = 5;
export const MAX_COUPON_PCT = 70;

// ── Wire shapes ─────────────────────────────────────────────────

export type AutomationTrigger =
  | { type: "days_listed_gt"; days: number; cooldown_days: number }
  // US-2155: this means what it says — no views in the LAST N days, read from
  // the listing_metrics time-series (US-565). It used to test the CUMULATIVE
  // listings.views counter, which meant a listing with 500 lifetime views and
  // zero recent traffic could never fire the rule. See hasViewsWithin below for
  // the windowing semantics and the no-metrics fallback.
  | { type: "no_views_in_days"; days: number; cooldown_days: number }
  | {
    type: "watchers_lt_after_days";
    watchers: number;
    days: number;
    cooldown_days: number;
  };

export type AutomationAction =
  | { type: "price_drop_pct"; pct: number; margin_floor_pct: number }
  | { type: "set_promo_rate_pct"; pct: number }
  // US-1448: create a CODED_COUPON item promotion for the aged listing (the
  // "auto-coupon items >90 days" merchandising lever). The coupon code is
  // generated at apply time; the cover photo is the required promotion image.
  | { type: "create_coded_coupon"; discount_pct: number }
  | { type: "end_listing" };

// Scope mirrors the US-143 FilterQuery shape (src/lib/item-filter.ts) so the
// web UI can reuse the existing FilterBuilder component verbatim.
export type ScopeField =
  | "brand"
  | "category"
  | "size"
  | "source"
  | "cost"
  | "target_price"
  | "status"
  | "grade"
  | "days_in_status";

export type ScopeOp =
  | "eq"
  | "neq"
  | "lt"
  | "gt"
  | "lte"
  | "gte"
  | "in"
  | "nin"
  | "contains"
  | "isnull"
  | "notnull";

export interface ScopeRule {
  field: ScopeField;
  op: ScopeOp;
  value: string;
}

export type AutomationScope =
  | { type: "all" }
  | { type: "filter"; combinator: "and" | "or"; rules: ScopeRule[] };

export interface NormalizedAutomation {
  name: string;
  is_active: boolean;
  trigger_json: AutomationTrigger;
  action_json: AutomationAction;
  scope_json: AutomationScope;
}

export type NormalizeAutomationResult =
  | { ok: true; value: NormalizedAutomation }
  | { ok: false; error: string };

const SCOPE_FIELDS: ReadonlySet<string> = new Set([
  "brand",
  "category",
  "size",
  "source",
  "cost",
  "target_price",
  "status",
  "grade",
  "days_in_status",
]);

const SCOPE_OPS: ReadonlySet<string> = new Set([
  "eq",
  "neq",
  "lt",
  "gt",
  "lte",
  "gte",
  "in",
  "nin",
  "contains",
  "isnull",
  "notnull",
]);

function posInt(v: unknown, fallback: number | null = null): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const n = Math.trunc(v);
  return n >= 1 ? n : fallback;
}

function nonNegInt(v: unknown, fallback: number | null = null): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const n = Math.trunc(v);
  return n >= 0 ? n : fallback;
}

function normalizeTrigger(
  raw: unknown,
): AutomationTrigger | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Trigger is required" };
  }
  const t = raw as Record<string, unknown>;
  const cooldown = posInt(t.cooldown_days, DEFAULT_COOLDOWN_DAYS)!;
  switch (t.type) {
    case "days_listed_gt": {
      const days = posInt(t.days);
      if (days == null) return { error: "Trigger needs a positive day count" };
      return { type: "days_listed_gt", days, cooldown_days: cooldown };
    }
    case "no_views_in_days": {
      const days = posInt(t.days);
      if (days == null) return { error: "Trigger needs a positive day count" };
      return { type: "no_views_in_days", days, cooldown_days: cooldown };
    }
    case "watchers_lt_after_days": {
      const watchers = posInt(t.watchers);
      const days = posInt(t.days);
      if (watchers == null || days == null) {
        return { error: "Trigger needs a watcher count and a day count" };
      }
      return { type: "watchers_lt_after_days", watchers, days, cooldown_days: cooldown };
    }
    default:
      return { error: "Unknown trigger type" };
  }
}

function normalizeAction(raw: unknown): AutomationAction | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Action is required" };
  }
  const a = raw as Record<string, unknown>;
  switch (a.type) {
    case "price_drop_pct": {
      const pct = typeof a.pct === "number" && Number.isFinite(a.pct) ? a.pct : 0;
      if (pct <= 0 || pct > MAX_PRICE_DROP_PCT) {
        return { error: `Price drop must be between 1 and ${MAX_PRICE_DROP_PCT}%` };
      }
      const floor = nonNegInt(a.margin_floor_pct, DEFAULT_MARGIN_FLOOR_PCT)!;
      return { type: "price_drop_pct", pct, margin_floor_pct: floor };
    }
    case "set_promo_rate_pct": {
      const pct = typeof a.pct === "number" && Number.isFinite(a.pct) ? a.pct : 0;
      if (pct <= 0 || pct > MAX_PROMO_RATE_PCT) {
        return { error: `Promo rate must be between 1 and ${MAX_PROMO_RATE_PCT}%` };
      }
      return { type: "set_promo_rate_pct", pct };
    }
    case "create_coded_coupon": {
      const pct = typeof a.discount_pct === "number" && Number.isFinite(a.discount_pct)
        ? a.discount_pct
        : 0;
      if (pct < MIN_COUPON_PCT || pct > MAX_COUPON_PCT) {
        return {
          error: `Coupon discount must be between ${MIN_COUPON_PCT} and ${MAX_COUPON_PCT}%`,
        };
      }
      return { type: "create_coded_coupon", discount_pct: pct };
    }
    case "end_listing":
      return { type: "end_listing" };
    default:
      return { error: "Unknown action type" };
  }
}

function normalizeScope(raw: unknown): AutomationScope | { error: string } {
  if (raw == null) return { type: "all" };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Invalid scope" };
  }
  const s = raw as Record<string, unknown>;
  if (s.type === "all" || s.type === undefined) return { type: "all" };
  if (s.type !== "filter") return { error: "Unknown scope type" };
  const combinator = s.combinator === "or" ? "or" : "and";
  if (!Array.isArray(s.rules)) return { error: "Scope filter needs rules" };
  const rules: ScopeRule[] = [];
  for (const r of s.rules) {
    if (!r || typeof r !== "object") return { error: "Invalid scope rule" };
    const rr = r as Record<string, unknown>;
    if (typeof rr.field !== "string" || !SCOPE_FIELDS.has(rr.field)) {
      return { error: "Unknown scope filter field" };
    }
    if (typeof rr.op !== "string" || !SCOPE_OPS.has(rr.op)) {
      return { error: "Unknown scope filter operator" };
    }
    rules.push({
      field: rr.field as ScopeField,
      op: rr.op as ScopeOp,
      value: typeof rr.value === "string" ? rr.value : "",
    });
  }
  if (rules.length === 0) return { type: "all" };
  return { type: "filter", combinator, rules };
}

/** Validate + normalize a create/update payload (snake_case wire shape). */
export function normalizeAutomationInput(
  body: unknown,
): NormalizeAutomationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid rule payload" };
  }
  const b = body as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) return { ok: false, error: "Rule name is required" };
  if (name.length > AUTOMATION_NAME_MAX) {
    return {
      ok: false,
      error: `Rule name must be ${AUTOMATION_NAME_MAX} characters or fewer`,
    };
  }
  const trigger = normalizeTrigger(b.trigger_json);
  if ("error" in trigger) return { ok: false, error: trigger.error };
  const action = normalizeAction(b.action_json);
  if ("error" in action) return { ok: false, error: action.error };
  const scope = normalizeScope(b.scope_json);
  if ("error" in scope) return { ok: false, error: scope.error };
  return {
    ok: true,
    value: {
      name,
      is_active: b.is_active !== false, // default on
      trigger_json: trigger,
      action_json: action,
      scope_json: scope,
    },
  };
}

// ── Evaluation ──────────────────────────────────────────────────

/**
 * One windowed traffic reading from listing_metrics (US-565).
 *
 * `views` is NOT a per-day count: eBay's traffic report returns a TRAILING
 * window total (getTrafficReport pulls the last 7 days), so a row stamped on
 * date D means "views in the 7 days ending D". Consecutive rows therefore
 * overlap heavily — see hasViewsWithin for why that makes MAX, not SUM, the
 * only meaningful aggregate.
 */
export interface ViewWindow {
  daysAgo: number;
  views: number;
}

/** Everything a rule can look at for one active listing. */
export interface AutomationFacts {
  ageDays: number;
  /** Cumulative lifetime views (listings.views). Only the fallback path. */
  views: number;
  /**
   * How long ago the performance sync last ran for this listing
   * (listings.last_metrics_synced_at), or null if it never has. This is the
   * disambiguator that makes "no metrics rows" readable: the sync stamps EVERY
   * active listing, but only writes a listing_metrics row when eBay actually
   * reported engagement.
   */
  metricsSyncedDaysAgo: number | null;
  /** listing_metrics readings for this listing, newest first. */
  recentViewWindows: ViewWindow[];
  watchers: number;
  // Scope-filter fields (US-143 vocabulary).
  brand: string | null;
  category: string | null;
  size: string | null;
  sourceName: string | null;
  cost: number | null;
  targetPrice: number | null;
  status: string | null;
  grade: number | null;
  daysInStatus: number | null;
}

/**
 * Did this listing get any views inside the last `days` days? (US-2155)
 *
 * Three cases, in order:
 *
 *  1. No trustworthy recent sync — never synced, or the last sync predates the
 *     window — so we have no evidence about the window at all. Fall back to the
 *     cumulative counter, which is exactly the pre-US-2155 behaviour. Sellers
 *     who never connected performance sync see no change.
 *  2. Synced, but no listing_metrics rows land inside the window. eBay OMITS
 *     listings with no engagement from the traffic report, and the sync only
 *     writes a row when eBay reported some — so for a listing we know was
 *     synced, absence IS the zero. No views.
 *  3. Rows inside the window: each is a trailing-window TOTAL, so the same view
 *     is counted by every row whose window covers it. MAX is the correct
 *     aggregate (SUM would multiply-count roughly 7x). Any non-zero reading
 *     means the listing got traffic, so the rule must not fire.
 */
export function hasViewsWithin(f: AutomationFacts, days: number): boolean {
  if (f.metricsSyncedDaysAgo == null || f.metricsSyncedDaysAgo > days) {
    return f.views > 0;
  }
  const inWindow = f.recentViewWindows.filter((w) => w.daysAgo <= days);
  if (inWindow.length === 0) return false;
  return inWindow.some((w) => w.views > 0);
}

export function triggerMatches(
  t: AutomationTrigger,
  f: AutomationFacts,
): boolean {
  switch (t.type) {
    case "days_listed_gt":
      return f.ageDays > t.days;
    case "no_views_in_days":
      return f.ageDays > t.days && !hasViewsWithin(f, t.days);
    case "watchers_lt_after_days":
      return f.ageDays >= t.days && f.watchers < t.watchers;
  }
}

function scopeFieldValue(
  f: AutomationFacts,
  field: ScopeField,
): string | number | null {
  switch (field) {
    case "brand":
      return f.brand;
    case "category":
      return f.category;
    case "size":
      return f.size;
    case "source":
      return f.sourceName;
    case "cost":
      return f.cost;
    case "target_price":
      return f.targetPrice;
    case "status":
      return f.status;
    case "grade":
      return f.grade;
    case "days_in_status":
      return f.daysInStatus;
  }
}

// Same operator semantics as the web evaluator (src/lib/item-filter.ts) so a
// filter behaves identically in the Items page and in an automation scope.
function evalScopeRule(f: AutomationFacts, rule: ScopeRule): boolean {
  const v = scopeFieldValue(f, rule.field);
  const raw = rule.value.trim();
  switch (rule.op) {
    case "isnull":
      return v == null || v === "";
    case "notnull":
      return v != null && v !== "";
    case "contains":
      return v != null && String(v).toLowerCase().includes(raw.toLowerCase());
    case "in":
    case "nin": {
      const list = raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const hit = v != null && list.includes(String(v).toLowerCase());
      return rule.op === "in" ? hit : !hit;
    }
    case "eq":
    case "neq": {
      const equal = v != null && String(v).toLowerCase() === raw.toLowerCase();
      return rule.op === "eq" ? equal : !equal;
    }
    case "lt":
    case "gt":
    case "lte":
    case "gte": {
      const n = Number(raw);
      if (v == null || !Number.isFinite(n) || typeof v !== "number") {
        return false;
      }
      if (rule.op === "lt") return v < n;
      if (rule.op === "gt") return v > n;
      if (rule.op === "lte") return v <= n;
      return v >= n;
    }
  }
}

export function scopeMatches(s: AutomationScope, f: AutomationFacts): boolean {
  if (s.type === "all" || s.rules.length === 0) return true;
  const results = s.rules.map((r) => evalScopeRule(f, r));
  return s.combinator === "and" ? results.every(Boolean) : results.some(Boolean);
}

/** True when `cooldownDays` have elapsed since the rule's last action on the listing. */
export function isCooledDown(
  lastActionISO: string | null,
  cooldownDays: number,
  now: Date,
): boolean {
  if (!lastActionISO) return true;
  const t = new Date(lastActionISO).getTime();
  if (!Number.isFinite(t)) return true;
  return (now.getTime() - t) / 86_400_000 >= cooldownDays;
}

/**
 * Hard floor (AC): a rule can never drop the price below
 * cost_basis × (1 + margin_floor_pct/100). Unknown cost basis → no floor.
 */
export function computeFloorCents(
  costBasisDollars: number | null,
  marginFloorPct: number,
): number | null {
  if (costBasisDollars == null || !Number.isFinite(costBasisDollars) || costBasisDollars <= 0) {
    return null;
  }
  // Integer math — cost × 1.1 in floats lands on 1650.0000000000002.
  const costCents = Math.round(costBasisDollars * 100);
  return Math.ceil((costCents * (100 + marginFloorPct)) / 100);
}

export type PlannedAction =
  | { kind: "price_drop"; newCents: number; floored: boolean }
  | { kind: "set_promo_rate"; newRatePct: number }
  | { kind: "create_coupon"; discountPct: number }
  | { kind: "end_listing" };

export interface PlanInput {
  currentCents: number;
  costBasisDollars: number | null;
  currentPromoRatePct: number | null;
}

/**
 * Turn a matched rule's action into a concrete change for one listing — or
 * null for a no-op (already at/below the floor, promo rate already set).
 */
export function planAction(
  action: AutomationAction,
  i: PlanInput,
): PlannedAction | null {
  switch (action.type) {
    case "price_drop_pct": {
      if (i.currentCents <= 0) return null;
      const floor = computeFloorCents(i.costBasisDollars, action.margin_floor_pct);
      const dropped = Math.floor(i.currentCents * (1 - action.pct / 100));
      const newCents = Math.max(dropped, floor ?? 0);
      if (newCents >= i.currentCents) return null; // floored out — never raise
      return { kind: "price_drop", newCents, floored: floor != null && dropped < floor };
    }
    case "set_promo_rate_pct": {
      if (i.currentPromoRatePct != null && i.currentPromoRatePct === action.pct) {
        return null;
      }
      return { kind: "set_promo_rate", newRatePct: action.pct };
    }
    case "create_coded_coupon":
      // Uniqueness/eligibility is enforced at apply time (live listing id +
      // cover image required); the trigger cooldown prevents repeat coupons.
      return { kind: "create_coupon", discountPct: action.discount_pct };
    case "end_listing":
      return { kind: "end_listing" };
  }
}
