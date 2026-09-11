// The title a marketplace gets, on the SPA side of the boundary.
//
// MIRRORED, token for token below this header, from
// services/edge-functions/src/lib/channel-copy.ts. The edge and the SPA share
// no module graph, so the rule exists twice; src/test/channel-copy-mirror.test.ts
// fails if the two drift.
//
// WHY THE SPA NEEDS IT. The Listing Kit shows each channel's title and hands
// it straight to the extension from the browser. The queued path builds the
// same payload on the edge. If the two applied different rules, the same item
// would go to Poshmark with one title from the desk and another from a phone.
//
// The rule itself (2026-09-11): every marketplace copies eBay. The seller's
// own words for one channel, when they have typed some, beat it.

import { getMarketplaceSpec } from "@/lib/marketplace-specs";

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
