// Pure helpers for repricing automation (US-672): input validation for the CRUD
// route, and the rule-evaluation math the runner uses (markdown, floor clamp,
// due-by-interval, scope match, and the final price decision). No DB/network
// here so all of it is unit-tested directly.

export const RULE_NAME_MAX = 80;
export const MAX_DROP_PCT = 90;

export interface NormalizedRule {
  name: string;
  enabled: boolean;
  inventory_item_id: string | null;
  filter_brand: string | null;
  filter_category_id: string | null;
  min_age_days: number;
  drop_pct: number;
  interval_days: number;
  floor_price_cents: number | null;
  auto_accept_confidence: number | null;
  /** US-9205: may the rule move a price the seller set by hand? Default no. */
  override_manual: boolean;
}

export type NormalizeResult =
  | { ok: true; value: NormalizedRule }
  | { ok: false; error: string };

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

function intOrDefault(v: unknown, fallback: number, min: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.trunc(v));
}

function nonNegIntOrNull(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.max(0, Math.trunc(v));
}

/** Validate + normalize a create/update payload (snake_case wire shape). */
export function normalizeRuleInput(body: unknown): NormalizeResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid rule payload" };
  }
  const b = body as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) return { ok: false, error: "Rule name is required" };
  if (name.length > RULE_NAME_MAX) {
    return { ok: false, error: `Rule name must be ${RULE_NAME_MAX} characters or fewer` };
  }

  const dropRaw = typeof b.drop_pct === "number" && Number.isFinite(b.drop_pct) ? b.drop_pct : 0;
  const drop_pct = Math.min(Math.max(dropRaw, 0), MAX_DROP_PCT);

  let auto: number | null = null;
  if (typeof b.auto_accept_confidence === "number" && Number.isFinite(b.auto_accept_confidence)) {
    auto = Math.min(Math.max(b.auto_accept_confidence, 0), 1);
  }

  // A rule must actually DO something.
  if (drop_pct === 0 && auto === null) {
    return { ok: false, error: "Set a drop % or an auto-accept confidence so the rule has an effect" };
  }

  return {
    ok: true,
    value: {
      name,
      enabled: b.enabled !== false, // default on
      inventory_item_id: trimOrNull(b.inventory_item_id),
      filter_brand: trimOrNull(b.filter_brand),
      filter_category_id: trimOrNull(b.filter_category_id),
      min_age_days: intOrDefault(b.min_age_days, 0, 0),
      drop_pct,
      interval_days: intOrDefault(b.interval_days, 7, 1),
      floor_price_cents: nonNegIntOrNull(b.floor_price_cents),
      auto_accept_confidence: auto,
      override_manual: b.override_manual === true,
    },
  };
}

/** Drop `currentCents` by `dropPct`%, never below the floor (or 0). */
export function computeMarkdownCents(
  currentCents: number,
  dropPct: number,
  floorCents: number | null,
): number {
  const dropped = Math.floor(currentCents * (1 - dropPct / 100));
  return Math.max(dropped, floorCents ?? 0);
}

/** True when `intervalDays` have elapsed since the last action (or listing date). */
export function isDue(
  lastActionISO: string | null,
  listedAtISO: string | null,
  intervalDays: number,
  now: Date,
): boolean {
  const anchor = lastActionISO ?? listedAtISO;
  if (!anchor) return true; // never acted + unknown list date → eligible
  const t = new Date(anchor).getTime();
  if (!Number.isFinite(t)) return true;
  const days = (now.getTime() - t) / 86_400_000;
  return days >= intervalDays;
}

export interface RuleScope {
  inventory_item_id: string | null;
  filter_brand: string | null;
  filter_category_id: string | null;
  min_age_days: number;
}

export interface ListingFacts {
  inventoryItemId: string;
  brand: string | null;
  /** Effective category: listing.platform_category_id ?? item.ebay_category_id. */
  categoryId: string | null;
  ageDays: number;
}

/** Whether a rule's scope/filters select this listing. */
export function ruleMatchesListing(scope: RuleScope, l: ListingFacts): boolean {
  if (scope.inventory_item_id && scope.inventory_item_id !== l.inventoryItemId) {
    return false;
  }
  if (
    scope.filter_brand &&
    (l.brand ?? "").trim().toLowerCase() !== scope.filter_brand.trim().toLowerCase()
  ) {
    return false;
  }
  if (scope.filter_category_id && scope.filter_category_id !== (l.categoryId ?? "")) {
    return false;
  }
  if (scope.min_age_days > 0 && l.ageDays < scope.min_age_days) {
    return false;
  }
  return true;
}

export interface RuleDecisionInput {
  currentCents: number;
  dropPct: number;
  floorCents: number | null;
  autoAcceptConfidence: number | null;
  suggestion?: { suggestedPriceCents: number; confidence: number | null } | null;
}

export interface RuleDecision {
  newCents: number;
  reason: "scheduled_markdown" | "auto_accept";
}

/**
 * Decide the new price for a due listing — or null for no-op. Automation only
 * ever LOWERS prices: a high-confidence comp suggestion is auto-accepted when
 * it's a cut; otherwise a flat scheduled markdown applies. Either way the result
 * is clamped to the floor and must come out strictly below the current price.
 */
export function decideNewPriceCents(i: RuleDecisionInput): RuleDecision | null {
  if (i.currentCents <= 0) return null;

  if (
    i.autoAcceptConfidence != null &&
    i.suggestion &&
    (i.suggestion.confidence ?? 0) >= i.autoAcceptConfidence &&
    i.suggestion.suggestedPriceCents < i.currentCents
  ) {
    const clamped = i.floorCents != null
      ? Math.max(i.suggestion.suggestedPriceCents, i.floorCents)
      : i.suggestion.suggestedPriceCents;
    if (clamped < i.currentCents) return { newCents: clamped, reason: "auto_accept" };
  }

  if (i.dropPct > 0) {
    const next = computeMarkdownCents(i.currentCents, i.dropPct, i.floorCents);
    if (next < i.currentCents) return { newCents: next, reason: "scheduled_markdown" };
  }

  return null;
}

/**
 * US-9205: a repricing rule never overrides a manual price unless it says it
 * may. `price_set_by = "seller"` is the seller's own decision on that listing
 * (typed over the graded prefill, or set with no prefill at all); every other
 * value, including NULL on rows older than the column, is fair game.
 */
export function ruleMayReprice(
  rule: { override_manual: boolean },
  listing: { price_set_by: string | null | undefined },
): boolean {
  if (listing.price_set_by !== "seller") return true;
  return rule.override_manual === true;
}
