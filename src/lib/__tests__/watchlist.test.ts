import { describe, expect, it } from "vitest";
import {
  alertCapState,
  countActiveSearches,
  defaultSearchCriteriaFromPreferences,
  EMPTY_SEARCH_CRITERIA,
  newSavedSearchFromPreferences,
  watchTargetKey,
} from "@/lib/watchlist";
import { BUYER_PLANS } from "@/lib/constants";
import type { BuyerPreferencesRow } from "@/types/database";

function prefs(overrides: Partial<BuyerPreferencesRow> = {}): BuyerPreferencesRow {
  return {
    user_id: "u1",
    followed_brands: ["Nike", "Levi's"],
    categories: ["tops"],
    sizes: { tops: ["M", "L"] },
    price_min_cents: 1000,
    price_max_cents: 6000,
    condition_floor: 8,
    unit_preference: "in",
    notify_email: true,
    notify_push: true,
    digest_frequency: "daily",
    quiet_hours_start: null,
    quiet_hours_end: null,
    onboarding_completed_at: null,
    created_at: "2026-07-09T00:00:00Z",
    updated_at: "2026-07-09T00:00:00Z",
    ...overrides,
  };
}

describe("defaultSearchCriteriaFromPreferences", () => {
  it("returns neutral empty criteria when preferences are absent", () => {
    expect(defaultSearchCriteriaFromPreferences(null)).toEqual(EMPTY_SEARCH_CRITERIA);
    expect(defaultSearchCriteriaFromPreferences(undefined)).toEqual(EMPTY_SEARCH_CRITERIA);
  });

  it("seeds brands/categories/sizes and maps condition_floor + price ceiling", () => {
    const c = defaultSearchCriteriaFromPreferences(prefs());
    expect(c.brands).toEqual(["Nike", "Levi's"]);
    expect(c.categories).toEqual(["tops"]);
    expect(c.sizes).toEqual({ tops: ["M", "L"] });
    expect(c.min_grade).toBe(8);
    expect(c.max_price_cents).toBe(6000);
    // Keywords are never seeded from preferences.
    expect(c.keywords).toEqual([]);
  });

  it("does not alias preference arrays/objects (snapshot, not live binding)", () => {
    const p = prefs();
    const c = defaultSearchCriteriaFromPreferences(p);
    c.brands.push("Adidas");
    (c.sizes.tops as string[]).push("XL");
    expect(p.followed_brands).toEqual(["Nike", "Levi's"]);
    expect(p.sizes.tops).toEqual(["M", "L"]);
  });

  it("leaves grade/price null when preferences omit them", () => {
    const c = defaultSearchCriteriaFromPreferences(
      prefs({ condition_floor: null, price_max_cents: null }),
    );
    expect(c.min_grade).toBeNull();
    expect(c.max_price_cents).toBeNull();
  });
});

describe("newSavedSearchFromPreferences", () => {
  it("builds an active insert carrying the buyer's notify opt-ins", () => {
    const s = newSavedSearchFromPreferences("u1", prefs({ notify_push: false }), "My search");
    expect(s.user_id).toBe("u1");
    expect(s.label).toBe("My search");
    expect(s.is_active).toBe(true);
    expect(s.notify_email).toBe(true);
    expect(s.notify_push).toBe(false);
    expect(s.brands).toEqual(["Nike", "Levi's"]);
  });

  it("defaults notify flags on when preferences are absent", () => {
    const s = newSavedSearchFromPreferences("u2", null);
    expect(s.label).toBe("Saved search");
    expect(s.notify_email).toBe(true);
    expect(s.notify_push).toBe(false);
    expect(s.brands).toEqual([]);
  });
});

describe("watchTargetKey", () => {
  it("is stable and type-scoped so a cert and listing with the same id differ", () => {
    expect(watchTargetKey("certificate", "abc")).toBe("certificate:abc");
    expect(watchTargetKey("certificate", "abc")).not.toBe(watchTargetKey("listing", "abc"));
  });
});

// US-1805: the plan cap on concurrently-active alerts. This is the CLIENT half
// (honest UI); the engine's entitledSearchIds is the enforcement.
describe("alertCapState", () => {
  it("counts remaining room and flags the cap on a limited plan", () => {
    expect(alertCapState(0, 3)).toMatchObject({ remaining: 3, atCap: false, unlimited: false });
    expect(alertCapState(2, 3)).toMatchObject({ remaining: 1, atCap: false });
    expect(alertCapState(3, 3)).toMatchObject({ remaining: 0, atCap: true });
  });

  it("treats a DOWNGRADED buyer (over the cap) as capped, not as having room", () => {
    // Connoisseur → Free with 9 active alerts. `>=` is what makes this true; an
    // `===` check would leave the create button live and remaining negative.
    const state = alertCapState(9, 3);
    expect(state.atCap).toBe(true);
    expect(state.remaining).toBe(0);
  });

  it("never caps an unlimited plan", () => {
    const state = alertCapState(500, -1);
    expect(state.unlimited).toBe(true);
    expect(state.atCap).toBe(false);
    expect(state.remaining).toBe(Number.POSITIVE_INFINITY);
  });

  it("a cap of zero blocks everything", () => {
    expect(alertCapState(0, 0)).toMatchObject({ atCap: true, remaining: 0 });
  });

  it("matches the advertised buyer plan matrix", () => {
    expect(alertCapState(3, BUYER_PLANS.free.activeAlertsCap).atCap).toBe(true);
    expect(alertCapState(3, BUYER_PLANS.guard.activeAlertsCap).atCap).toBe(false);
    expect(alertCapState(9999, BUYER_PLANS.connoisseur.activeAlertsCap).atCap).toBe(false);
  });
});

describe("countActiveSearches", () => {
  it("counts only active searches — a paused search frees a slot", () => {
    expect(
      countActiveSearches([
        { is_active: true },
        { is_active: false },
        { is_active: true },
      ]),
    ).toBe(2);
    expect(countActiveSearches([])).toBe(0);
  });
});
