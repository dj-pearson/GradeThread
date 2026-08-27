// Pure helpers for the price-drop / promo scheduler (US-150): wire-shape
// validation for trigger/action/scope JSON, trigger + scope evaluation against
// listing facts, the cost-basis margin floor, and the per-listing action plan.
// No DB/network here so all of it is unit-tested directly
// (tests/automation-rules_test.ts).

import {
  DEFAULT_OFFER_MARGIN_FLOOR_PCT,
  normalizeThresholdPct,
} from "./offer-rules.ts";
import {
  normalizeThresholdCents as normalizeReturnThresholdCents,
} from "./return-rules.ts";

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
// US-2156: send-offer-to-watchers discount bounds. eBay's Negotiation API takes
// a PERCENTAGE_DISCOUNT between 5 and 60 for send_offer_to_interested_buyers.
export const MIN_WATCHER_OFFER_PCT = 5;
export const MAX_WATCHER_OFFER_PCT = 60;
export const AUTOMATION_MESSAGE_MAX = 280;

// US-2156: how far a comp_price_moved rule may say the price has drifted. A
// bound keeps a fat-fingered 1000 from meaning "never fires".
export const MAX_COMP_DRIFT_PCT = 200;

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
  }
  // ── US-2156: the non-aging half of the vocabulary ─────────────
  // Every one of these reads a fact the system ALREADY stores, so a rule can
  // react to the pipeline rather than only to the calendar. See AutomationFacts
  // for where each fact comes from.
  //
  // A buyer sent a best offer on this listing inside the last `days` days
  // (marketplace_event_notifications, written by the US-1055 poll).
  | { type: "offer_received"; days: number; cooldown_days: number }
  // A buyer opened a return against this listing's item inside `days`.
  | { type: "return_opened"; days: number; cooldown_days: number }
  // The listing carries at least `min_violations` open policy violations
  // (listings.compliance_violation_count, US-1305 / 00326).
  | {
    type: "compliance_violation";
    min_violations: number;
    cooldown_days: number;
  }
  // A grade landed for this item inside `days`. `max_grade` (nullable) narrows
  // it to grades AT OR BELOW a value, which is the useful shape — "anything
  // that came back a 6 or worse, drop the price".
  | {
    type: "grade_completed";
    days: number;
    max_grade: number | null;
    cooldown_days: number;
  }
  // The item is sitting in `status` and landed there inside `days`.
  | {
    type: "item_status_changed";
    status: string;
    days: number;
    cooldown_days: number;
  }
  // The asking price has drifted away from the stored comp range by `pct`:
  //   above → price is >pct% ABOVE the comp high (p75) — overpriced
  //   below → price is >pct% BELOW the comp low  (p25) — leaving money behind
  | {
    type: "comp_price_moved";
    direction: "above" | "below";
    pct: number;
    cooldown_days: number;
  }
  // ── US-2236 ───────────────────────────────────────────────────
  // An incoming Best Offer, judged as a percent of the asking price.
  //
  // ⚠ THIS ONE IS NOT EVALUATED BY THE LISTING PLANNER, and that is not an
  // oversight. Every other trigger above asks a question about ONE LISTING and
  // yields ONE action for it. This one asks about an OFFER, and a listing can
  // carry several open offers with different prices and different right
  // answers. It is executed per-offer by runOfferRulesForOwner (see
  // routes/flipdesk-automations.ts) using the pure decision in lib/offer-rules
  // .ts, inside the SAME hourly cron — same lock, same plan gate, no new job.
  //
  // triggerMatches() returns FALSE for it unconditionally, so it can never make
  // the listing planner act. That refusal is test-guarded.
  | {
    type: "offer_threshold";
    /** Accept at or above this percent of list. Null = never auto-accept. */
    accept_at_pct: number | null;
    /** Decline strictly below this percent of list. Null = never auto-decline. */
    decline_below_pct: number | null;
    /**
     * US-2940: counter at this percent of list. Null = never auto-counter.
     *
     * Optional on the wire so every rule stored before US-2940 keeps parsing —
     * an absent field is null, which is the pre-counter behaviour exactly.
     */
    counter_at_pct?: number | null;
    /** Minimum margin over acquisition cost an auto-ACCEPT must clear. */
    margin_floor_pct: number;
    cooldown_days: number;
  }
  // US-2938: the return-shaped sibling. Same reasoning as offer_threshold — the
  // evaluation unit is a RETURN, not a listing, so triggerMatches() refuses it
  // and a per-return runner executes it inside the same hourly cron.
  // US-2950: judged per SET, not per listing. A markdown sale is ONE
  // percentage across many items, so the listing planner cannot express it
  // either — same reason offer_threshold and return_threshold sit out here.
  | {
    type: "markdown_schedule";
    min_days_listed: number;
    markdown_pct: number;
    margin_floor_pct: number;
    /** Items graded below this are kept out. Null includes every grade. */
    min_grade: number | null;
    cooldown_days: number;
  }
  | {
    type: "return_threshold";
    /** Auto-approve at or below this order total, in cents. Null = never. */
    approve_at_or_below_cents: number | null;
    /** Refund without asking for the item back, in cents. Null = never. */
    refund_without_return_at_or_below_cents: number | null;
    cooldown_days: number;
  };

export type AutomationAction =
  | { type: "price_drop_pct"; pct: number; margin_floor_pct: number }
  | { type: "set_promo_rate_pct"; pct: number }
  // US-1448: create a CODED_COUPON item promotion for the aged listing (the
  // "auto-coupon items >90 days" merchandising lever). The coupon code is
  // generated at apply time; the cover photo is the required promotion image.
  | { type: "create_coded_coupon"; discount_pct: number }
  | { type: "end_listing" }
  // ── US-2156 ───────────────────────────────────────────────────
  // End the listing and put the item back in the drafting queue so the seller
  // (or the autolister) can push a fresh listing. Deliberately NOT an
  // end-then-immediately-republish: a relist that re-publishes without a human
  // would re-consume an activeListings cap slot and re-charge marketplace
  // insertion fees on a listing the seller never re-approved.
  | { type: "relist" }
  // Fan the item out to a second marketplace via the US-708 adapter registry.
  | { type: "crosslist_to"; platform: string }
  // eBay Negotiation: offer `discount_pct` off to everyone watching. Gated on
  // the US-1967 negotiation capability — unlicensed deployments skip it.
  | { type: "send_offer_to_watchers"; discount_pct: number }
  // Move the item to another pipeline status. Restricted to the statuses a
  // human may hand-set (see AUTOMATION_SETTABLE_STATUSES).
  | { type: "advance_status"; status: string }
  // Tell the seller something happened. The escape hatch for every trigger
  // whose right answer is a human decision, not a price change.
  | { type: "notify"; message: string };

/**
 * Statuses an automation may write (US-2156).
 *
 * Mirrors INTAKE_STATUSES (US-1484): the system/terminal states — grading,
 * graded, comped, drafted, listed, sold, shipped, completed, returned — are
 * owned by their own flows (a grade submission, a publish, a marketplace sale
 * webhook). Letting a rule fabricate one would, for example, mark an item
 * 'grading' without a submission or a charge, or 'sold' with no sale row. So a
 * rule may only move an item through the early pipeline or park it off it.
 */
export const AUTOMATION_SETTABLE_STATUSES: readonly string[] = [
  "sourced",
  "acquired",
  "cataloged",
  "measured",
  "photographed",
  "archived",
  "keeping",
  "wearing",
];

/** Marketplaces a crosslist_to action may target (mirrors CROSS_LISTING_PLATFORMS). */
export const AUTOMATION_CROSSLIST_PLATFORMS: readonly string[] = [
  "ebay",
  "shopify",
  "poshmark",
  "mercari",
  "depop",
  "etsy",
  "whatnot",
];

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
    // ── US-2156 ───────────────────────────────────────────────
    case "offer_received": {
      const days = posInt(t.days);
      if (days == null) return { error: "Trigger needs a positive day count" };
      return { type: "offer_received", days, cooldown_days: cooldown };
    }
    case "return_opened": {
      const days = posInt(t.days);
      if (days == null) return { error: "Trigger needs a positive day count" };
      return { type: "return_opened", days, cooldown_days: cooldown };
    }
    case "compliance_violation": {
      // Default 1 — "any open violation" is the shape a seller means.
      const min = posInt(t.min_violations, 1)!;
      return { type: "compliance_violation", min_violations: min, cooldown_days: cooldown };
    }
    case "grade_completed": {
      const days = posInt(t.days);
      if (days == null) return { error: "Trigger needs a positive day count" };
      let maxGrade: number | null = null;
      if (t.max_grade != null) {
        const g = typeof t.max_grade === "number" && Number.isFinite(t.max_grade)
          ? t.max_grade
          : NaN;
        if (!(g >= 1 && g <= 10)) {
          return { error: "Grade threshold must be between 1 and 10" };
        }
        maxGrade = g;
      }
      return { type: "grade_completed", days, max_grade: maxGrade, cooldown_days: cooldown };
    }
    case "item_status_changed": {
      const status = typeof t.status === "string" ? t.status.trim() : "";
      if (!status) return { error: "Trigger needs an item status" };
      const days = posInt(t.days);
      if (days == null) return { error: "Trigger needs a positive day count" };
      return { type: "item_status_changed", status, days, cooldown_days: cooldown };
    }
    case "comp_price_moved": {
      const direction = t.direction === "below" ? "below" : t.direction === "above" ? "above" : null;
      if (!direction) return { error: "Trigger needs a direction of above or below" };
      const pct = typeof t.pct === "number" && Number.isFinite(t.pct) ? t.pct : NaN;
      if (!(pct > 0 && pct <= MAX_COMP_DRIFT_PCT)) {
        return { error: `Comp drift must be between 1 and ${MAX_COMP_DRIFT_PCT}%` };
      }
      return { type: "comp_price_moved", direction, pct, cooldown_days: cooldown };
    }
    case "markdown_schedule": {
      const days = Math.max(1, Math.trunc(Number(t.min_days_listed) || 0));
      const pct = Math.trunc(Number(t.markdown_pct) || 0);
      if (!(pct > 0)) return { error: "Set a markdown percentage" };
      const grade = t.min_grade == null || t.min_grade === ""
        ? null
        : Number(t.min_grade);
      if (grade != null && (!Number.isFinite(grade) || grade < 1 || grade > 10)) {
        return { error: "The minimum grade must be between 1 and 10" };
      }
      return {
        type: "markdown_schedule",
        min_days_listed: days,
        markdown_pct: pct,
        // Defaulted like the offer floor: every rule gets the safety net,
        // even from a seller who never thinks about it.
        margin_floor_pct: Math.max(0, Math.trunc(Number(t.margin_floor_pct) || 0)) ||
          DEFAULT_OFFER_MARGIN_FLOOR_PCT,
        min_grade: grade,
        cooldown_days: cooldown,
      };
    }
    case "return_threshold": {
      const approve = normalizeReturnThresholdCents(t.approve_at_or_below_cents);
      const keep = normalizeReturnThresholdCents(t.refund_without_return_at_or_below_cents);
      if (approve === null && keep === null) {
        return { error: "Set an auto-approve or a refund-without-return limit" };
      }
      // Refused at CONFIGURATION time, like the offer overlap above. Refunding
      // without the item back is strictly more generous than approving a
      // return, so a keep-it limit above the approve limit describes a rule
      // whose cheaper band is never reached.
      if (approve !== null && keep !== null && keep > approve) {
        return {
          error: "The refund-without-return limit must be at or below the auto-approve limit",
        };
      }
      return {
        type: "return_threshold",
        approve_at_or_below_cents: approve,
        refund_without_return_at_or_below_cents: keep,
        cooldown_days: cooldown,
      };
    }
    case "offer_threshold": {
      const accept = normalizeThresholdPct(t.accept_at_pct);
      const decline = normalizeThresholdPct(t.decline_below_pct);
      if (accept === null && decline === null && normalizeThresholdPct(t.counter_at_pct) === null) {
        return { error: "Set an auto-accept, auto-counter or auto-decline threshold" };
      }
      // Refused at CONFIGURATION time, not silently skipped at run time. The
      // decision function also handles the overlap defensively, but a rule the
      // seller can see in their list and that will never fire is worse than a
      // validation error they can act on immediately.
      if (accept !== null && decline !== null && accept <= decline) {
        return { error: "The accept threshold must be above the decline threshold" };
      }
      const counter = normalizeThresholdPct(t.counter_at_pct);
      // US-2940: refused at CONFIGURATION time, like the accept/decline overlap
      // above. A counter at or above the accept threshold can never fire —
      // anything that high is accepted first — and a rule the seller can see in
      // their list that will never act is worse than a validation error.
      if (accept !== null && counter !== null && counter >= accept) {
        return { error: "The counter price must be below the accept threshold" };
      }
      const floorRaw = normalizeThresholdPct(t.margin_floor_pct);
      return {
        type: "offer_threshold",
        accept_at_pct: accept,
        decline_below_pct: decline,
        counter_at_pct: counter,
        // Defaulted rather than required: every rule gets the safety net, and a
        // seller who never thinks about it is protected anyway.
        margin_floor_pct: floorRaw ?? DEFAULT_OFFER_MARGIN_FLOOR_PCT,
        cooldown_days: cooldown,
      };
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
    // ── US-2156 ───────────────────────────────────────────────
    case "relist":
      return { type: "relist" };
    case "crosslist_to": {
      const platform = typeof a.platform === "string" ? a.platform.trim().toLowerCase() : "";
      if (!AUTOMATION_CROSSLIST_PLATFORMS.includes(platform)) {
        return { error: "Unknown marketplace for cross-listing" };
      }
      return { type: "crosslist_to", platform };
    }
    case "send_offer_to_watchers": {
      const pct = typeof a.discount_pct === "number" && Number.isFinite(a.discount_pct)
        ? a.discount_pct
        : 0;
      if (pct < MIN_WATCHER_OFFER_PCT || pct > MAX_WATCHER_OFFER_PCT) {
        return {
          error:
            `Watcher offer must be between ${MIN_WATCHER_OFFER_PCT} and ${MAX_WATCHER_OFFER_PCT}%`,
        };
      }
      return { type: "send_offer_to_watchers", discount_pct: pct };
    }
    case "advance_status": {
      const status = typeof a.status === "string" ? a.status.trim() : "";
      if (!AUTOMATION_SETTABLE_STATUSES.includes(status)) {
        return { error: "An automation can't set that item status" };
      }
      return { type: "advance_status", status };
    }
    case "notify": {
      const message = typeof a.message === "string" ? a.message.trim() : "";
      if (!message) return { error: "Notification needs a message" };
      if (message.length > AUTOMATION_MESSAGE_MAX) {
        return {
          error: `Notification must be ${AUTOMATION_MESSAGE_MAX} characters or fewer`,
        };
      }
      return { type: "notify", message };
    }
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

  // ── US-2156 facts ───────────────────────────────────────────────
  // All of these are OPTIONAL on the wire so every existing caller (and every
  // existing test) keeps compiling; an absent fact simply never fires its
  // trigger, which is the safe direction — a rule that can't see its evidence
  // must not act.
  /**
   * Days since the most recent best offer landed on this listing, or null when
   * none is on record. Sourced from marketplace_event_notifications rows the
   * US-1055 poll writes (source_kind 'offer'), joined to the listing by the
   * eBay item id.
   */
  offerReceivedDaysAgo?: number | null;
  /** Same shape for returns (source_kind 'return'). */
  returnOpenedDaysAgo?: number | null;
  /** listings.compliance_violation_count (00326). */
  complianceViolations?: number | null;
  /** Days since this item's grade report was created, or null if ungraded. */
  gradeCompletedDaysAgo?: number | null;
  /** Current asking price in cents — the comp_price_moved left-hand side. */
  priceCents?: number | null;
  /** listings.price_range_low_cents (comp p25). */
  compLowCents?: number | null;
  /** listings.price_range_high_cents (comp p75). */
  compHighCents?: number | null;
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

/** True when `daysAgo` is a real reading inside the last `days` days (US-2156). */
function withinDays(daysAgo: number | null | undefined, days: number): boolean {
  return daysAgo != null && Number.isFinite(daysAgo) && daysAgo >= 0 &&
    daysAgo <= days;
}

/**
 * Has the asking price drifted off the stored comp range? (US-2156)
 *
 * Both sides need a real number, so a listing with no comp data NEVER fires —
 * the alternative (treating a missing p25 as 0) would mark every uncomped
 * listing as wildly overpriced and mass-drop prices on the strength of absent
 * evidence.
 */
export function compDriftMatches(
  f: AutomationFacts,
  direction: "above" | "below",
  pct: number,
): boolean {
  const price = f.priceCents;
  if (price == null || !Number.isFinite(price) || price <= 0) return false;
  if (direction === "above") {
    const high = f.compHighCents;
    if (high == null || !Number.isFinite(high) || high <= 0) return false;
    return price > high * (1 + pct / 100);
  }
  const low = f.compLowCents;
  if (low == null || !Number.isFinite(low) || low <= 0) return false;
  return price < low * (1 - pct / 100);
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
    // ── US-2156 ───────────────────────────────────────────────
    case "offer_received":
      return withinDays(f.offerReceivedDaysAgo, t.days);
    case "return_opened":
      return withinDays(f.returnOpenedDaysAgo, t.days);
    case "compliance_violation":
      return (f.complianceViolations ?? 0) >= t.min_violations;
    case "grade_completed": {
      if (!withinDays(f.gradeCompletedDaysAgo, t.days)) return false;
      if (t.max_grade == null) return true;
      // A grade threshold with no grade on record can't be evaluated — don't
      // guess, don't fire.
      return f.grade != null && f.grade <= t.max_grade;
    }
    case "item_status_changed":
      return f.status === t.status && withinDays(f.daysInStatus, t.days);
    case "comp_price_moved":
      return compDriftMatches(f, t.direction, t.pct);
    // US-2236: never from the listing planner — see the union above. Returning
    // false here rather than omitting the case is deliberate: an omission would
    // fall through to whatever TypeScript's exhaustiveness left behind, and the
    // failure mode of a wrong answer here is an offer answered by the price-drop
    // engine.
    case "offer_threshold":
      return false;
    // US-2938: same refusal, same reason. An omission here would fall through
    // to whatever exhaustiveness left behind, and the failure mode is a RETURN
    // answered by the price-drop engine.
    case "return_threshold":
      return false;
    // US-2950: same refusal. The listing planner acts on ONE listing; letting
    // this reach it would drop each item’s price individually instead of
    // running one sale across the set.
    case "markdown_schedule":
      return false;
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
  | { kind: "end_listing" }
  // ── US-2156 ───────────────────────────────────────────────────
  | { kind: "relist" }
  | { kind: "crosslist"; platform: string }
  | { kind: "send_watcher_offer"; discountPct: number }
  | { kind: "advance_status"; status: string }
  | { kind: "notify"; message: string };

export interface PlanInput {
  currentCents: number;
  costBasisDollars: number | null;
  currentPromoRatePct: number | null;
  // ── US-2156 ─────────────────────────────────────────────────
  /** The item's current pipeline status — advance_status no-ops when equal. */
  currentStatus?: string | null;
  /**
   * Platforms this item already has a listing row on. crosslist_to is a no-op
   * for one that's already there, so a rule can't mint duplicate sibling rows
   * on every hourly run.
   */
  existingPlatforms?: readonly string[];
  /**
   * US-1967 negotiation capability for this deployment/connection. When false a
   * send_offer_to_watchers rule plans NOTHING — the seller sees no action rather
   * than a run of guaranteed 403s.
   */
  watcherOffersAvailable?: boolean;
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
    // ── US-2156 ───────────────────────────────────────────────
    case "relist":
      return { kind: "relist" };
    case "crosslist_to": {
      // Already listed there → nothing to do. Without this an hourly rule would
      // mint a fresh sibling row every pass.
      if ((i.existingPlatforms ?? []).includes(action.platform)) return null;
      return { kind: "crosslist", platform: action.platform };
    }
    case "send_offer_to_watchers": {
      if (i.watcherOffersAvailable !== true) return null;
      return { kind: "send_watcher_offer", discountPct: action.discount_pct };
    }
    case "advance_status": {
      if (i.currentStatus === action.status) return null;
      return { kind: "advance_status", status: action.status };
    }
    case "notify":
      return { kind: "notify", message: action.message };
  }
}
