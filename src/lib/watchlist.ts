// US-1806: condition-based alerts — pure helpers shared by the watchlist/saved-
// search hooks and (later) the matching engine's client mirror. No React, no
// Supabase — just the criteria-defaulting contract so every surface produces the
// same shape.

import type { BuyerPreferencesRow, SavedSearchInsert } from "@/types/database";

/** The editable criteria subset of a saved search (everything the matching
 *  engine filters on), separated from label/notify/state fields. */
export interface SavedSearchCriteria {
  brands: string[];
  categories: string[];
  sizes: Record<string, string[]>;
  keywords: string[];
  min_grade: number | null;
  max_price_cents: number | null;
}

export const EMPTY_SEARCH_CRITERIA: SavedSearchCriteria = {
  brands: [],
  categories: [],
  sizes: {},
  keywords: [],
  min_grade: null,
  max_price_cents: null,
};

/**
 * Seed a new saved search from the buyer's shopping preferences (US-1798). The
 * result is a starting point the buyer then edits — it is NOT kept in sync with
 * preferences afterward (a saved search is a snapshot). Returns the neutral
 * empty criteria when preferences are absent.
 */
export function defaultSearchCriteriaFromPreferences(
  prefs: BuyerPreferencesRow | null | undefined,
): SavedSearchCriteria {
  if (!prefs) return { ...EMPTY_SEARCH_CRITERIA, sizes: {} };
  // Deep-copy so the returned criteria is a true SNAPSHOT — editing it must
  // never write back through to the buyer's preferences (nested arrays too).
  const sizes: Record<string, string[]> = {};
  for (const [group, vals] of Object.entries(prefs.sizes ?? {})) {
    sizes[group] = [...(vals ?? [])];
  }
  return {
    brands: [...(prefs.followed_brands ?? [])],
    categories: [...(prefs.categories ?? [])],
    sizes,
    keywords: [],
    // A condition floor in preferences becomes the search's grade floor.
    min_grade: prefs.condition_floor ?? null,
    // Buyers shop within a band; the search only enforces a ceiling.
    max_price_cents: prefs.price_max_cents ?? null,
  };
}

/** Build a full saved-search insert from preference-derived defaults, ready to
 *  hand to the SPA upsert. Notify flags follow the buyer's global opt-ins. */
export function newSavedSearchFromPreferences(
  userId: string,
  prefs: BuyerPreferencesRow | null | undefined,
  label = "Saved search",
): SavedSearchInsert {
  return {
    user_id: userId,
    label,
    ...defaultSearchCriteriaFromPreferences(prefs),
    is_active: true,
    notify_email: prefs?.notify_email ?? true,
    notify_push: prefs?.notify_push ?? false,
  };
}

// ── Plan cap on active alerts (US-1805) ─────────────────────────────────────
//
// `BUYER_PLANS[plan].activeAlertsCap` is Free 3 / Guard 25 / Connoisseur
// unlimited. What follows is the CLIENT half: it keeps the UI honest about the
// limit the buyer was sold and stops them creating an alert that would never
// fire. It is NOT the enforcement — saved searches are written straight to
// Supabase under RLS, so anything client-side is advisory. The matching engine
// (services/edge-functions/src/lib/condition-alerts.ts, entitledSearchIds) is
// the authority: it only ever alerts on a buyer's `cap` oldest active searches.

export interface AlertCapState {
  /** The plan's cap, normalised. Meaningless when `unlimited`. */
  cap: number;
  unlimited: boolean;
  activeCount: number;
  /** How many more may be activated. `Infinity` when unlimited. */
  remaining: number;
  atCap: boolean;
}

/** Resolve the cap state for a buyer. PURE. Negative cap = unlimited. */
export function alertCapState(activeCount: number, cap: number): AlertCapState {
  const active = Math.max(0, Math.trunc(activeCount));
  if (cap < 0) {
    return {
      cap,
      unlimited: true,
      activeCount: active,
      remaining: Number.POSITIVE_INFINITY,
      atCap: false,
    };
  }
  const limit = Math.max(0, Math.trunc(cap));
  return {
    cap: limit,
    unlimited: false,
    activeCount: active,
    // `>=`, not `===`: a buyer who was downgraded is OVER the cap, not at it,
    // and must still be blocked from activating more.
    remaining: Math.max(0, limit - active),
    atCap: active >= limit,
  };
}

/** How many of a buyer's saved searches count against the cap. */
export function countActiveSearches(
  searches: ReadonlyArray<{ is_active: boolean }>,
): number {
  return searches.reduce((n, s) => (s.is_active ? n + 1 : n), 0);
}

/** Stable key for a watch target so a "watched?" lookup is O(1). */
export function watchTargetKey(
  targetType: "certificate" | "listing" | "passport",
  targetId: string,
): string {
  return `${targetType}:${targetId}`;
}
