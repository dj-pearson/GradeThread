// US-3088: the anonymous listing-draft tool — PURE half.
//
// One to three photos in, a marketplace-ready title, item specifics and a
// description out. Nothing is stored: no image, no draft, no row.
//
// Extracted out of routes/public-grading.ts for the same reason
// lib/extension-scan.ts was — the route's dependency graph (hono, supabase, the
// eBay client) is what makes its logic effectively untestable outside CI. The
// route keeps the I/O: the rate-limit window, the AI budget reservation, the
// image hardening and the model call. Everything below is a pure function of
// what it hands back.
//
// ── WHAT THIS IS AND IS NOT ──────────────────────────────────────────────────
//
// It is the AutoLister prompt, run once, for a stranger who searched for an
// "ebay listing template" and landed on /tools/listing-generator. Seeing the
// product write the listing beats reading a template, which is the whole point
// of the surface.
//
// It is NOT the paid path with the account bits removed. Three things are
// deliberately absent from the response and each has its own reason:
//
//   • no price, because a price we can defend comes from condition-matched
//     comps and those are tenant-scoped (US-268) — an unauthenticated caller
//     has no workspace to scope to, and a number with nothing behind it is
//     worse than no number on the surface where a stranger meets us first;
//   • no eBay category id, because resolving one costs a Taxonomy call and the
//     id is only useful to somebody who is about to publish through us;
//   • no comps, for both of the above reasons at once.
//
// The description is rendered through description-blocks.ts, the same renderer
// the paid draft uses, so the free output is in the house style rather than a
// second format that drifts. The blocks that need an account — the seller
// credential, the grade, the disclosure — render empty and drop out, which is
// what `defaultBlocks()` already does when the RenderContext carries no grade.

import {
  defaultBlocks,
  type DescriptionBlock,
  renderDescription,
  type RenderContext,
  scrubRestatedFacts,
} from "./description-blocks.ts";
import { getMarketplaceSpec, type MarketplacePlatform } from "./marketplace-specs.ts";
import { lintTitle } from "./title-lint.ts";
import { trimTitleWithReport } from "./title-trim.ts";

/** The four marketplaces the free tool writes for. */
export const FREE_DRAFT_TARGETS = ["ebay", "poshmark", "mercari", "depop"] as const;
export type FreeDraftTarget = (typeof FREE_DRAFT_TARGETS)[number];

/** Photos accepted in one call. The client caps too; this is the authority. */
export const FREE_DRAFT_MAX_IMAGES = 3;

/**
 * Per-image byte cap, matching /tag-read rather than the 10 MB grading default.
 * An anonymous endpoint takes smaller input.
 */
export const FREE_DRAFT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * The A/B selection key handed to `generateListingFields`. The paid path passes
 * the item id so champion-vs-challenger is deterministic PER ITEM; there is no
 * item here, so one constant key puts the whole free surface on one side of any
 * live trial. That is the honest choice: a trial split across anonymous traffic
 * would be measured against a population with no conversion event attached.
 */
export const FREE_DRAFT_PROMPT_SELECT_KEY = "free-listing-draft";

/** Spend attribution slug, so this reads as its own line in the AI ledger. */
export const FREE_DRAFT_AI_FEATURE = "free_listing_draft";

export const FREE_DRAFT_DISCLAIMER =
  "Written by AI from your photos. Check the size, brand and condition against " +
  "the item before you list it. The words are a starting point, not a claim " +
  "GradeThread has verified.";

/** Longest operator-supplied hint we keep. Longer is padding, not context. */
const HINT_MAX = 80;

/** Machine-readable rejection codes, so the page can say WHICH input was wrong. */
export type FreeDraftErrorCode =
  | "bad_body"
  | "no_images"
  | "too_many_images"
  | "bad_image"
  | "bad_target";

export interface FreeDraftInput {
  /** Image data URLs, already length-checked. Hardening happens in the route. */
  images: string[];
  target: FreeDraftTarget;
  brand?: string;
  size?: string;
  condition?: string;
}

export type FreeDraftParse =
  | ({ ok: true } & FreeDraftInput)
  | { ok: false; code: FreeDraftErrorCode; error: string };

function hint(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().slice(0, HINT_MAX);
  return t === "" ? undefined : t;
}

export function isFreeDraftTarget(v: unknown): v is FreeDraftTarget {
  return typeof v === "string" && (FREE_DRAFT_TARGETS as readonly string[]).includes(v);
}

/**
 * Validate the request body. Mirrors `parseScanBody` in extension-scan.ts, with
 * one deliberate difference: a malformed image is a REJECTION, not a dropped
 * element. The scan endpoint degrades one card out of twenty-four; here there
 * are at most three photos and silently ignoring one would have the model
 * describe a garment the caller cannot see it was shown.
 */
export function parseFreeDraftBody(body: unknown): FreeDraftParse {
  if (!body || typeof body !== "object") {
    return { ok: false, code: "bad_body", error: "Send a JSON body." };
  }
  const b = body as Record<string, unknown>;

  if (!isFreeDraftTarget(b.target)) {
    return {
      ok: false,
      code: "bad_target",
      error: `Pick a marketplace: ${FREE_DRAFT_TARGETS.join(", ")}.`,
    };
  }

  if (!Array.isArray(b.images)) {
    return { ok: false, code: "no_images", error: "Provide an images array." };
  }
  if (b.images.length === 0) {
    return { ok: false, code: "no_images", error: "Add at least one photo." };
  }
  // Checked BEFORE the per-image shape check so a caller who sent thirty photos
  // is told the cap rather than told the fourth one is malformed.
  if (b.images.length > FREE_DRAFT_MAX_IMAGES) {
    return {
      ok: false,
      code: "too_many_images",
      error: `Send up to ${FREE_DRAFT_MAX_IMAGES} photos.`,
    };
  }
  const images: string[] = [];
  for (const raw of b.images) {
    if (typeof raw !== "string" || !raw.startsWith("data:image/")) {
      return {
        ok: false,
        code: "bad_image",
        error: "Each photo must be an image data URL.",
      };
    }
    images.push(raw);
  }

  return {
    ok: true,
    images,
    target: b.target,
    brand: hint(b.brand),
    size: hint(b.size),
    condition: hint(b.condition),
  };
}

/**
 * The title limit for a target, read from MARKETPLACE_SPECS rather than typed
 * here. Null for Depop, which has no separate title field at all — its listing
 * text IS the description, so there is no limit to cut to and the response says
 * so instead of inventing one.
 */
export function freeDraftTitleLimit(target: FreeDraftTarget): number | null {
  return getMarketplaceSpec(target as MarketplacePlatform)?.titleMaxLength ?? null;
}

/**
 * How many times `policyCleanTitle` will strip and re-lint.
 *
 * There are six comparison patterns and each pass removes EVERY occurrence of
 * the phrase one of them matched, so six passes clears any title where the
 * strips are independent. The extra two cover the case where removing a phrase
 * closes a gap and forms a new match ("compared compared to to X"), which is
 * pathological but not impossible. The loop is capped rather than trusted to
 * converge, and the post-condition below is what actually holds.
 */
const POLICY_STRIP_PASSES = 8;

/** Pull the phrase lintTitle quoted back out of its message. */
function quotedPhrase(violation: string): string | null {
  const m = violation.match(/"([^"]+)"/);
  return m?.[1] ?? null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Return a title with ZERO lintTitle policy violations.
 *
 * AC5 is an absolute: an eBay title this endpoint returns must lint clean. A
 * policy violation is a search-manipulation phrase ("in the style of Nike"),
 * which eBay blocks on publish — handing one to a stranger as our sample output
 * would be teaching the thing we exist to stop.
 *
 * Order of preference:
 *   1. the primary title, if it is already clean;
 *   2. the model's own alternate (title_variant), which costs nothing extra and
 *      is a real second phrasing rather than a mutilated first one;
 *   3. the primary with the offending phrases stripped.
 *
 * If all three still violate, the result is the EMPTY STRING, which lints clean
 * by construction (lintTitle returns early on an empty title). The caller
 * treats that as a failed draft rather than shipping a title it cannot defend.
 * That branch has never been reached by a real model response; it exists so the
 * post-condition is a guarantee and not a hope.
 */
export function policyCleanTitle(primary: string, variant?: string): string {
  const candidates = [primary, variant ?? ""].map((t) => (t ?? "").trim()).filter(Boolean);
  for (const candidate of candidates) {
    if (lintTitle(candidate).policyViolations.length === 0) return candidate;
  }

  let working = (primary ?? "").trim();
  for (let pass = 0; pass < POLICY_STRIP_PASSES; pass++) {
    const violations = lintTitle(working).policyViolations;
    if (violations.length === 0) return working;
    const phrase = quotedPhrase(violations[0] ?? "");
    if (!phrase) break;
    const stripped = working
      .replace(new RegExp(escapeRegExp(phrase), "gi"), " ")
      .replace(/\s+/g, " ")
      .trim();
    // No progress means the strip cannot converge; stop rather than spin.
    if (stripped === working) break;
    working = stripped;
  }
  return lintTitle(working).policyViolations.length === 0 ? working : "";
}

export interface FreeDraftTitle {
  text: string;
  /** The marketplace's own limit, or null when it has no title field. */
  limit: number | null;
  /** True when words were dropped to fit `limit`. */
  trimmed: boolean;
  /** Non-blocking quality notes from lintTitle — never policy violations. */
  warnings: string[];
}

/**
 * The title for one target: policy-cleaned, then trimmed to that marketplace's
 * limit on word boundaries (title-trim.ts), never mid-word.
 *
 * Depop is the shape that makes this worth a function. Its spec carries
 * titleMaxLength null because the platform has no title field, so there is
 * nothing to trim to; the response returns the untrimmed line with limit null
 * and the page renders it as the opening of the listing text.
 */
export function buildFreeDraftTitle(
  primary: string,
  variant: string | undefined,
  target: FreeDraftTarget,
): FreeDraftTitle {
  const clean = policyCleanTitle(primary, variant);
  const limit = freeDraftTitleLimit(target);
  if (limit == null) {
    return { text: clean, limit: null, trimmed: false, warnings: lintTitle(clean).warnings };
  }
  const { title, trimmed } = trimTitleWithReport(clean, limit);
  // Re-lint AFTER the trim: dropping the tail can strand a duplicate or leave a
  // shouted acronym as the only word, and the warnings the caller renders must
  // describe the title it is actually being handed.
  return { text: title, limit, trimmed, warnings: lintTitle(title).warnings };
}

/** The three prose fields the model writes, before scrubbing. */
export interface FreeDraftProse {
  intro: string;
  features: string;
  condition: string;
}

/**
 * Build the render context for an anonymous draft.
 *
 * `grade: null` is the load-bearing line. It is what makes the grade,
 * disclosure and facts blocks render empty and drop out, which is exactly what
 * should happen — this caller has no graded item, and a facts block with no
 * facts would be an empty heading in the sample output.
 */
export function freeDraftRenderContext(input: FreeDraftInput): RenderContext {
  return {
    item: {
      brand: input.brand ?? null,
      size: input.size ?? null,
      color: null,
      material: null,
      style: null,
    },
    grade: null,
    credential: null,
    snippets: {},
    unit: "in",
    conditionDescription: input.condition ?? null,
  };
}

/**
 * The blocks a free draft renders: the paid default order, with the model's
 * prose scrubbed of facts a derived block already carries.
 *
 * `scrubRestatedFacts` is the same backstop the paid path uses. It matters more
 * here, not less: the attributes block prints the brand and size the caller
 * typed, so an intro that repeats them reads as padding on the one page where a
 * stranger is deciding whether the output is any good.
 */
export function freeDraftBlocks(prose: FreeDraftProse, ctx: RenderContext): DescriptionBlock[] {
  const byKey: Record<string, string> = {
    intro: prose.intro,
    features: prose.features,
    condition: prose.condition,
  };
  return defaultBlocks().map((block) => {
    const raw = byKey[block.key];
    if (raw === undefined) return block;
    return { ...block, text: scrubRestatedFacts(raw, ctx) };
  });
}

export interface FreeDraftResponse {
  target: FreeDraftTarget;
  title: FreeDraftTitle;
  itemSpecifics: Record<string, string[]>;
  description: string;
  /** The platform's description limit, so the page can meter what it renders. */
  descriptionLimit: number | null;
  conditionNote: string;
  disclaimer: string;
}

/** The model's output, narrowed to the fields this surface is allowed to use. */
export interface FreeDraftListing {
  title: string;
  title_variant?: string;
  description_intro: string;
  description_features: string;
  description_condition: string;
  condition_description: string;
  item_specifics: Record<string, string[]>;
}

/**
 * Shape the model's listing for an anonymous caller.
 *
 * The narrowing is the point. `FreeDraftListing` names the six fields this
 * surface may read, so a future field on GeneratedListing — a price, a category
 * id, a comp set — cannot reach an unauthenticated response by being added
 * upstream. Widening this interface is a deliberate act with a reason.
 */
export function shapeFreeDraft(
  listing: FreeDraftListing,
  input: FreeDraftInput,
): FreeDraftResponse {
  const ctx = freeDraftRenderContext(input);
  const blocks = freeDraftBlocks(
    {
      intro: listing.description_intro ?? "",
      features: listing.description_features ?? "",
      condition: listing.description_condition ?? "",
    },
    ctx,
  );
  const spec = getMarketplaceSpec(input.target as MarketplacePlatform);
  return {
    target: input.target,
    title: buildFreeDraftTitle(listing.title ?? "", listing.title_variant, input.target),
    itemSpecifics: listing.item_specifics ?? {},
    description: renderDescription(blocks, ctx),
    descriptionLimit: spec?.descriptionMaxLength ?? null,
    conditionNote: (listing.condition_description ?? "").trim(),
    disclaimer: FREE_DRAFT_DISCLAIMER,
  };
}

/**
 * The one log line this endpoint writes, built as a string so a test can assert
 * what is NOT in it.
 *
 * Cost per call has to be measurable from the log, because nothing is stored —
 * there is no row to count later. So the line carries the target, the photo
 * count, the model latency and the lint outcome, and it carries NEITHER the
 * title text nor anything derived from the image. "Nothing stored" would be a
 * false claim if the answer were sitting in a log line instead.
 */
export function freeDraftLogLine(fields: {
  target: FreeDraftTarget;
  imageCount: number;
  latencyMs: number;
  titleTrimmed: boolean;
  warningCount: number;
  policyClean: boolean;
}): string {
  return [
    "[free-listing-draft]",
    `target=${fields.target}`,
    `images=${fields.imageCount}`,
    `latency_ms=${Math.round(fields.latencyMs)}`,
    `title_trimmed=${fields.titleTrimmed}`,
    `title_warnings=${fields.warningCount}`,
    `policy_clean=${fields.policyClean}`,
  ].join(" ");
}
