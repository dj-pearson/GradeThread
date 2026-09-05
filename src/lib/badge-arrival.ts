// US-3060 AC7: a certificate opened from an on-marketplace extension badge.
//
// The badge link carries `utm_medium=badge` and `utm_campaign=<platform>`,
// built by the extension's attribution.js. This turns those two parameters into
// the one fact the certificate page acts on, and refuses to invent the rest.
//
// ⚠ THE PLATFORM IS IN utm_campaign, NOT utm_source, AND THIS FILE SAID
// OTHERWISE FIRST. attribution.js sets `utm_source = "extension"` on EVERY link
// the extension puts on the site — that is how extension traffic is told apart
// from every other channel. Overwriting it with the marketplace name would have
// made this one link type invisible as extension traffic to answer a question
// utm_campaign already answers. Read the layer below before choosing a
// parameter: the convention was there.
//
// WHY THE PLATFORM IS ALLOWLISTED RATHER THAN ECHOED. `utm_campaign` is
// whatever the URL says, and this value reaches an analytics property and a
// rendered sentence. Echoing it would put an attacker-controlled string into
// both from a link anyone can construct — a cheap way to make our own certificate page
// display arbitrary text. The three platforms the badge can appear on are known
// (BADGE_PLATFORMS on the edge), so an unknown source is a badge arrival with
// no platform rather than a platform we made up.

/** Where a badge can legitimately have been shown. Mirrors the edge's list. */
export const BADGE_ARRIVAL_PLATFORMS = ["ebay", "poshmark", "mercari"] as const;
export type BadgeArrivalPlatform = (typeof BADGE_ARRIVAL_PLATFORMS)[number];

export const BADGE_UTM_MEDIUM = "badge";

export interface BadgeArrival {
  /** Null when the link said `badge` but named no platform we recognise. */
  platform: BadgeArrivalPlatform | null;
}

/** Human label for the rendered note. */
export const BADGE_PLATFORM_LABELS: Record<BadgeArrivalPlatform, string> = {
  ebay: "eBay",
  poshmark: "Poshmark",
  mercari: "Mercari",
};

function readParam(params: URLSearchParams, key: string): string {
  return (params.get(key) ?? "").trim().toLowerCase();
}

/**
 * Was this certificate opened from a badge, and on which marketplace?
 *
 * Returns null for every ordinary visit, so the caller's check is a single
 * truthiness test and the note cannot render on a direct arrival.
 */
export function badgeArrival(params: URLSearchParams): BadgeArrival | null {
  if (readParam(params, "utm_medium") !== BADGE_UTM_MEDIUM) return null;
  const campaign = readParam(params, "utm_campaign");
  const platform = (BADGE_ARRIVAL_PLATFORMS as readonly string[]).includes(campaign)
    ? (campaign as BadgeArrivalPlatform)
    : null;
  return { platform };
}

/**
 * The one line the page renders, or null when there is nothing honest to say.
 *
 * A badge arrival with an unrecognised source gets NO note rather than a vague
 * one: "seen via the extension" without naming where is a sentence that adds
 * nothing and still has to be read.
 */
export function badgeArrivalNote(arrival: BadgeArrival | null): string | null {
  if (!arrival?.platform) return null;
  return `Seen via the GradeThread extension on ${BADGE_PLATFORM_LABELS[arrival.platform]}.`;
}
