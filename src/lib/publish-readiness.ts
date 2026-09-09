// US-3202: per-channel publish readiness for the composer.
//
// The composer has always been able to tell a seller that a publish FAILED. It
// has never been able to tell them it was going to. Every check lived on the
// far side of the button: cross-push runs validateSiblingForPublish and returns
// 422, eBay runs its own preflight endpoint, and the seller finds out after
// pressing Publish on eight channels which three of them bounced.
//
// This module answers the same question BEFORE the press, and it does it by
// calling the same validator through the same projection
// (projectDraftFields + validateListingForPlatform, both in the mirrored
// marketplace-specs.ts), so the readout cannot become a second opinion. That is
// the whole design constraint: a preview that disagrees with reality is worse
// than no preview, because a seller who learns not to trust it will start
// ignoring the real blockers too.
//
// Pure. No fetching, no hooks. The eBay half arrives as an argument because
// eBay's real preflight is a server call that talks to eBay (US-1897), and this
// module is not the place to make it.

import {
  CROSS_LISTING_PLATFORMS,
  MARKETPLACE_LABELS,
  MARKETPLACE_MECHANISM,
  type CrossListingPlatform,
  type MarketplaceMechanism,
} from "./constants";
import {
  type CrossListDraft,
  getMarketplaceSpec,
  type MarketplacePlatform,
  projectDraftFields,
  validateListingForPlatform,
} from "./marketplace-specs";

/**
 * eBay caps aspect VALUES at 65 characters and rejects longer ones at publish,
 * not at upload — which is why the failure surfaces as an unrelated "already
 * has an active offer" (vault/30-platform/ebay-aspect-value-limit.md).
 *
 * capAspectValuesForEbay already truncates on the way out, so an over-long
 * value is NOT a blocker: the listing publishes with a shortened value. It is a
 * warning, because the seller wrote something they will not get back, and a
 * silent truncation is how a "Material" reads as "100% Cotton with a polyester
 * blend lining and a nylon" on the live listing.
 */
export const EBAY_ASPECT_VALUE_MAX_LEN = 65;

export type ReadinessStatus =
  /** Every check passes and GradeThread can publish it server-side. */
  | "ready"
  /** Every check passes, but the listing is created in the seller's own browser. */
  | "ready_in_browser"
  /** At least one error-level issue. This publish will not succeed as it stands. */
  | "blocked"
  /** We have no spec for this channel, so any answer would be a guess. */
  | "unchecked";

export interface ChannelReadiness {
  platform: CrossListingPlatform;
  label: string;
  status: ReadinessStatus;
  mechanism: MarketplaceMechanism;
  /** Error-level, in the validator's own wording. Empty unless status is "blocked". */
  blockers: string[];
  /** Advisory. Shown under the blockers, never instead of them. */
  warnings: string[];
  /** Why we cannot answer. Non-null only when status is "unchecked". */
  note: string | null;
}

/** The eBay-only signals this module cannot compute, supplied by the caller. */
export interface EbayPreflight {
  /** Blockers from POST /api/flipdesk/ebay/listings/validate. */
  blockers?: string[];
  /** Warnings from the same response. */
  warnings?: string[];
  /** Recommended aspects the leaf exposes and the draft leaves empty. */
  missingRecommendedAspects?: string[];
  /** The resolved item specifics, checked here against the 65-char ceiling. */
  aspects?: Record<string, string[]> | null;
  /**
   * False when the preflight has not run yet (no eBay category resolved, the
   * call failed, still loading). eBay then falls back to the spec check alone
   * and says so, rather than claiming a clean bill of health it has not earned.
   */
  ran?: boolean;
}

export interface ReadinessInput {
  /** The channels the seller has actually ticked. */
  platforms: readonly CrossListingPlatform[];
  draft: CrossListDraft;
  /** Photos that will be attached, checked against each spec's cap. */
  photoCount?: number;
  /** Per-platform draft overrides (an AI variant, a per-channel price). */
  overrides?: Partial<Record<CrossListingPlatform, Partial<CrossListDraft>>>;
  ebay?: EbayPreflight;
}

function hasSpec(platform: CrossListingPlatform): platform is CrossListingPlatform & MarketplacePlatform {
  return getMarketplaceSpec(platform) !== undefined;
}

/** Values longer than eBay will keep, as "Aspect: the value". */
export function overlongAspectValues(
  aspects: Record<string, string[]> | null | undefined,
): string[] {
  if (!aspects) return [];
  const out: string[] = [];
  for (const [name, values] of Object.entries(aspects)) {
    for (const v of values ?? []) {
      if (typeof v === "string" && v.length > EBAY_ASPECT_VALUE_MAX_LEN) {
        out.push(`${name} is ${v.length} characters — eBay will shorten it to ${EBAY_ASPECT_VALUE_MAX_LEN}`);
      }
    }
  }
  return out;
}

/** Order-preserving dedupe, so a blocker reported by both checks is shown once. */
function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.trim();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Readiness for a single channel.
 *
 * A channel we cannot actually reach returns "unchecked" rather than "ready" —
 * see the two guards below for the two ways that happens.
 */
export function readinessForChannel(
  platform: CrossListingPlatform,
  input: Omit<ReadinessInput, "platforms">,
): ChannelReadiness {
  const mechanism = MARKETPLACE_MECHANISM[platform] ?? "none";
  const label = MARKETPLACE_LABELS[platform] ?? platform;
  const base: Omit<ChannelReadiness, "status" | "blockers" | "warnings" | "note"> = {
    platform,
    label,
    mechanism,
  };

  // Two different reasons to refuse an answer, and both must refuse it.
  //
  // No spec is the obvious one. `mechanism === "none"` is the one that bites:
  // Whatnot HAS a spec (title cap, conditions, photo cap) and no listing path
  // at all — every adapter method is notImplemented (US-2327). Validating its
  // fields would produce a confident "ready" for a channel that cannot receive
  // a listing, which is exactly the claim MARKETPLACE_MECHANISM exists to stop.
  if (!hasSpec(platform)) {
    return {
      ...base,
      status: "unchecked",
      blockers: [],
      warnings: [],
      note: `We have no listing spec for ${label}, so we can't check this one before you publish.`,
    };
  }
  if (mechanism === "none") {
    return {
      ...base,
      status: "unchecked",
      blockers: [],
      warnings: [],
      note: `GradeThread has no listing path to ${label} yet, so there's nothing to check.`,
    };
  }

  const merged: CrossListDraft = { ...input.draft, ...(input.overrides?.[platform] ?? {}) };
  const result = validateListingForPlatform(
    platform,
    projectDraftFields(platform, merged),
    { photoCount: input.photoCount },
  );

  const blockers = result.issues.filter((i) => i.level === "error").map((i) => i.message);
  const warnings = result.issues.filter((i) => i.level === "warning").map((i) => i.message);

  if (platform === "ebay") {
    const eb = input.ebay;
    if (eb?.ran) {
      blockers.push(...(eb.blockers ?? []));
      warnings.push(...(eb.warnings ?? []));
      for (const name of eb.missingRecommendedAspects ?? []) {
        warnings.push(`${name} is empty — eBay recommends it for this category`);
      }
      warnings.push(...overlongAspectValues(eb.aspects));
    } else {
      warnings.push(
        "eBay's own check hasn't run yet — pick a category to see required item specifics.",
      );
    }
  }

  const finalBlockers = dedupe(blockers);
  const finalWarnings = dedupe(warnings);

  if (finalBlockers.length > 0) {
    return { ...base, status: "blocked", blockers: finalBlockers, warnings: finalWarnings, note: null };
  }
  return {
    ...base,
    // An extension channel passing every field check still isn't something we
    // can publish; the seller's browser does that. Saying "ready" flat would be
    // the honesty problem in ADR §4, one screen earlier.
    status: mechanism === "extension" ? "ready_in_browser" : "ready",
    blockers: [],
    warnings: finalWarnings,
    note: null,
  };
}

/** Readiness for every selected channel, in CROSS_LISTING_PLATFORMS order. */
export function readinessForChannels(input: ReadinessInput): ChannelReadiness[] {
  const selected = new Set<CrossListingPlatform>(input.platforms);
  return CROSS_LISTING_PLATFORMS.filter((p) => selected.has(p)).map((p) =>
    readinessForChannel(p, input),
  );
}

export interface ReadinessSummary {
  ready: number;
  blocked: number;
  unchecked: number;
  /** True when at least one selected channel will not publish as it stands. */
  anyBlocked: boolean;
}

export function summarizeReadiness(rows: readonly ChannelReadiness[]): ReadinessSummary {
  let ready = 0;
  let blocked = 0;
  let unchecked = 0;
  for (const r of rows) {
    if (r.status === "blocked") blocked += 1;
    else if (r.status === "unchecked") unchecked += 1;
    else ready += 1;
  }
  return { ready, blocked, unchecked, anyBlocked: blocked > 0 };
}
