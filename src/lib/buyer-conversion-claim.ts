// US-1843: buyer binding for the free public value tools — anonymous result →
// buyer signup → claim, without losing the result on the way.
//
// Two free tools end on a number a visitor already cares about: the
// /whats-it-worth Condition Index picker (US-849) and the /tools/grade-checker
// photo estimate (US-1687 + US-1751 value range). Both are top-of-funnel for the
// BUYER subscription, not just the seller one — "what's it worth" is the same
// question as "am I about to overpay". This module is the single place that
// carries that result across the signup boundary so a brand-new buyer account
// opens on the item they were looking at instead of an empty screen.
//
// Two deliberate properties:
//
//   1. It is CLIENT-ONLY. The anonymous half writes localStorage and calls no
//      endpoint, so the free tools' abuse controls (the edge rate limits in
//      front of the public grade-check endpoint) are untouched — this funnel
//      adds no new anonymous write for anyone to point a script at.
//   2. It records the affiliate code in force when the result was produced, so
//      an earned-link conversion stays attributable through the handoff. The
//      redeem itself still happens once, at sign-in (redeemStoredAffiliateRef in
//      use-auth) — this claim never clears the stored ref, it only copies it.

import { storedAffiliateRefCode } from "@/lib/affiliate";

/** Which conversion moment the visitor pressed on the free tool. */
export type BuyerConversionIntent = "save" | "alert" | "verify";

/** Which free tool produced the anonymous result. Attribution channel. */
export type BuyerConversionTool = "whats_it_worth" | "grade_checker";

/**
 * The anonymous result, in the widest shape both tools can fill. Every field is
 * nullable because the two tools know different things: the Condition Index
 * picker always has a slug + brand + label, the photo estimator always has a
 * grade + tier and only has a brand if the visitor typed one.
 */
export interface BuyerConversionResult {
  /** Condition Index slug, when the result came from the picker. */
  slug: string | null;
  /** Human label of what was priced, e.g. "Patagonia Better Sweater". */
  label: string;
  brand: string | null;
  /** Free-text item words the visitor typed (grade-checker). */
  keyword: string | null;
  grade: number | null;
  tier: string | null;
  medianCents: number | null;
  lowCents: number | null;
  highCents: number | null;
  currency: string;
  sampleSize: number | null;
}

export interface BuyerConversionClaim {
  v: 1;
  intent: BuyerConversionIntent;
  tool: BuyerConversionTool;
  result: BuyerConversionResult;
  /** Last-touch affiliate code at the moment of the result, or null. */
  ref: string | null;
  /** Epoch ms the claim was stashed. */
  ts: number;
}

/** The storage surface this module needs — injectable so it is unit-testable. */
export type ClaimStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const CLAIM_STORAGE_KEY = "gt_buyer_claim";

// A result older than this is stale market data, and re-showing it as "your
// estimate" would be quoting a price we no longer stand behind. Well inside the
// affiliate window (30d) so the claim never outlives its own attribution.
export const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function defaultStorage(): ClaimStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage blocked (private mode / partitioned iframe)
  }
}

function clampGrade(g: number | null | undefined): number | null {
  if (typeof g !== "number" || !Number.isFinite(g)) return null;
  return Math.min(10, Math.max(1, Math.round(g * 10) / 10));
}

function cents(n: number | null | undefined): number | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function text(s: string | null | undefined, max: number): string | null {
  const v = (s ?? "").trim();
  if (!v) return null;
  return v.slice(0, max);
}

/** Normalise a caller-supplied result into the stored shape. */
function normalizeResult(input: Partial<BuyerConversionResult>): BuyerConversionResult {
  return {
    slug: text(input.slug, 120),
    label: text(input.label, 160) ?? "Your item",
    brand: text(input.brand, 80),
    keyword: text(input.keyword, 120),
    grade: clampGrade(input.grade),
    tier: text(input.tier, 60),
    medianCents: cents(input.medianCents),
    lowCents: cents(input.lowCents),
    highCents: cents(input.highCents),
    currency: (text(input.currency, 8) ?? "USD").toUpperCase(),
    sampleSize:
      typeof input.sampleSize === "number" && Number.isFinite(input.sampleSize)
        ? Math.max(0, Math.trunc(input.sampleSize))
        : null,
  };
}

/**
 * Park an anonymous result + the conversion moment that was pressed. Overwrites
 * any earlier claim — the most recent result is the one the visitor is acting
 * on. Never throws; returns the claim it stored (or would have stored).
 */
export function stashBuyerClaim(
  input: {
    intent: BuyerConversionIntent;
    tool: BuyerConversionTool;
    result: Partial<BuyerConversionResult>;
  },
  storage: ClaimStorage | null = defaultStorage(),
  now: number = Date.now(),
): BuyerConversionClaim {
  const claim: BuyerConversionClaim = {
    v: 1,
    intent: input.intent,
    tool: input.tool,
    result: normalizeResult(input.result),
    ref: storedAffiliateRefCode(),
    ts: now,
  };
  try {
    storage?.setItem(CLAIM_STORAGE_KEY, JSON.stringify(claim));
  } catch {
    /* storage unavailable — the CTA still routes to signup, just without the
       handoff. Losing the result is better than blocking the conversion. */
  }
  return claim;
}

const INTENTS: BuyerConversionIntent[] = ["save", "alert", "verify"];
const TOOLS: BuyerConversionTool[] = ["whats_it_worth", "grade_checker"];

/**
 * Read the parked claim, or null when there is none / it is malformed / it has
 * aged out. Expired claims are deleted on read so a stale price can never be
 * re-shown later.
 */
export function readBuyerClaim(
  storage: ClaimStorage | null = defaultStorage(),
  now: number = Date.now(),
): BuyerConversionClaim | null {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(CLAIM_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: Partial<BuyerConversionClaim> | null = null;
  try {
    parsed = JSON.parse(raw) as Partial<BuyerConversionClaim>;
  } catch {
    clearBuyerClaim(storage);
    return null;
  }
  if (
    !parsed ||
    parsed.v !== 1 ||
    typeof parsed.ts !== "number" ||
    !INTENTS.includes(parsed.intent as BuyerConversionIntent) ||
    !TOOLS.includes(parsed.tool as BuyerConversionTool) ||
    !parsed.result ||
    typeof parsed.result !== "object"
  ) {
    clearBuyerClaim(storage);
    return null;
  }
  if (now - parsed.ts > CLAIM_TTL_MS) {
    clearBuyerClaim(storage);
    return null;
  }
  return {
    v: 1,
    intent: parsed.intent as BuyerConversionIntent,
    tool: parsed.tool as BuyerConversionTool,
    result: normalizeResult(parsed.result),
    ref: text(parsed.ref, 32),
    ts: parsed.ts,
  };
}

export function clearBuyerClaim(storage: ClaimStorage | null = defaultStorage()): void {
  try {
    storage?.removeItem(CLAIM_STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Where a conversion CTA points. Always the BUYER signup (`intent=buyer` →
 * account_type=buyer, US-1797), tagged with the tool and the moment so the
 * funnel is readable in analytics without a second event.
 */
export function buyerSignupHref(claim: {
  intent: BuyerConversionIntent;
  tool: BuyerConversionTool;
}): string {
  const q = new URLSearchParams({
    intent: "buyer",
    src: claim.tool,
    cta: claim.intent,
  });
  return `/signup?${q.toString()}`;
}

/**
 * The distinctive part of an item label — the label with the brand's own words
 * removed, e.g. ("Patagonia Better Sweater", "Patagonia") → "better sweater".
 * Empty when the label says nothing the brand doesn't already.
 */
export function distinctiveItemPhrase(
  label: string | null,
  brand: string | null,
): string {
  const l = (label ?? "").trim().toLowerCase();
  if (!l) return "";
  const brandWords = new Set(
    (brand ?? "")
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  );
  const rest = l
    .split(/\s+/)
    .filter((w) => w.length > 1 && !brandWords.has(w))
    .join(" ")
    .trim();
  return rest;
}

/** The saved-search criteria an "alert me" claim becomes (US-1806 shape). */
export interface ClaimSearchDraft {
  label: string;
  brands: string[];
  categories: string[];
  keywords: string[];
  min_grade: number | null;
  max_price_cents: number | null;
}

/**
 * Turn a claim into a saved search. The visitor already told us the three things
 * an alert needs — which item, what condition is acceptable, and what it is
 * worth — so nothing here is invented:
 *
 *   brands      ← the item's brand (exact match in the engine)
 *   keywords    ← ONE phrase, the label minus the brand. One, not many: keywords
 *                 are OR-ed and substring-matched, so splitting into words makes
 *                 the alert looser than the item the visitor picked.
 *   min_grade   ← the grade they chose — the condition floor they'd accept
 *   max_price   ← the typical (median) value at that grade — "at or under what
 *                 this is actually worth"
 *
 * Categories stay empty: neither tool asks for one, and guessing would silently
 * narrow the alert to nothing.
 */
export function searchDraftFromClaim(claim: BuyerConversionClaim): ClaimSearchDraft {
  const { result } = claim;
  const phrase = result.keyword?.toLowerCase().trim()
    || distinctiveItemPhrase(result.label, result.brand);
  return {
    label: result.label,
    brands: result.brand ? [result.brand] : [],
    categories: [],
    keywords: phrase ? [phrase] : [],
    min_grade: result.grade,
    max_price_cents: result.medianCents ?? result.highCents,
  };
}

/** The manual closet entry a "save this result" claim becomes (US-1825 shape). */
export interface ClaimClosetDraft {
  source: "manual";
  brand: string | null;
  title: string;
  condition_grade: number | null;
  notes: string | null;
}

/**
 * Turn a claim into a manual closet item. `closet_items` has no value column, so
 * the estimate rides in `notes` as prose that says where it came from and when —
 * a saved estimate with no date is a number nobody can judge later.
 */
export function closetDraftFromClaim(claim: BuyerConversionClaim): ClaimClosetDraft {
  const { result } = claim;
  const parts: string[] = [];
  if (result.medianCents != null) {
    parts.push(
      `Estimated ${formatClaimCents(result.medianCents, result.currency)}${
        result.grade != null ? ` at grade ${result.grade.toFixed(1)}` : ""
      }`,
    );
  } else if (result.grade != null) {
    parts.push(`Estimated grade ${result.grade.toFixed(1)}`);
  }
  parts.push(
    claim.tool === "whats_it_worth"
      ? "from the free What's It Worth tool"
      : "from the free grade checker",
  );
  parts.push(`on ${new Date(claim.ts).toISOString().slice(0, 10)}`);
  return {
    source: "manual",
    brand: result.brand,
    title: result.label,
    condition_grade: result.grade,
    notes: parts.join(" ") + ".",
  };
}

/** Format integer cents for claim copy. Mirrors formatCurveCents. */
export function formatClaimCents(value: number, currency = "USD"): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: value % 100 === 0 ? 0 : 2,
  }).format(value / 100);
}

/** One-line restatement of the claimed result, for the claim card. */
export function claimSummary(claim: BuyerConversionClaim): string {
  const { result } = claim;
  const bits: string[] = [result.label];
  if (result.grade != null) {
    bits.push(`grade ${result.grade.toFixed(1)}${result.tier ? ` (${result.tier})` : ""}`);
  }
  if (result.medianCents != null) {
    bits.push(`about ${formatClaimCents(result.medianCents, result.currency)}`);
  }
  return bits.join(" · ");
}
