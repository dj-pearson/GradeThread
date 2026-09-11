// The extension marketplaces' description, rendered the same way eBay's is.
//
// WHY THIS EXISTS. eBay's description is BLOCKS (description-blocks.ts): the
// prose is stored, the facts are derived, and correcting a measurement or a
// colour changes what publishes without anyone rewriting anything. The
// extension channels — Poshmark, Mercari, Grailed, Vinted, Facebook — had none
// of that. generatePlatformVariants wrote one frozen string per platform and
// appended the credential and measurement sections INTO it, so the only way to
// pick up an edit was to spend another AI call on "Generate for all
// marketplaces". A seller who fixed a chest measurement was left with four
// live listings advertising the old number.
//
// THE SPLIT. Everything derived — attributes, measurements, grade, disclosure,
// credentials — comes from the same RenderContext eBay renders from, at the
// moment the payload is built. One item edit therefore moves every channel at
// once.
//
// THE WORDS, since 2026-09-11, are eBay's too (channel-copy.ts). The variant
// used to supply its own AI prose here, and that prose froze the item's facts
// in sentence form: a set corrected from gray to navy stayed "gray" on every
// channel. renderPlatformDescription still accepts prose, for the tests and for
// any caller that wants it; the listing-level wrapper at the bottom passes none,
// and a seller's per-channel override bypasses the blocks entirely.
//
// PLAIN TEXT, ALWAYS. None of these marketplaces render HTML in a description;
// they print the tags. So the block render is flattened with htmlToPlainText
// and the facts block (an eBay-shaped HTML table restating the measurements
// and the grade) is dropped rather than flattened into a wall of duplicated
// lines.
//
// NOTHING HERE DOES I/O except renderPlatformDescriptionsForListing and
// channelCopyForDraft, the impure wrappers at the bottom. The rest is pure and
// unit-tested.

import {
  type DescriptionBlock,
  type DescriptionBlockKey,
  type RenderContext,
  renderDescription,
} from "./description-blocks.ts";
import { htmlToPlainText } from "./cert-description.ts";
import {
  blocksForListing,
  buildRenderContext,
  loadOwnedListing,
} from "./description-render.ts";
import { supabaseAdmin } from "./supabase.ts";
import type { LengthUnit } from "./measurements.ts";
import { readChannelOverrides, resolveChannelTitle } from "./channel-copy.ts";
import { getMarketplaceSpec } from "./marketplace-specs.ts";

/**
 * Blocks that never cross to an extension marketplace.
 *
 * `facts` is the eBay item-specifics table. Flattened to plain text it is the
 * measurements and the grade a second time, in a shape nobody reads.
 */
const EXCLUDED_BLOCKS = new Set<DescriptionBlockKey>(["facts"]);

/** The block the platform's own prose is rendered as. */
const PROSE_BLOCK: DescriptionBlockKey = "intro";

/**
 * The blocks whose stored text the platform prose REPLACES.
 *
 * The AI writes one rewritten body per platform, not three sections, so its
 * words go in `intro` and the other two prose blocks switch off. Leaving them
 * on would print the eBay wording underneath the Poshmark wording.
 */
const SUPERSEDED_PROSE = new Set<DescriptionBlockKey>(["features", "condition"]);

// ─── Legacy scrubbing ──────────────────────────────────────────────

/**
 * The plain-text sections generatePlatformVariants used to append INTO the
 * stored description (its steps 6b/6c before this change).
 *
 * Every variant generated before this shipped still carries them. Rendering
 * the derived blocks on top without removing these first would print the
 * measurements twice — once stale, once current — which is worse than the bug
 * this module exists to fix.
 */
const MEASUREMENTS_HEADING = /^Measurements \(garment laid flat\):?$/;
const CREDENTIAL_HEADING = /^GradeThread Verified Seller$/;
const CREDENTIAL_LAST_LINE = /^Verify grades at GradeThread\b/;

/**
 * Remove the appended derived sections from a stored platform prose string.
 *
 * Line-based rather than a regex over the whole string: the measurements
 * section ends at the first blank line, and a seller's own paragraph that
 * happens to mention a measurement must survive untouched.
 */
export function stripDerivedSections(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (MEASUREMENTS_HEADING.test(line)) {
      // The heading plus the contiguous run under it. A blank line ends it.
      i++;
      while (i < lines.length && (lines[i] ?? "").trim() !== "") i++;
      continue;
    }
    if (CREDENTIAL_HEADING.test(line)) {
      // The block is four lines at most and always ends on the verify line, so
      // stop on that rather than on a blank — the stats line above it is
      // sometimes absent and the name line never is.
      i++;
      while (i < lines.length) {
        const l = (lines[i] ?? "").trim();
        i++;
        if (CREDENTIAL_LAST_LINE.test(l)) break;
        if (l === "") break;
      }
      i--;
      continue;
    }
    out.push(lines[i] ?? "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ─── Pure render ───────────────────────────────────────────────────

/**
 * The eBay block array, re-pointed at one platform's prose.
 *
 * Blocks come back BY REFERENCE wherever nothing changed, so the seller's
 * block order, their switched-off sections and their snippet overrides all
 * carry across to every channel — which is the whole point: they arrange the
 * description once.
 */
export function platformDescriptionBlocks(
  blocks: DescriptionBlock[],
  prose: string | null | undefined,
): DescriptionBlock[] {
  const words = (prose ?? "").trim();
  const kept = blocks.filter((b) => !EXCLUDED_BLOCKS.has(b.key));
  if (!words) return kept;

  let placed = false;
  const out = kept.map((b) => {
    if (b.key === PROSE_BLOCK && !placed) {
      placed = true;
      return { ...b, on: true, text: words };
    }
    if (SUPERSEDED_PROSE.has(b.key)) return { ...b, on: false };
    return b;
  });
  // A listing whose intro block was deleted still has to show the prose. Put it
  // at the top rather than dropping the platform's own words on the floor.
  if (!placed) {
    out.unshift({ key: PROSE_BLOCK, on: true, src: "ai", text: words });
  }
  return out;
}

/**
 * Cut to `max` characters on a boundary a reader would have chosen.
 *
 * Paragraph, then line, then word, then a hard cut. Never adds an ellipsis: an
 * ellipsis in a marketplace description reads as a truncated listing, and the
 * seller cannot tell whether the missing part was prose or a measurement.
 */
export function capDescription(text: string, max: number | null | undefined): string {
  if (max == null || max <= 0 || text.length <= max) return text;
  const head = text.slice(0, max);
  for (const boundary of ["\n\n", "\n", " "]) {
    const at = head.lastIndexOf(boundary);
    // Only accept a boundary that keeps most of the allowance — cutting a
    // 1000-char description at char 40 because that is where the last newline
    // fell would be worse than a hard cut.
    if (at > max * 0.6) return head.slice(0, at).trimEnd();
  }
  return head.trimEnd();
}

export interface PlatformDescriptionOptions {
  /** The platform's own words (platform_fields[platform].description). */
  prose?: string | null;
  /** MarketplaceSpec.descriptionMaxLength. Null means unbounded. */
  maxLength?: number | null;
}

/**
 * Render one platform's description: its prose, the CURRENT derived facts,
 * flattened to plain text and capped.
 */
export function renderPlatformDescription(
  blocks: DescriptionBlock[],
  ctx: RenderContext,
  opts: PlatformDescriptionOptions = {},
): string {
  const prose = stripDerivedSections(opts.prose ?? "");
  const next = platformDescriptionBlocks(blocks, prose);
  const plain = htmlToPlainText(renderDescription(next, ctx));
  return capDescription(plain, opts.maxLength ?? null);
}

// ─── The impure wrapper ────────────────────────────────────────────

/** What one platform needs from a render. */
export interface PlatformDescriptionRequest {
  platform: string;
  /** MarketplaceSpec.descriptionMaxLength. */
  maxLength: number | null;
}

/**
 * Render every requested platform's description for one listing.
 *
 * Tenant scope (US-268): the listing is reached only through
 * `loadOwnedListing`, whose join filters on the owner, and `platform_fields`
 * is read back from that same verified row id. A listing id belonging to
 * another workspace returns an empty map — the same answer as an id that does
 * not exist, so the response cannot be used to probe for another tenant's rows.
 *
 * Returns {} rather than throwing when the listing is missing: every caller has
 * a stored description to fall back on, and a cross-post that fails because a
 * description could not be re-rendered is a worse outcome than one that goes
 * out with yesterday's wording.
 */
export async function renderPlatformDescriptionsForListing(
  listingId: string,
  ownerId: string,
  requests: PlatformDescriptionRequest[],
  unit: LengthUnit = "in",
): Promise<Record<string, string>> {
  if (requests.length === 0) return {};

  const listing = await loadOwnedListing(listingId, ownerId);
  if (!listing) return {};

  // platform_fields is not on OwnedListing (it is not part of the description
  // contract). Read it off the row whose ownership is already proved.
  const { data: pfRow } = await supabaseAdmin
    .from("listings")
    .select("platform_fields")
    .eq("id", listing.id)
    .maybeSingle();
  const stored = ((pfRow as { platform_fields: Record<string, unknown> | null } | null)
    ?.platform_fields ?? {}) as Record<string, unknown>;

  const ctx = await buildRenderContext(listing, ownerId, unit);
  const blocks = blocksForListing(listing, ctx);

  const out: Record<string, string> = {};
  for (const req of requests) {
    out[req.platform] = channelDescription(blocks, ctx, stored[req.platform], req.maxLength);
  }
  return out;
}

/**
 * One channel's description, given its `platform_fields[platform]` entry.
 *
 * 2026-09-11 (channel-copy.ts): every channel copies eBay. The entry's AI
 * `description` is NOT passed as prose, because it is a snapshot of the eBay
 * wording from whenever the kit last ran, and it went stale the first time a
 * seller corrected a colour. With no prose, platformDescriptionBlocks keeps
 * eBay's own intro, features and condition.
 *
 * A seller's override for this channel is sent EXACTLY as typed, not run
 * through the blocks. It is the text they saw in the field when they typed it,
 * and appending derived sections underneath would print measurements they may
 * already have written into it.
 */
export function channelDescription(
  blocks: DescriptionBlock[],
  ctx: RenderContext,
  entry: unknown,
  maxLength: number | null | undefined,
): string {
  const override = readChannelOverrides(entry).description;
  if (override != null) return capDescription(override.trim(), maxLength);
  return renderPlatformDescription(blocks, ctx, { prose: null, maxLength });
}

/** The words each channel gets, as a client that cannot run the rule sees them. */
export interface ChannelCopy {
  titles: Record<string, string>;
  descriptions: Record<string, string>;
}

/**
 * Title and description for every requested channel of one eBay draft.
 *
 * For a client that renders the kit from a server response (the iOS and
 * Android Listing Kits read POST /autolister/platform-fields) and so cannot
 * apply channel-copy.ts itself. Tenant scope is the same as the render above:
 * the listing is reached through `loadOwnedListing`, and a listing this owner
 * does not hold yields two empty maps, which the caller reads as "keep what
 * you had".
 */
export async function channelCopyForDraft(
  listingId: string,
  ownerId: string,
  platforms: readonly string[],
): Promise<ChannelCopy> {
  const empty: ChannelCopy = { titles: {}, descriptions: {} };
  if (platforms.length === 0) return empty;
  const listing = await loadOwnedListing(listingId, ownerId);
  if (!listing) return empty;

  const { data } = await supabaseAdmin
    .from("listings")
    .select("listing_title, platform_fields")
    .eq("id", listing.id)
    .maybeSingle();
  const row = (data ?? null) as {
    listing_title: string | null;
    platform_fields: Record<string, unknown> | null;
  } | null;
  const stored = row?.platform_fields ?? {};

  const titles: Record<string, string> = {};
  for (const platform of platforms) {
    titles[platform] = resolveChannelTitle(platform, {
      override: readChannelOverrides(stored[platform]).title,
      sharedTitle: row?.listing_title ?? null,
    });
  }
  const descriptions = await renderPlatformDescriptionsForListing(
    listing.id,
    ownerId,
    platforms.map((platform) => ({
      platform,
      maxLength: getMarketplaceSpec(platform)?.descriptionMaxLength ?? null,
    })),
  );
  return { titles, descriptions };
}
