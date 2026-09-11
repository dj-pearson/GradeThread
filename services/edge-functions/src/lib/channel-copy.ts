// The title and description words a marketplace gets, decided in one place.
//
// THE BUG THIS CLOSES (2026-09-11). Every cross-post channel carried its own
// AI rewrite of the title and description, frozen into
// `listings.platform_fields[platform]` the moment the kit was generated. An
// item drafted as "Gray" and corrected to "Navy Blue" in the eBay editor went
// on saying "Gray" on Poshmark, Mercari, Depop, Grailed and Vinted, and the
// seller had to retype the fix into every tab. The facts under the description
// were already live (platform-description.ts); the WORDS were not.
//
// THE RULE, chosen by the owner that day: every marketplace copies eBay. The
// title is the eBay title fitted to the channel's limit, and the description is
// the eBay description rendered as plain text. A seller who types different
// words for one channel gets a per-channel override, and that override is sent
// exactly as typed until they press "Use eBay copy". The AI per-channel rewrite
// is no longer read for either field.
//
// PURE. This module imports only marketplace-specs.ts, which has no imports of
// its own, so extension-queue.ts can use it without pulling a Supabase client
// into its tests. The SPA carries a copy of the region below
// (src/lib/channel-copy.ts), pinned token for token by
// src/test/channel-copy-mirror.test.ts.

import { getMarketplaceSpec } from "./marketplace-specs.ts";

/** Where a seller's per-channel wording lives inside `platform_fields[platform]`. */
export const CHANNEL_COPY_KEYS = {
  title: "title_override",
  description: "description_override",
} as const;

/** A seller's per-channel wording. Null means "copy eBay". */
export interface ChannelOverrides {
  title: string | null;
  description: string | null;
}

/**
 * Read the overrides off one channel's `platform_fields` entry.
 *
 * Anything that is not a non-blank string reads as "no override", so a blob
 * written by an older build, or a key cleared to "", falls back to eBay.
 */
export function readChannelOverrides(blob: unknown): ChannelOverrides {
  const b = blob && typeof blob === "object" && !Array.isArray(blob)
    ? blob as Record<string, unknown>
    : {};
  const pick = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v : null;
  return {
    title: pick(b[CHANNEL_COPY_KEYS.title]),
    description: pick(b[CHANNEL_COPY_KEYS.description]),
  };
}

/** Depop has no title field: its spec says so with a null titleMaxLength. */
export function channelHasTitle(platform: string): boolean {
  const spec = getMarketplaceSpec(platform);
  return !(spec && spec.titleMaxLength == null);
}

/**
 * Cut a title to `max` characters on a word boundary.
 *
 * eBay allows 80 and Grailed and Vinted allow 60, so an eBay title routinely
 * loses its last few words on the way across. A word cut in half reads as a
 * typo in a search result; a dropped trailing keyword does not.
 */
export function fitTitle(text: string, max: number | null | undefined): string {
  const t = (text ?? "").trim();
  if (max == null || t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * The title this marketplace gets.
 *
 * The seller's override for this channel, else the eBay title, else the item's
 * own title, fitted to the channel's limit. "" for a channel with no title
 * field. The AI variant's title is deliberately not a candidate: it is a
 * snapshot of the eBay title from whenever the kit last ran.
 */
export function resolveChannelTitle(
  platform: string,
  input: {
    override?: string | null;
    sharedTitle?: string | null;
    itemTitle?: string | null;
  },
): string {
  if (!channelHasTitle(platform)) return "";
  const source = [input.override, input.sharedTitle, input.itemTitle].find(
    (t): t is string => typeof t === "string" && t.trim() !== "",
  ) ?? "";
  return fitTitle(source, getMarketplaceSpec(platform)?.titleMaxLength ?? null);
}
