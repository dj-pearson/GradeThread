// US-1843 — the anonymous "what's it worth" result must survive the signup
// boundary intact, stay attributable, and add nothing for a script to abuse.
//
// Three properties are asserted here, one per acceptance criterion:
//
//   1. NO LOSS. Everything the visitor saw comes back on the other side, and it
//      converts into the alert / closet entry they were actually promised.
//   2. ATTRIBUTION SURVIVES. The claim copies the earned-link code but never
//      consumes it — the single redeem at sign-in (US-603) still has a ref to
//      redeem, or the affiliate loses the conversion they earned.
//   3. NO NEW ANONYMOUS SURFACE. The whole anonymous half is localStorage. If
//      this ever starts calling the network, the free tools' rate limits are no
//      longer the only thing in front of an unauthenticated caller.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  buyerSignupHref,
  claimSummary,
  clearBuyerClaim,
  closetDraftFromClaim,
  distinctiveItemPhrase,
  readBuyerClaim,
  searchDraftFromClaim,
  stashBuyerClaim,
  CLAIM_STORAGE_KEY,
  CLAIM_TTL_MS,
  type BuyerConversionResult,
} from "@/lib/buyer-conversion-claim";
import { clearStoredAffiliateRef } from "@/lib/affiliate";

const AFFILIATE_KEY = "gt_affiliate_ref";

/** An in-memory ClaimStorage, so the cases don't fight over one jsdom global. */
function memStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    _map: map,
  };
}

const RESULT: BuyerConversionResult = {
  slug: "patagonia-better-sweater",
  label: "Patagonia Better Sweater",
  brand: "Patagonia",
  keyword: null,
  grade: 8,
  tier: "Excellent",
  medianCents: 8400,
  lowCents: 6900,
  highCents: 10500,
  currency: "USD",
  sampleSize: 42,
};

beforeEach(() => {
  clearStoredAffiliateRef();
  localStorage.removeItem(CLAIM_STORAGE_KEY);
});

describe("the handoff loses nothing", () => {
  it("round-trips every field the visitor was shown", () => {
    const s = memStorage();
    stashBuyerClaim({ intent: "alert", tool: "whats_it_worth", result: RESULT }, s, 1_000);
    const claim = readBuyerClaim(s, 2_000);
    expect(claim).not.toBeNull();
    expect(claim!.result).toEqual(RESULT);
    expect(claim!.intent).toBe("alert");
    expect(claim!.tool).toBe("whats_it_worth");
  });

  it("keeps the pressed conversion moment, so the account side can lead with it", () => {
    const s = memStorage();
    stashBuyerClaim({ intent: "verify", tool: "grade_checker", result: RESULT }, s);
    expect(readBuyerClaim(s)!.intent).toBe("verify");
  });

  it("clamps a nonsense grade rather than storing it", () => {
    const s = memStorage();
    stashBuyerClaim(
      { intent: "save", tool: "grade_checker", result: { ...RESULT, grade: 99 } },
      s,
    );
    expect(readBuyerClaim(s)!.result.grade).toBe(10);
  });

  it("survives a missing brand — the photo tool doesn't always have one", () => {
    const s = memStorage();
    stashBuyerClaim(
      {
        intent: "save",
        tool: "grade_checker",
        result: { label: "fleece jacket", grade: 7.5, tier: "Very Good", currency: "USD" },
      },
      s,
    );
    const claim = readBuyerClaim(s)!;
    expect(claim.result.brand).toBeNull();
    expect(claim.result.label).toBe("fleece jacket");
  });
});

describe("a claim ages out rather than quoting a stale price", () => {
  it("is gone once past the TTL, and deleted on the read that found it", () => {
    const s = memStorage();
    stashBuyerClaim({ intent: "alert", tool: "whats_it_worth", result: RESULT }, s, 0);
    expect(readBuyerClaim(s, CLAIM_TTL_MS + 1)).toBeNull();
    expect(s._map.has(CLAIM_STORAGE_KEY)).toBe(false);
  });

  it("is still there right up to the TTL", () => {
    const s = memStorage();
    stashBuyerClaim({ intent: "alert", tool: "whats_it_worth", result: RESULT }, s, 0);
    expect(readBuyerClaim(s, CLAIM_TTL_MS)).not.toBeNull();
  });

  it("drops garbage instead of throwing", () => {
    const s = memStorage();
    s.setItem(CLAIM_STORAGE_KEY, "{not json");
    expect(readBuyerClaim(s)).toBeNull();
    expect(s._map.has(CLAIM_STORAGE_KEY)).toBe(false);
  });

  it("rejects a claim from an unknown schema version", () => {
    const s = memStorage();
    s.setItem(CLAIM_STORAGE_KEY, JSON.stringify({ v: 2, intent: "alert", tool: "whats_it_worth", result: RESULT, ts: Date.now() }));
    expect(readBuyerClaim(s)).toBeNull();
  });

  it("clears on demand", () => {
    const s = memStorage();
    stashBuyerClaim({ intent: "save", tool: "whats_it_worth", result: RESULT }, s);
    clearBuyerClaim(s);
    expect(readBuyerClaim(s)).toBeNull();
  });
});

describe("attribution rides through the handoff", () => {
  it("stamps the earned-link code that was in force on the anonymous result", () => {
    localStorage.setItem(AFFILIATE_KEY, JSON.stringify({ code: "SELLER7", ts: Date.now() }));
    const s = memStorage();
    const claim = stashBuyerClaim({ intent: "alert", tool: "whats_it_worth", result: RESULT }, s);
    expect(claim.ref).toBe("SELLER7");
    expect(readBuyerClaim(s)!.ref).toBe("SELLER7");
  });

  it("does NOT consume the stored ref — sign-in still has one to redeem", () => {
    localStorage.setItem(AFFILIATE_KEY, JSON.stringify({ code: "SELLER7", ts: Date.now() }));
    const s = memStorage();
    stashBuyerClaim({ intent: "alert", tool: "whats_it_worth", result: RESULT }, s);
    readBuyerClaim(s);
    clearBuyerClaim(s);
    expect(localStorage.getItem(AFFILIATE_KEY)).toContain("SELLER7");
  });

  it("ignores an expired ref, matching what redeem would do with it", () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    localStorage.setItem(AFFILIATE_KEY, JSON.stringify({ code: "STALE1", ts: old }));
    const s = memStorage();
    expect(stashBuyerClaim({ intent: "save", tool: "grade_checker", result: RESULT }, s).ref).toBeNull();
  });

  it("records no ref when the visitor arrived unreferred", () => {
    const s = memStorage();
    expect(stashBuyerClaim({ intent: "save", tool: "grade_checker", result: RESULT }, s).ref).toBeNull();
  });
});

describe("the CTA routes into BUYER signup", () => {
  it("asks for the buyer role and tags the channel", () => {
    const href = buyerSignupHref({ intent: "alert", tool: "whats_it_worth" });
    const q = new URLSearchParams(href.split("?")[1]);
    expect(href.startsWith("/signup?")).toBe(true);
    // intent=buyer is what provisions account_type=buyer (US-1797). Without it
    // the funnel silently creates a SELLER account and the whole story is moot.
    expect(q.get("intent")).toBe("buyer");
    expect(q.get("src")).toBe("whats_it_worth");
    expect(q.get("cta")).toBe("alert");
  });
});

describe("the claim becomes something real", () => {
  it("builds an alert from what the visitor already told us", () => {
    const s = memStorage();
    stashBuyerClaim({ intent: "alert", tool: "whats_it_worth", result: RESULT }, s);
    const draft = searchDraftFromClaim(readBuyerClaim(s)!);
    expect(draft.brands).toEqual(["Patagonia"]);
    // ONE phrase, not one keyword per word: the engine ORs keywords and matches
    // by substring, so splitting would alert on every Patagonia anything.
    expect(draft.keywords).toEqual(["better sweater"]);
    expect(draft.min_grade).toBe(8);
    expect(draft.max_price_cents).toBe(8400);
    // Neither tool asks for a category; guessing one would narrow the alert to
    // nothing and look like a broken feature.
    expect(draft.categories).toEqual([]);
  });

  it("prefers the typed item words over the label when the tool has them", () => {
    const s = memStorage();
    stashBuyerClaim(
      {
        intent: "alert",
        tool: "grade_checker",
        result: { ...RESULT, keyword: "Fleece Jacket", label: "Patagonia Fleece Jacket" },
      },
      s,
    );
    expect(searchDraftFromClaim(readBuyerClaim(s)!).keywords).toEqual(["fleece jacket"]);
  });

  it("falls back to the high estimate when there is no median", () => {
    const s = memStorage();
    stashBuyerClaim(
      { intent: "alert", tool: "whats_it_worth", result: { ...RESULT, medianCents: null } },
      s,
    );
    expect(searchDraftFromClaim(readBuyerClaim(s)!).max_price_cents).toBe(10500);
  });

  it("leaves the price open when the result carried no value at all", () => {
    const s = memStorage();
    stashBuyerClaim(
      {
        intent: "alert",
        tool: "grade_checker",
        result: { label: "denim jacket", grade: 7, currency: "USD" },
      },
      s,
    );
    const draft = searchDraftFromClaim(readBuyerClaim(s)!);
    expect(draft.max_price_cents).toBeNull();
    expect(draft.brands).toEqual([]);
  });

  it("builds a closet entry whose note says what the number was and when", () => {
    const s = memStorage();
    const ts = Date.parse("2026-08-07T12:00:00Z");
    stashBuyerClaim({ intent: "save", tool: "whats_it_worth", result: RESULT }, s, ts);
    const draft = closetDraftFromClaim(readBuyerClaim(s, ts)!);
    expect(draft.source).toBe("manual");
    expect(draft.brand).toBe("Patagonia");
    expect(draft.title).toBe("Patagonia Better Sweater");
    expect(draft.condition_grade).toBe(8);
    expect(draft.notes).toContain("$84");
    expect(draft.notes).toContain("grade 8.0");
    expect(draft.notes).toContain("2026-08-07");
  });

  it("summarises the result for the copy that says it wasn't lost", () => {
    const s = memStorage();
    stashBuyerClaim({ intent: "save", tool: "whats_it_worth", result: RESULT }, s);
    const line = claimSummary(readBuyerClaim(s)!);
    expect(line).toContain("Patagonia Better Sweater");
    expect(line).toContain("8.0");
    expect(line).toContain("$84");
  });
});

describe("distinctiveItemPhrase", () => {
  it("drops the brand's own words", () => {
    expect(distinctiveItemPhrase("Patagonia Better Sweater", "Patagonia")).toBe("better sweater");
  });
  it("is empty when the label says nothing the brand doesn't", () => {
    expect(distinctiveItemPhrase("Patagonia", "Patagonia")).toBe("");
  });
  it("handles a multi-word brand", () => {
    expect(distinctiveItemPhrase("The North Face Nuptse", "The North Face")).toBe("nuptse");
  });
  it("survives a missing brand", () => {
    expect(distinctiveItemPhrase("Wool Overcoat", null)).toBe("wool overcoat");
  });
});

describe("the free tools' abuse controls are untouched", () => {
  it("the anonymous half makes no network call", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const s = memStorage();
    stashBuyerClaim({ intent: "alert", tool: "grade_checker", result: RESULT }, s);
    readBuyerClaim(s);
    buyerSignupHref({ intent: "alert", tool: "grade_checker" });
    clearBuyerClaim(s);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
